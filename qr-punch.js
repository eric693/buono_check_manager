// qr-punch.js
//
// LINE Bot 網頁打卡與 QR Code 打卡。兩者都是用一次性 token 換打卡資格。
//
// 從 script.js 拆出來的：那支原本 4,000 多行，每個頁面都要整份載入。
// 這裡的函式仍然是全域的，載入順序沒有相依性。

async function handleLinePunchFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('linePunchToken');
    if (!token) return;

    history.replaceState({}, '', window.location.pathname);

    // 全螢幕 overlay
    const overlay = document.createElement('div');
    overlay.id = 'line-punch-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:32px 24px;max-width:320px;width:90%;text-align:center;">
        <div id="lpo-icon" style="font-size:48px;margin-bottom:12px;">📍</div>
        <div id="lpo-title" style="font-size:20px;font-weight:bold;margin-bottom:8px;">正在取得位置...</div>
        <div id="lpo-sub" style="font-size:14px;color:#666;margin-bottom:16px;">請允許瀏覽器存取您的 GPS 位置</div>
        <button id="lpo-close" style="display:none;margin-top:8px;padding:10px 28px;border-radius:8px;border:none;background:#4CAF50;color:#fff;font-size:16px;cursor:pointer;">關閉</button>
      </div>`;
    document.body.appendChild(overlay);

    const setResult = (icon, title, sub, btnColor) => {
        overlay.querySelector('#lpo-icon').textContent = icon;
        overlay.querySelector('#lpo-title').textContent = title;
        overlay.querySelector('#lpo-sub').textContent = sub;
        const btn = overlay.querySelector('#lpo-close');
        btn.style.display = 'inline-block';
        btn.style.background = btnColor || '#4CAF50';
        btn.onclick = () => overlay.remove();
    };

    try {
        const position = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                timeout: 15000,
                enableHighAccuracy: true
            });
        });

        overlay.querySelector('#lpo-title').textContent = '正在打卡...';
        overlay.querySelector('#lpo-sub').textContent = '';

        const params = new URLSearchParams({
            token: token,
            lat: position.coords.latitude,
            lng: position.coords.longitude
        });

        const res = await callApifetch(`linePunch&${params.toString()}`);

        if (res.ok) {
            const typeText = res.punchType === '上班' ? '🟢 上班打卡' : '🟠 下班打卡';
            const detailText = `${res.location ? res.location + '｜' : ''}${res.time || ''}`;
            setResult('✅', typeText + ' 成功！', detailText, '#4CAF50');

            // 3 秒倒數後自動關閉，並嘗試返回上一頁
            const card = overlay.querySelector('div');
            const countdownEl = document.createElement('div');
            countdownEl.style.cssText = 'font-size:12px;color:#aaa;margin-top:10px;';
            card.appendChild(countdownEl);
            let secs = 3;
            countdownEl.textContent = `${secs} 秒後自動關閉`;
            const autoCloseTimer = setInterval(() => {
                secs--;
                if (secs <= 0) {
                    clearInterval(autoCloseTimer);
                    overlay.remove();
                    try { window.history.back(); } catch(e) {}
                } else {
                    countdownEl.textContent = `${secs} 秒後自動關閉`;
                }
            }, 1000);
            overlay.querySelector('#lpo-close').onclick = () => {
                clearInterval(autoCloseTimer);
                overlay.remove();
                try { window.history.back(); } catch(e) {}
            };

            await loadAbnormalRecordsInBackground();
        } else {
            const msgMap = {
                ERR_LPT_INVALID:  '連結無效或已使用，請重新在 LINE 輸入打卡指令',
                ERR_LPT_EXPIRED:  '連結已過期（5 分鐘），請重新在 LINE 輸入打卡指令',
                ERR_NOT_IN_RANGE: res.msg || '不在打卡範圍內',
                ERR_DUPLICATE_PUNCH: '您剛剛已打過卡了'
            };
            setResult('❌', '打卡失敗', msgMap[res.code] || res.msg || '請稍後再試', '#f44336');
        }
    } catch (err) {
        const geoErrors = { 1: '請允許位置存取權限後重試', 3: 'GPS 逾時，請確認定位已開啟' };
        setResult('❌', '無法取得位置', geoErrors[err.code] || '請確認 GPS 已開啟', '#f44336');
    }
}

/**
 * 處理登入後待執行的 QR 打卡
 */
async function handlePendingQRPunch() {
    const pendingToken = sessionStorage.getItem('pendingQRToken');
    if (!pendingToken) return;
    sessionStorage.removeItem('pendingQRToken');
    await performQRPunch(pendingToken);
}

/**
 * 員工 QR 打卡（由掃描後的 URL 觸發）
 */
async function performQRPunch(qrTokenId) {
    showNotification(t('NOTIF_QR_PROCESSING'), 'info');
    try {
        const token = localStorage.getItem('sessionToken');
        if (!token) {
            showNotification(t('NOTIF_LOGIN_REQUIRED_QR'), 'error');
            return;
        }
        const qrLoc = sessionStorage.getItem('pendingQRLoc') || '';
        sessionStorage.removeItem('pendingQRLoc');
        const urlParams = new URLSearchParams({ qrToken: qrTokenId });
        if (qrLoc) urlParams.append('loc', qrLoc);
        const res = await callApifetch(`qrPunch&${urlParams.toString()}`);
        if (res.ok) {
            const type = (res.params && res.params.type) || '';
            const loc  = (res.params && res.params.location) || '';
            showNotification(t('NOTIF_QR_PUNCH_OK', { detail: `${type || ''}${loc ? ' - ' + loc : ''}`.trim() }), 'success');
            // 重新載入異常記錄
            await loadAbnormalRecordsInBackground();
        } else {
            const msgMap = {
                'ERR_QR_EXPIRED':       'QR Code 已過期，請聯絡管理員重新產生',
                'ERR_QR_INVALID':       'QR Code 無效或已失效',
                'ERR_DUPLICATE_PUNCH':  res.msg || '今天已打過此類型的卡',
                'ERR_SESSION_INVALID':  '請先登入再掃描 QR Code'
            };
            showNotification(msgMap[res.code] || res.msg || 'QR 打卡失敗', 'error');
        }
    } catch (err) {
        console.error('QR 打卡錯誤:', err);
        showNotification(t('NOTIF_QR_PUNCH_FAILED'), 'error');
    }
}

/**
 * 管理員：產生 QR Code
 *
 * 代碼由後端簽章（見 GS/QrPunch.gs）。以前是前端自己組，員工可以自己拼一個
 * 到期時間很久以後的代碼在家打卡。
 */
async function generateAdminQRCode() {
    const punchTypeEl = document.querySelector('input[name="qr-punch-type"]:checked');
    const punchType   = punchTypeEl ? punchTypeEl.value : '上班';

    const validSelect = document.getElementById('qr-valid-minutes');
    let validMinutes;
    if (validSelect.value === 'custom') {
        validMinutes = parseInt(document.getElementById('qr-valid-minutes-custom').value);
        if (!validMinutes || validMinutes < 1 || validMinutes > 1440) {
            showNotification(t('NOTIF_MINUTES_RANGE'), 'error');
            return;
        }
    } else {
        validMinutes = parseInt(validSelect.value);
    }

    const locationName = (document.getElementById('qr-location-name').value || '').trim();

    const btn = document.getElementById('generate-qr-btn');
    btn.disabled    = true;
    btn.textContent = '產生中...';

    try {
        const res = await callApifetch(
            `createQrToken&punchType=${encodeURIComponent(punchType)}` +
            `&minutes=${validMinutes}&loc=${encodeURIComponent(locationName)}`, null);
        if (!res.ok) {
            showNotification(res.msg || t('NOTIF_QR_GENERATE_FAILED'), 'error');
            return;
        }
        const expiryMs  = res.expiresAt;
        const tokenId   = res.token;

        // 組成員工掃描後開啟的 URL
        const redirectUrl = API_CONFIG.redirectUrl.replace(/\/$/, '');
        const signedLoc   = res.loc || '';  // 後端簽章用的地點名稱，網址要跟它一字不差
        const locParam    = signedLoc ? `&loc=${encodeURIComponent(signedLoc)}` : '';
        const punchUrl    = `${redirectUrl}/?qrToken=${tokenId}${locParam}`;

        // 使用 qrcodejs 在瀏覽器端直接產生 QR Code（同步，不需要 Promise）
        const qrContainer = document.getElementById('qr-image');
        qrContainer.innerHTML = '';  // 清除上一次的 QR Code
        new QRCode(qrContainer, {
            text: punchUrl,
            width: 250,
            height: 250,
            colorDark: '#1e1b4b',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });

        // 標籤顯示
        const typeBadge = document.getElementById('qr-type-badge');
        typeBadge.textContent = punchType === '上班' ? '上班打卡' : '下班打卡';
        typeBadge.className   = punchType === '上班'
            ? 'inline-block px-3 py-1 rounded-full text-sm font-bold mb-3 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
            : 'inline-block px-3 py-1 rounded-full text-sm font-bold mb-3 bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300';

        const locBadge = document.getElementById('qr-location-badge');
        if (locationName) {
            locBadge.textContent = locationName;
            locBadge.style.display = 'inline-block';
        } else {
            locBadge.style.display = 'none';
        }

        document.getElementById('qr-display-area').style.display       = 'block';
        document.getElementById('qr-expired-msg').style.display         = 'none';
        document.getElementById('qr-regenerate-btn').style.display      = 'none';
        document.getElementById('qr-image').style.opacity               = '1';
        document.getElementById('qr-countdown-container').style.display = 'block';

        // 啟動倒數計時
        _qrExpiryTime = expiryMs;
        _qrTotalMs    = validMinutes * 60 * 1000;
        if (_qrCountdownInterval) clearInterval(_qrCountdownInterval);
        _tickQRCountdown();
        _qrCountdownInterval = setInterval(_tickQRCountdown, 1000);

        showNotification(t('NOTIF_QR_GENERATED', { minutes: validMinutes }), 'success');

    } catch (err) {
        console.error('generateAdminQRCode 錯誤:', err);
        showNotification(t('NOTIF_QR_GENERATE_FAILED'), 'error');
    } finally {
        btn.disabled    = false;
        btn.textContent = '產生 QR Code';
    }
}

/**
 * QR Code 倒數計時一次 tick
 */
function _tickQRCountdown() {
    if (!_qrExpiryTime) return;
    const remaining = _qrExpiryTime - Date.now();

    if (remaining <= 0) {
        clearInterval(_qrCountdownInterval);
        _qrCountdownInterval = null;
        document.getElementById('qr-countdown').textContent = '00:00';
        document.getElementById('qr-progress-fill').style.width = '0%';
        document.getElementById('qr-image').style.opacity = '0.3';
        document.getElementById('qr-countdown-container').style.display = 'none';
        document.getElementById('qr-expired-msg').style.display    = 'block';
        document.getElementById('qr-regenerate-btn').style.display = 'block';
        return;
    }

    const totalSec   = Math.ceil(remaining / 1000);
    const mins       = Math.floor(totalSec / 60);
    const secs       = totalSec % 60;
    const countdownEl = document.getElementById('qr-countdown');
    if (countdownEl) {
        countdownEl.textContent = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
        // 顏色警示：剩餘 < 1 分鐘時變紅
        countdownEl.className = remaining < 60000
            ? 'text-4xl font-bold font-mono text-red-500 dark:text-red-400'
            : 'text-4xl font-bold font-mono text-indigo-600 dark:text-indigo-400';
    }

    const pct = _qrTotalMs > 0 ? (remaining / _qrTotalMs) * 100 : 0;
    const fillEl = document.getElementById('qr-progress-fill');
    if (fillEl) {
        fillEl.style.width = Math.max(0, pct) + '%';
        fillEl.className = remaining < 60000
            ? 'bg-red-500 h-2 rounded-full transition-all duration-1000'
            : 'bg-indigo-600 h-2 rounded-full transition-all duration-1000';
    }
}

// ==================== 平板打卡（管理員設定） ====================
//
// 平板用 kiosk.html 常駐顯示 QR Code。管理員在這裡產生平板專用的連結，
// 連結裡的金鑰只能拿來產生打卡 QR Code，平板上不必登入任何帳號。

let _kioskAdminBound = false;

function buildKioskUrl(kioskKey) {
    const base = API_CONFIG.redirectUrl.replace(/\/?$/, '/');
    // 金鑰放在 # 後面：不會送到伺服器，也不會出現在其他網站的 Referer 裡
    return `${base}kiosk.html#key=${encodeURIComponent(kioskKey)}`;
}

