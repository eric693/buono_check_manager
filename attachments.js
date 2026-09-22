// attachments.js
//
// 申請單附件：請假的診斷證明、加班的佐證、補打卡的說明照片。
//
// 附件是掛在「記錄鍵」上的，不是掛在試算表列號上 —— 列號會因為刪除其他列而位移，
// 掛上去遲早會對到別人的申請。記錄鍵由申請單本身的欄位組出來，申請人與審核者
// 兩邊算出來的值一定相同。

const ATTACHMENT_MAX_MB = 3;

// 清單畫面會先用一次 listAttachmentsBatch 把整頁的附件撈回來放這裡，
// 之後每一筆記錄直接從快取畫，不必各自再打一次 API。
let _attachmentCache = null;
const ATTACHMENT_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,application/pdf';

/**
 * 組出穩定的記錄鍵。
 *
 * 同一筆申請不論從「我的記錄」還是「待審核」看，算出來都要一樣，
 * 所以只用申請單本身不會變的欄位。
 */
function buildAttachmentKey(type, record) {
    const employeeId = record.employeeId || record.userId || '';

    if (type === 'leave') {
        return `leave:${employeeId}:${record.startDateTime || record.startDate || ''}`;
    }
    if (type === 'overtime') {
        return `overtime:${employeeId}:${record.overtimeDate || record.date || ''}:${record.startTime || ''}`;
    }
    if (type === 'adjustPunch') {
        return `adjustPunch:${employeeId}:${record.date || ''}:${record.type || ''}`;
    }
    if (type === 'worklog') {
        return `worklog:${record.id || ''}`;
    }

    return `${type}:${employeeId}`;
}

/**
 * 讀成 base64（去掉 data:...;base64, 前綴，後端只要純內容）
 */
function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma === -1 ? result : result.slice(comma + 1));
        };
        reader.onerror = () => reject(reader.error || new Error('讀取檔案失敗'));
        reader.readAsDataURL(file);
    });
}

function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 清單渲染前先把整頁的附件一次抓回來。
 *
 * 沒有這一步的話，每一筆記錄都會各自呼叫 listAttachments —— 20 筆請假就是
 * 20 次 Apps Script 呼叫，而 Apps Script 對同一個使用者是排隊處理的。
 *
 * @param {string} type
 * @param {Array<string>} recordKeys
 */
async function prefetchAttachments(type, recordKeys) {
    const keys = [...new Set((recordKeys || []).filter(Boolean))];
    if (keys.length === 0) {
        _attachmentCache = { type: type, data: {} };
        return;
    }

    try {
        const res = await callApifetch(
            `listAttachmentsBatch&type=${encodeURIComponent(type)}` +
            `&recordKeys=${encodeURIComponent(JSON.stringify(keys))}`, null);

        _attachmentCache = {
            type: type,
            data: (res.ok && res.attachments) ? res.attachments : {}
        };
    } catch (error) {
        // 抓不到就退回逐筆查詢，不要讓整頁的附件都消失
        console.warn('批次載入附件失敗，改為逐筆查詢:', error);
        _attachmentCache = null;
    }
}

/**
 * 在容器裡畫出附件區塊：清單 + 上傳按鈕。
 *
 * @param {HTMLElement} container
 * @param {string} type      leave / overtime / adjustPunch / worklog
 * @param {string} recordKey buildAttachmentKey() 的結果
 * @param {Object} [options]
 * @param {boolean} [options.canUpload] 是否顯示上傳按鈕（審核者看別人的申請時不需要）
 */
async function renderAttachments(container, type, recordKey, options = {}) {
    if (!container) return;

    const canUpload = options.canUpload !== false;

    container.innerHTML = '';
    container.classList.add('attachment-box');

    const list = document.createElement('div');
    list.className = 'attachment-list';
    container.appendChild(list);

    if (canUpload) {
        container.appendChild(buildAttachmentUploader(type, recordKey, () =>
            refreshAttachmentList(list, type, recordKey, canUpload)));
    }

    await refreshAttachmentList(list, type, recordKey, canUpload);
}

