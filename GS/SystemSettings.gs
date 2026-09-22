// SystemSettings.gs
//
// 系統層級的可調參數（目前是全公司共用的工作時段），存在試算表的「系統設定」
// 工作表裡，管理員可以從網頁版直接改，不必動程式碼也不必重新部署。
//
// 前端 config.js 的 API_CONFIG.workSchedule 只是離線 / 尚未登入時的預設值，
// 登入後會用 getWorkSchedule 的結果覆蓋，所以兩邊的計算結果才會一致。

const SHEET_SYSTEM_SETTINGS = '系統設定';
const SETTING_KEY_WORK_SCHEDULE = 'workSchedule';
const WORK_SCHEDULE_CACHE_KEY = 'system_settings_work_schedule';
const WORK_SCHEDULE_CACHE_TTL = 300; // 秒；改設定時會主動清掉

/**
 * 取得（必要時建立）系統設定工作表
 */
function getSystemSettingsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_SYSTEM_SETTINGS);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SYSTEM_SETTINGS);
    sheet.appendRow(['設定鍵', '設定值(JSON)', '更新時間', '更新者']);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/**
 * 讀取單一設定值（JSON 字串），找不到回傳 null
 */
function readSystemSetting_(key) {
  const sheet = getSystemSettingsSheet_();
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === key) {
      return { row: i + 1, value: String(data[i][1] || '') };
    }
  }

  return null;
}

/**
 * 寫入單一設定值（有就覆蓋、沒有就新增）
 */
function writeSystemSetting_(key, value, updatedBy) {
  const sheet = getSystemSettingsSheet_();
  const existing = readSystemSetting_(key);
  const now = new Date().toISOString();

  if (existing) {
    sheet.getRange(existing.row, 1, 1, 4).setValues([[key, value, now, updatedBy || '']]);
  } else {
    sheet.appendRow([key, value, now, updatedBy || '']);
  }
}

/**
 * 檢查 HH:MM（24 小時制）
 */
function isValidTimeOfDay_(hhmm) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(hhmm || '').trim());
}

/**
 * 驗證工作時段設定，通過回傳 { ok: true, workSchedule }，否則 { ok: false, msg }
 */
function validateWorkSchedule_(input) {
  const fields = ['start', 'end', 'lunchStart', 'lunchEnd'];
  const schedule = {};

  for (let i = 0; i < fields.length; i++) {
    const name = fields[i];
    const value = String((input && input[name]) || '').trim();

    if (!isValidTimeOfDay_(value)) {
      return { ok: false, msg: `時間格式錯誤（${name}）：請使用 HH:MM，例如 08:30` };
    }

    schedule[name] = value;
  }

  const start = toMinutesOfDay_(schedule.start);
  const end = toMinutesOfDay_(schedule.end);
  const lunchStart = toMinutesOfDay_(schedule.lunchStart);
  const lunchEnd = toMinutesOfDay_(schedule.lunchEnd);

  if (end <= start) {
    return { ok: false, msg: '下班時間必須晚於上班時間' };
  }
  if (lunchEnd < lunchStart) {
    return { ok: false, msg: '午休結束時間不能早於午休開始時間' };
  }
  if (lunchStart < start || lunchEnd > end) {
    return { ok: false, msg: '午休時間必須落在上班與下班時間之間' };
  }

  return { ok: true, workSchedule: schedule };
}

/**
 * 取得目前生效的工作時段。
 * 讀不到或資料壞掉時退回 DEFAULT_WORK_SCHEDULE，確保請假時數一定算得出來。
 */
function getWorkSchedule_() {
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(WORK_SCHEDULE_CACHE_KEY);
    if (cached) {
      return JSON.parse(cached);
    }

    const stored = readSystemSetting_(SETTING_KEY_WORK_SCHEDULE);
    let schedule = DEFAULT_WORK_SCHEDULE;

    if (stored && stored.value) {
      const parsed = JSON.parse(stored.value);
      const checked = validateWorkSchedule_(parsed);
      if (checked.ok) {
        schedule = checked.workSchedule;
      } else {
        Logger.log(` 系統設定的工作時段不合法，改用預設值：${checked.msg}`);
      }
    }

    cache.put(WORK_SCHEDULE_CACHE_KEY, JSON.stringify(schedule), WORK_SCHEDULE_CACHE_TTL);
    return schedule;

  } catch (error) {
    Logger.log(` 讀取工作時段失敗，改用預設值: ${error.message}`);
    return DEFAULT_WORK_SCHEDULE;
  }
}

/**
 * API：取得工作時段（所有登入者都要用，前端算請假時數預覽會呼叫）
 */
function handleGetWorkSchedule(params) {
  try {
    if (!params || !params.token || !validateSession(params.token)) {
      return { ok: false, code: 'SESSION_INVALID', msg: '未授權或 session 已過期' };
    }

    const stored = readSystemSetting_(SETTING_KEY_WORK_SCHEDULE);

    return {
      ok: true,
      workSchedule: getWorkSchedule_(),
      isDefault: !(stored && stored.value)
    };

  } catch (error) {
    Logger.log(` handleGetWorkSchedule 錯誤: ${error.message}`);
    return { ok: false, msg: error.toString() };
  }
}

/**
 * API：更新工作時段（僅管理員）
 */
function handleUpdateWorkSchedule(params) {
  try {
    const user = getUserByToken(params.token);
    if (!user || user.dept !== '管理員') {
      return { ok: false, code: 'PERMISSION_DENIED', msg: '此功能僅限管理員使用' };
    }

    const checked = validateWorkSchedule_({
      start: params.start,
      end: params.end,
      lunchStart: params.lunchStart,
      lunchEnd: params.lunchEnd
    });

    if (!checked.ok) {
      return { ok: false, code: 'INVALID_WORK_SCHEDULE', msg: checked.msg };
    }

    writeSystemSetting_(
      SETTING_KEY_WORK_SCHEDULE,
      JSON.stringify(checked.workSchedule),
      user.name || user.userId || ''
    );

    // 下一次讀取要拿到新值，快取必須先清掉
    CacheService.getScriptCache().remove(WORK_SCHEDULE_CACHE_KEY);

    Logger.log(` 管理員 ${user.name} 更新工作時段: ${JSON.stringify(checked.workSchedule)}`);

    return { ok: true, msg: '工作時段已更新', workSchedule: checked.workSchedule };

  } catch (error) {
    Logger.log(` handleUpdateWorkSchedule 錯誤: ${error.message}`);
    return { ok: false, msg: error.toString() };
  }
}

/**
 * API：還原成系統預設值（僅管理員）
 */
function handleResetWorkSchedule(params) {
  try {
    const user = getUserByToken(params.token);
    if (!user || user.dept !== '管理員') {
      return { ok: false, code: 'PERMISSION_DENIED', msg: '此功能僅限管理員使用' };
    }

    const existing = readSystemSetting_(SETTING_KEY_WORK_SCHEDULE);
    if (existing) {
      getSystemSettingsSheet_().deleteRow(existing.row);
    }

    CacheService.getScriptCache().remove(WORK_SCHEDULE_CACHE_KEY);

    return { ok: true, msg: '已還原為預設工作時段', workSchedule: DEFAULT_WORK_SCHEDULE };

  } catch (error) {
    Logger.log(` handleResetWorkSchedule 錯誤: ${error.message}`);
    return { ok: false, msg: error.toString() };
  }
}
