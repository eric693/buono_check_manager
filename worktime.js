// worktime.js
//
// 全公司共用的工作時段設定。實際生效的值存在後端「系統設定」工作表，
// 管理員可以在管理員分頁直接調整（GS/SystemSettings.gs）。
//
// config.js 的 API_CONFIG.workSchedule 只是還沒跟後端要到設定之前的預設值；
// 這支腳本會把後端的值寫回 API_CONFIG.workSchedule，leave.js 算請假時數時
// 每次都是即時讀取，所以覆寫之後前端預覽就會跟後端實扣一致。

const WORK_SCHEDULE_STORAGE_KEY = 'workScheduleCache';
const WORK_SCHEDULE_FIELDS = ['start', 'end', 'lunchStart', 'lunchEnd'];

let _workScheduleLoaded = false;
let _workScheduleAdminBound = false;

/**
 * 檢查 HH:MM（24 小時制）
 */
function isValidTimeOfDay(hhmm) {
    return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(hhmm || '').trim());
}

/**
 * 取得目前生效的工作時段（永遠回傳完整的四個欄位）
 */
function getWorkSchedule() {
    const cfg = (typeof API_CONFIG !== 'undefined' && API_CONFIG.workSchedule) || {};
    return {
        start: cfg.start || '08:30',
        end: cfg.end || '17:30',
        lunchStart: cfg.lunchStart || '12:00',
        lunchEnd: cfg.lunchEnd || '13:00'
    };
}

/**
 * 驗證一組設定是否合法；不合法回傳錯誤訊息字串，合法回傳 null
 */
function validateWorkSchedule(schedule) {
    for (const field of WORK_SCHEDULE_FIELDS) {
        if (!isValidTimeOfDay(schedule[field])) {
            return t('WORK_SCHEDULE_ERR_FORMAT');
        }
    }

    const toMin = (hhmm) => {
        const [h, m] = String(hhmm).split(':').map(Number);
        return (h || 0) * 60 + (m || 0);
    };

    if (toMin(schedule.end) <= toMin(schedule.start)) {
        return t('WORK_SCHEDULE_ERR_END_BEFORE_START');
    }
    if (toMin(schedule.lunchEnd) < toMin(schedule.lunchStart)) {
        return t('WORK_SCHEDULE_ERR_LUNCH_ORDER');
    }
    if (toMin(schedule.lunchStart) < toMin(schedule.start) ||
        toMin(schedule.lunchEnd) > toMin(schedule.end)) {
        return t('WORK_SCHEDULE_ERR_LUNCH_RANGE');
    }

    return null;
}

/**
 * 套用一組工作時段：寫回 API_CONFIG、存本機快取、更新畫面上的說明與表單
 */
function applyWorkSchedule(schedule) {
    if (!schedule || typeof API_CONFIG === 'undefined') return;

    const clean = {};
    for (const field of WORK_SCHEDULE_FIELDS) {
        if (!isValidTimeOfDay(schedule[field])) {
            console.warn(' 工作時段設定不合法，維持原本的值:', schedule);
            return;
        }
        clean[field] = String(schedule[field]).trim();
    }

    API_CONFIG.workSchedule = clean;

    try {
        localStorage.setItem(WORK_SCHEDULE_STORAGE_KEY, JSON.stringify(clean));
    } catch (err) {
        // 無痕模式等情況存不了快取，不影響功能
        console.warn('工作時段快取寫入失敗:', err);
    }

    renderWorkScheduleNote();
    fillWorkScheduleForm();
}

/**
 * 頁面載入時先套用上次的設定，避免還沒跟後端要到值之前顯示舊的時段
 */
function restoreWorkScheduleFromCache() {
    try {
        const cached = localStorage.getItem(WORK_SCHEDULE_STORAGE_KEY);
        if (cached) applyWorkSchedule(JSON.parse(cached));
    } catch (err) {
        console.warn('工作時段快取讀取失敗:', err);
    }
}

/**
 * 跟後端要目前的工作時段
 * @param {boolean} [force] - 是否忽略「本次 session 已載入過」的判斷
 */
