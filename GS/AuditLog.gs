// AuditLog.gs
//
// 薪資異動的稽核軌跡。
//
// saveMonthlySalary() 會直接覆寫同一個月的薪資單，改之前是多少、誰改的、什麼時候改的
// 全都查不到。薪資是會被勞檢的資料，這種「靜默覆寫」有風險，所以每次寫入都留一筆記錄。
//
// 只記錄「有變動的欄位」，沒動到的不寫，避免每月重算一次就塞滿幾萬列。

const SHEET_SALARY_AUDIT = '薪資異動記錄';

// 這些欄位每次計算都會變（時間戳記之類），記了只是雜訊
const AUDIT_IGNORED_COLUMNS = ['建立時間', '備註'];

// 一次寫入最多記幾個欄位，避免異常資料灌爆整張表
const AUDIT_MAX_FIELDS_PER_ENTRY = 40;

/**
 * 取得（必要時建立）稽核記錄表
 */
function getSalaryAuditSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_SALARY_AUDIT);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_SALARY_AUDIT);
    sheet.appendRow(['時間', '薪資單ID', '員工ID', '員工姓名', '年月',
                     '動作', '欄位', '原本的值', '改成的值', '操作者']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 10)
         .setFontWeight('bold')
         .setBackground('#6b7280')
         .setFontColor('#ffffff');
    Logger.log(' 已建立「薪資異動記錄」工作表');
  }

  return sheet;
}

/**
 * 目前操作者的名稱。取不到就記 '系統'（例如定時觸發器跑的）。
 */
function getAuditActor_(token) {
  try {
    if (token && typeof getUserByToken === 'function') {
      const user = getUserByToken(token);
      if (user && user.name) return user.name;
    }
  } catch (error) {
    // 拿不到就算了，不能讓稽核記錄擋住薪資儲存
  }
  return '系統';
}

/**
 * 兩個值是否視為相同。試算表讀回來的數字可能是字串，日期則是物件。
 */
function isSameAuditValue_(before, after) {
  if (before === after) return true;
  if (before === null || before === undefined || before === '') {
    return after === null || after === undefined || after === '';
  }
  if (after === null || after === undefined || after === '') return false;

  if (before instanceof Date && after instanceof Date) {
    return before.getTime() === after.getTime();
  }

  const beforeNum = parseFloat(before);
  const afterNum = parseFloat(after);
  if (!isNaN(beforeNum) && !isNaN(afterNum)) {
    // 四捨五入到元，避免浮點誤差被當成異動
    return Math.round(beforeNum) === Math.round(afterNum);
  }

  return String(before).trim() === String(after).trim();
}

function formatAuditValue_(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  }
  return String(value);
}

/**
 * 記錄一次薪資單寫入。
 *
 * @param {Object} info
 * @param {string} info.salaryId   薪資單ID
 * @param {Array}  info.headers    欄位名稱
 * @param {Array}  info.beforeRow  原本那一列（新建時傳 null）
 * @param {Array}  info.afterRow   寫入後那一列
 * @param {string} [info.token]    操作者的 session token
 */
function logSalaryChange_(info) {
  try {
    const { salaryId, headers, beforeRow, afterRow } = info;
    if (!headers || !afterRow) return;

    const isNew = !beforeRow;
    const actor = getAuditActor_(info.token);
    const now = new Date();

    const employeeIdIndex = headers.indexOf('員工ID');
    const employeeNameIndex = headers.indexOf('員工姓名');
    const yearMonthIndex = headers.indexOf('年月');

    const employeeId = employeeIdIndex === -1 ? '' : afterRow[employeeIdIndex];
    const employeeName = employeeNameIndex === -1 ? '' : afterRow[employeeNameIndex];
    const yearMonth = yearMonthIndex === -1 ? '' : afterRow[yearMonthIndex];

    const rows = [];

    if (isNew) {
      // 新建只記一列，不必把幾十個欄位全展開
      rows.push([now, salaryId, employeeId, employeeName, yearMonth,
                 '新建', '', '', '', actor]);
    } else {
      for (let i = 0; i < headers.length && rows.length < AUDIT_MAX_FIELDS_PER_ENTRY; i++) {
        const column = String(headers[i]).trim();
        if (AUDIT_IGNORED_COLUMNS.indexOf(column) !== -1) continue;
        if (isSameAuditValue_(beforeRow[i], afterRow[i])) continue;

        rows.push([now, salaryId, employeeId, employeeName, yearMonth, '修改', column,
                   formatAuditValue_(beforeRow[i]), formatAuditValue_(afterRow[i]), actor]);
      }
    }

    if (rows.length === 0) return;  // 重算但結果一樣，不留記錄

    const sheet = getSalaryAuditSheet_();
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);

    Logger.log(` 薪資異動已記錄：${salaryId}，${isNew ? '新建' : rows.length + ' 個欄位變動'}`);

  } catch (error) {
    // 稽核失敗不能擋住薪資儲存，記個 log 就好
    Logger.log(' 寫入薪資異動記錄失敗: ' + error.message);
  }
}

/**
 * API：查詢某位員工某個月的薪資異動記錄（僅管理員）
 */
function handleGetSalaryAuditLog(params) {
  try {
    const user = getUserByToken(params.token);
    if (!user || user.dept !== '管理員') {
      return { ok: false, code: 'PERMISSION_DENIED', msg: '此功能僅限管理員使用' };
    }

    const sheet = getSalaryAuditSheet_();
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) return { ok: true, entries: [] };

    const employeeId = String(params.employeeId || '').trim();
    const yearMonth = String(params.yearMonth || '').trim();

    const entries = [];

    for (let i = 1; i < data.length; i++) {
      if (employeeId && String(data[i][2]).trim() !== employeeId) continue;
      if (yearMonth && String(data[i][4]).trim() !== yearMonth) continue;

      entries.push({
        at: formatAuditValue_(data[i][0]),
        salaryId: data[i][1],
        employeeId: data[i][2],
        employeeName: data[i][3],
        yearMonth: data[i][4],
        action: data[i][5],
        column: data[i][6],
        before: data[i][7],
        after: data[i][8],
        actor: data[i][9]
      });
    }

    // 最新的排前面
    entries.reverse();

    return { ok: true, entries: entries.slice(0, 200) };

  } catch (error) {
    Logger.log(' handleGetSalaryAuditLog 錯誤: ' + error.message);
    return { ok: false, msg: error.toString() };
  }
}