async function initKioskAdmin() {
    const section = document.getElementById('kiosk-admin-section');
    if (!section) return;

    if (!_kioskAdminBound) {
        _kioskAdminBound = true;
        document.getElementById('kiosk-create-btn')?.addEventListener('click', createKioskLink);
        document.getElementById('kiosk-disable-btn')?.addEventListener('click', disableKioskLink);
        document.getElementById('kiosk-copy-btn')?.addEventListener('click', async () => {
            const input = document.getElementById('kiosk-link-input');
            if (!input) return;
            try {
                await navigator.clipboard.writeText(input.value);
            } catch (error) {
                input.select();
                document.execCommand('copy');
            }
            showNotification(t('KIOSK_COPIED'), 'success');
        });
    }

    await refreshKioskStatus();
}

async function refreshKioskStatus() {
    const statusEl = document.getElementById('kiosk-status');
    const disableBtn = document.getElementById('kiosk-disable-btn');
    try {
        const res = await callApifetch('getKioskStatus', null);
        if (!res.ok) return;

        const locInput = document.getElementById('kiosk-location-name');
        if (locInput && !locInput.value) locInput.value = res.loc || '';

        if (statusEl) {
            statusEl.textContent = res.enabled
                ? t('KIOSK_STATUS_ENABLED', { loc: res.loc })
                : t('KIOSK_STATUS_DISABLED');
            statusEl.className = 'text-sm font-semibold mb-4 ' +
                (res.enabled ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-400');
        }
        if (disableBtn) disableBtn.style.display = res.enabled ? 'block' : 'none';
    } catch (error) {
        console.error('查詢平板打卡狀態失敗:', error);
    }
}

async function createKioskLink() {
    const button = document.getElementById('kiosk-create-btn');
    const loc = (document.getElementById('kiosk-location-name')?.value || '').trim();

    if (!confirm(t('KIOSK_CREATE_CONFIRM'))) return;

    generalButtonState(button, 'processing', t('LOADING'));
    try {
        const res = await callApifetch(`resetKioskKey&loc=${encodeURIComponent(loc)}`, null);
        if (!res.ok) {
            showNotification(res.msg || t('KIOSK_CREATE_FAILED'), 'error');
            return;
        }

        const url = buildKioskUrl(res.kioskKey);
        const area = document.getElementById('kiosk-link-area');
        const input = document.getElementById('kiosk-link-input');
        const qr = document.getElementById('kiosk-link-qr');
        if (input) input.value = url;
        if (qr && typeof QRCode !== 'undefined') {
            qr.innerHTML = '';
            new QRCode(qr, { text: url, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
        }
        if (area) area.style.display = 'block';

        showNotification(t('KIOSK_CREATED'), 'success');
        await refreshKioskStatus();
    } catch (error) {
        console.error('產生平板打卡連結失敗:', error);
        showNotification(t('KIOSK_CREATE_FAILED'), 'error');
    } finally {
        generalButtonState(button, 'idle');
    }
}

async function disableKioskLink() {
    if (!confirm(t('KIOSK_DISABLE_CONFIRM'))) return;

    try {
        const res = await callApifetch('disableKiosk', null);
        if (!res.ok) {
            showNotification(res.msg || t('KIOSK_DISABLE_FAILED'), 'error');
            return;
        }
        const area = document.getElementById('kiosk-link-area');
        if (area) area.style.display = 'none';
        showNotification(t('KIOSK_DISABLED'), 'success');
        await refreshKioskStatus();
    } catch (error) {
        console.error('停用平板打卡失敗:', error);
        showNotification(t('KIOSK_DISABLE_FAILED'), 'error');
    }
}