function buildAttachmentUploader(type, recordKey, onDone) {
    const wrapper = document.createElement('div');
    wrapper.className = 'attachment-upload';

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ATTACHMENT_ACCEPT;
    input.style.display = 'none';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'attachment-btn';
    button.textContent = t('BTN_ADD_ATTACHMENT');

    button.addEventListener('click', () => input.click());

    input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;

        // 先在前端擋掉過大的檔案，不然白白傳了幾 MB 才被後端退回
        if (file.size > ATTACHMENT_MAX_MB * 1024 * 1024) {
            showNotification(t('ATTACHMENT_TOO_LARGE', { max: ATTACHMENT_MAX_MB }), 'error');
            input.value = '';
            return;
        }

        button.disabled = true;
        button.textContent = t('ATTACHMENT_UPLOADING');

        try {
            const data = await readFileAsBase64(file);
            const query =
                `type=${encodeURIComponent(type)}` +
                `&recordKey=${encodeURIComponent(recordKey)}` +
                `&filename=${encodeURIComponent(file.name)}` +
                `&mimeType=${encodeURIComponent(file.type)}` +
                `&data=${encodeURIComponent(data)}`;

            const res = await callApifetch(`uploadAttachment&${query}`, null);

            if (res.ok) {
                showNotification(t('ATTACHMENT_UPLOADED'), 'success');
                _attachmentCache = null;  // 剛上傳的不在批次快取裡
                if (onDone) await onDone();
            } else {
                showNotification(res.msg || t('ATTACHMENT_UPLOAD_FAILED'), 'error');
            }
        } catch (error) {
            console.error('上傳附件失敗:', error);
            showNotification(t('ATTACHMENT_UPLOAD_FAILED'), 'error');
        } finally {
            button.disabled = false;
            button.textContent = t('BTN_ADD_ATTACHMENT');
            input.value = '';
        }
    });

    wrapper.appendChild(input);
    wrapper.appendChild(button);
    return wrapper;
}

async function refreshAttachmentList(list, type, recordKey, canUpload) {
    if (!list) return;

    list.innerHTML = '';

    try {
        let attachments;

        // 有批次快取就直接用；上傳或刪除之後會清掉快取，改走即時查詢拿到最新結果
        if (_attachmentCache && _attachmentCache.type === type) {
            attachments = _attachmentCache.data[recordKey] || [];
        } else {
            const res = await callApifetch(
                `listAttachments&type=${encodeURIComponent(type)}&recordKey=${encodeURIComponent(recordKey)}`,
                null);
            attachments = (res.ok && res.attachments) || [];
        }

        if (attachments.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'attachment-empty';
            empty.textContent = t('ATTACHMENT_NONE');
            list.appendChild(empty);
            return;
        }

        attachments.forEach(a => list.appendChild(buildAttachmentItem(a, canUpload, () =>
            refreshAttachmentList(list, type, recordKey, canUpload))));

    } catch (error) {
        console.error('載入附件清單失敗:', error);
    }
}

function buildAttachmentItem(attachment, canDelete, onDone) {
    const item = document.createElement('span');
    item.className = 'attachment-item';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'attachment-link';
    open.textContent = `${attachment.filename}（${formatFileSize(attachment.size)}）`;
    open.addEventListener('click', () => openAttachment(attachment.attachmentId));
    item.appendChild(open);

    if (canDelete) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'attachment-remove';
        remove.title = t('BTN_DELETE');
        remove.textContent = '×';
        remove.addEventListener('click', async () => {
            if (!confirm(t('ATTACHMENT_DELETE_CONFIRM'))) return;
            try {
                const res = await callApifetch(
                    `deleteAttachment&attachmentId=${encodeURIComponent(attachment.attachmentId)}`, null);
                if (res.ok) {
                    showNotification(t('ATTACHMENT_DELETED'), 'success');
                    _attachmentCache = null;  // 快取裡還有剛刪掉的那筆
                    if (onDone) await onDone();
                } else {
                    showNotification(res.msg || t('ATTACHMENT_DELETE_FAILED'), 'error');
                }
            } catch (error) {
                console.error('刪除附件失敗:', error);
                showNotification(t('ATTACHMENT_DELETE_FAILED'), 'error');
            }
        });
        item.appendChild(remove);
    }

    return item;
}

/**
 * 開啟附件。
 *
 * 檔案在雲端硬碟裡沒有公開連結（診斷證明不該拿到網址就看得到），
 * 所以是把內容抓回來組成 blob 再開新分頁。
 */
async function openAttachment(attachmentId) {
    try {
        const res = await callApifetch(
            `getAttachment&attachmentId=${encodeURIComponent(attachmentId)}`, null);

        if (!res.ok || !res.data) {
            showNotification(res.msg || t('ATTACHMENT_OPEN_FAILED'), 'error');
            return;
        }

        const binary = atob(res.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        const url = URL.createObjectURL(new Blob([bytes], { type: res.mimeType }));
        const opened = window.open(url, '_blank');

        if (!opened) {
            showNotification(t('ATTACHMENT_POPUP_BLOCKED'), 'error');
        }

        // 給瀏覽器一點時間載入再釋放
        setTimeout(() => URL.revokeObjectURL(url), 60000);

    } catch (error) {
        console.error('開啟附件失敗:', error);
        showNotification(t('ATTACHMENT_OPEN_FAILED'), 'error');
    }
}