async function loadWorkSchedule(force = false) {
    if (_workScheduleLoaded && !force) return getWorkSchedule();

    try {
        const res = await callApifetch('getWorkSchedule', null);
        if (res.ok && res.workSchedule) {
            _workScheduleLoaded = true;
            applyWorkSchedule(res.workSchedule);
        }
    } catch (err) {
        // 讀不到就沿用快取或 config.js 的預設值，不擋使用者操作
        console.warn('載入工作時段失敗，沿用現有設定:', err);
    }

    return getWorkSchedule();
}

/**
 * 更新請假頁「計算時數」下方那行說明，讓它顯示實際生效的時段
 */
function renderWorkScheduleNote() {
    const el = document.getElementById('leave-work-schedule-note');
    if (!el || typeof t !== 'function') return;

    // 語系還沒載入時 t() 會原樣回傳鍵名，這時維持 HTML 裡的預設文字
    const text = t('LUNCH_BREAK_NOTE', getWorkSchedule());
    if (text === 'LUNCH_BREAK_NOTE') return;

    el.textContent = text;
}

/**
 * 把目前設定填回管理員表單
 */
function fillWorkScheduleForm() {
    const schedule = getWorkSchedule();
    for (const field of WORK_SCHEDULE_FIELDS) {
        const input = document.getElementById(`work-schedule-${field}`);
        if (input) input.value = schedule[field];
    }
}

/**
 * 管理員分頁初始化：填表單並綁定按鈕（只綁一次）
 */
async function initWorkScheduleAdmin() {
    await loadWorkSchedule(true);
    fillWorkScheduleForm();

    if (_workScheduleAdminBound) return;
    _workScheduleAdminBound = true;

    document.getElementById('save-work-schedule-btn')?.addEventListener('click', saveWorkSchedule);
    document.getElementById('reset-work-schedule-btn')?.addEventListener('click', resetWorkSchedule);
}

/**
 * 管理員：儲存工作時段
 */
async function saveWorkSchedule() {
    const btn = document.getElementById('save-work-schedule-btn');
    const schedule = {};

    for (const field of WORK_SCHEDULE_FIELDS) {
        schedule[field] = (document.getElementById(`work-schedule-${field}`)?.value || '').trim();
    }

    // 先在前端擋掉明顯錯誤的組合，後端也會再驗一次
    const error = validateWorkSchedule(schedule);
    if (error) {
        showNotification(error, 'error');
        return;
    }

    if (btn) btn.disabled = true;

    try {
        const query = WORK_SCHEDULE_FIELDS
            .map(field => `${field}=${encodeURIComponent(schedule[field])}`)
            .join('&');
        const res = await callApifetch(`updateWorkSchedule&${query}`, null);

        if (res.ok) {
            applyWorkSchedule(res.workSchedule || schedule);
            showNotification(t('WORK_SCHEDULE_SAVED'), 'success');
        } else {
            showNotification(res.msg || t('WORK_SCHEDULE_SAVE_FAILED'), 'error');
        }
    } catch (err) {
        console.error('儲存工作時段失敗:', err);
        showNotification(t('WORK_SCHEDULE_SAVE_FAILED'), 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/**
 * 管理員：還原成系統預設值
 */
async function resetWorkSchedule() {
    if (!confirm(t('WORK_SCHEDULE_RESET_CONFIRM'))) return;

    const btn = document.getElementById('reset-work-schedule-btn');
    if (btn) btn.disabled = true;

    try {
        const res = await callApifetch('resetWorkSchedule', null);

        if (res.ok) {
            applyWorkSchedule(res.workSchedule);
            showNotification(t('WORK_SCHEDULE_RESET_DONE'), 'success');
        } else {
            showNotification(res.msg || t('WORK_SCHEDULE_SAVE_FAILED'), 'error');
        }
    } catch (err) {
        console.error('還原工作時段失敗:', err);
        showNotification(t('WORK_SCHEDULE_SAVE_FAILED'), 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// config.js 已經載入，先用上次的結果補上，登入後再跟後端確認
restoreWorkScheduleFromCache();
