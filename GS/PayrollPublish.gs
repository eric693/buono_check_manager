// PayrollPublish.gs
//
// 薪資發放：薪資單先是「草稿」，管理員核對完一整個月，按「發放」之後員工才看得到。
//
//   草稿期間：員工的「我的薪資」顯示「本月薪資尚未發放」，薪資歷史也不列出這個月
//   發放：記在「薪資發放」工作表，並用 LINE 通知這個月有薪資單的員工
//   發放之後：員工看到的是「月薪資記錄」裡存好的那一張（不再即時重算），
//            管理員之後再修改，員工端會標示「已於 … 更新」
//   撤回發放：回到草稿，員工暫時看不到（用在發現大錯、要整批重來的時候）

const SHEET_PAYROLL_PUBLISH = '薪資發放';
const PAYROLL_PUBLISH_HEADERS = ['年月', '狀態', '發放時間', '發放者', '通知人數', '未收到通知', '撤回時間', '撤回者'];
const PAYROLL_STATUS_PUBLISHED = '已發放';
const PAYROLL_STATUS_WITHDRAWN = '已撤回';

function getPayrollPublishSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_PAYROLL_PUBLISH);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_PAYROLL_PUBLISH);
    sheet.appendRow(PAYROLL_PUBLISH_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, PAYROLL_PUBLISH_HEADERS.length)
         .setFontWeight('bold').setBackground('#1f4e79').setFontColor('#ffffff');
    // 年月存成文字，不要被試算表轉成日期
    sheet.getRange('A:A').setNumberFormat('@');
  }
  return sheet;
}

function payrollYearMonthText_(value) {
  if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'Asia/Taipei', 'yyyy-MM');
  }
  return String(value || '').trim().substring(0, 7);
}

/**
 * 某個月的發放狀態
 * @returns {{ published: boolean, publishedAt: Date|null, publishedBy: string, row: number }}
 */
function getPayrollPublishInfo_(yearMonth) {
  const sheet = getPayrollPublishSheet_();
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (payrollYearMonthText_(data[i][0]) !== yearMonth) continue;
    return {
      published: String(data[i][1]) === PAYROLL_STATUS_PUBLISHED,
      publishedAt: data[i][2] || null,
      publishedBy: String(data[i][3] || ''),
      notified: Number(data[i][4]) || 0,
      row: i + 1
    };
  }
  return { published: false, publishedAt: null, publishedBy: '', notified: 0, row: -1 };
}

function isPayrollPublished_(yearMonth) {
  return getPayrollPublishInfo_(yearMonth).published;
}

/** 「月薪資記錄」裡某個月每位員工的那一列：{ 員工ID: { headers, row } } */
function readMonthlySalaryRowsForMonth_(yearMonth) {
  const sheet = getMonthlySalarySheetEnhanced();
  const data = sheet.getDataRange().getValues();
  const headers = data[0].map(h => String(h).trim());
  const idIndex = headers.indexOf('員工ID');
  const ymIndex = headers.indexOf('年月');
  const rows = {};
  for (let i = 1; i < data.length; i++) {
    if (payrollYearMonthText_(data[i][ymIndex]) !== yearMonth) continue;
    rows[String(data[i][idIndex]).trim()] = { headers: headers, row: data[i] };
  }
  return rows;
}

/**
 * 員工看自己的薪資單（getMySalary 用）：
 *   沒發放 → 回傳 PAYSLIP_NOT_PUBLISHED
 *   已發放 → 回傳存好的那一張（不重算），附上發放時間與「發放後是否有更新」
 */
function readPublishedPayslip_(employeeId, yearMonth) {
  const info = getPayrollPublishInfo_(yearMonth);
  if (!info.published) {
    return { success: false, code: 'PAYSLIP_NOT_PUBLISHED', message: '本月薪資尚未發放' };
  }
  const found = readMonthlySalaryRow_(employeeId, yearMonth);
  if (!found) return { success: false, code: 'PAYSLIP_NOT_FOUND', message: '查無薪資記錄' };

  const data = monthlyRowToSalaryData_(found.headers, found.row);
  const savedAt = found.row[found.headers.indexOf('建立時間')];
  const publishedAt = info.publishedAt ? new Date(info.publishedAt) : null;
  data.publishedAt = publishedAt ? formatDateTime(publishedAt) : '';
  data.updatedAfterPublish = !!(publishedAt && savedAt && new Date(savedAt).getTime() > publishedAt.getTime() + 1000);
  data.updatedAt = data.updatedAfterPublish ? formatDateTime(new Date(savedAt)) : '';
  if (data['簽收時間']) data['簽收時間'] = formatDateTime(new Date(data['簽收時間']));
  return { success: true, data: data };
}

function requirePayrollAdmin_(token) {
  const session = checkSession_(token);
  return (session.ok && session.user && session.user.dept === '管理員') ? session.user : null;
}

// ==================== API ====================

/**
 * API（管理員）：某個月的發放清單 —— 每位在職員工有沒有薪資單、金額、是否簽收
 */
function handleGetPayrollMonthStatus(params) {
  if (!requirePayrollAdmin_(params.token)) return { ok: false, code: 'PERMISSION_DENIED', msg: '需要管理員權限' };
  const yearMonth = String(params.yearMonth || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) return { ok: false, code: 'INVALID_YEAR_MONTH', msg: '年月格式錯誤' };

  const rows = readMonthlySalaryRowsForMonth_(yearMonth);
  const employees = SpreadsheetApp.getActive().getSheetByName(SHEET_EMPLOYEES).getDataRange().getValues();
  const seen = {};
  const list = [];

  const push = (id, name, active) => {
    if (seen[id]) return;
    seen[id] = true;
    const r = rows[id];
    const item = { employeeId: id, employeeName: name, active: active, status: 'missing' };
    if (r) {
      const d = monthlyRowToSalaryData_(r.headers, r.row);
      item.employeeName = name || d.employeeName;
      item.status = d.manualPayslip ? 'manual' : 'auto';
      item.salaryType = d.salaryType;
      item.grossSalary = d.grossSalary;
      item.netSalary = d.netSalary;
      item.deductions = d.grossSalary - d.netSalary;
      const ack = r.row[r.headers.indexOf('簽收時間')];
      item.acknowledgedAt = ack ? formatDateTime(new Date(ack)) : '';
    }
    list.push(item);
  };

  for (let i = 1; i < employees.length; i++) {
    const id = String(employees[i][EMPLOYEE_COL.USER_ID] || '').trim();
    if (!id) continue;
    const status = String(employees[i][EMPLOYEE_COL.STATUS] || '啟用').trim();
    const name = String(employees[i][8] || employees[i][EMPLOYEE_COL.NAME] || '').trim();
    if (status === '啟用' || rows[id]) push(id, name, status === '啟用');
  }
  // 已不在員工名單、但這個月有薪資單的（例如已刪除的員工）也列出來
  Object.keys(rows).forEach(id => push(id, '', false));

  const info = getPayrollPublishInfo_(yearMonth);
  const withPayslip = list.filter(x => x.status !== 'missing');
  return {
    ok: true,
    yearMonth: yearMonth,
    published: info.published,
    publishedAt: info.publishedAt ? formatDateTime(new Date(info.publishedAt)) : '',
    publishedBy: info.publishedBy,
    employees: list,
    summary: {
      total: list.length,
      withPayslip: withPayslip.length,
      missing: list.filter(x => x.status === 'missing' && x.active).length,
      grossTotal: withPayslip.reduce((s, x) => s + (x.grossSalary || 0), 0),
      netTotal: withPayslip.reduce((s, x) => s + (x.netSalary || 0), 0),
      acknowledged: withPayslip.filter(x => x.acknowledgedAt).length
    }
  };
}

/**
 * API（管理員）：發放某個月的薪資條，並用 LINE 通知有薪資單的員工
 */
function handlePublishPayroll(params) {
  const admin = requirePayrollAdmin_(params.token);
  if (!admin) return { ok: false, code: 'PERMISSION_DENIED', msg: '需要管理員權限' };
  const yearMonth = String(params.yearMonth || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) return { ok: false, code: 'INVALID_YEAR_MONTH', msg: '年月格式錯誤' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let recipients;
  try {
    const info = getPayrollPublishInfo_(yearMonth);
    if (info.published) {
      return { ok: false, code: 'PAYROLL_ALREADY_PUBLISHED', msg: '這個月已經發放過了' };
    }
    const rows = readMonthlySalaryRowsForMonth_(yearMonth);
    recipients = Object.keys(rows);
    if (recipients.length === 0) {
      return { ok: false, code: 'PAYROLL_NOTHING_TO_PUBLISH', msg: '這個月還沒有任何薪資單' };
    }

    const sheet = getPayrollPublishSheet_();
    const now = new Date();
    const record = [yearMonth, PAYROLL_STATUS_PUBLISHED, now, admin.name || admin.userId, 0, '', '', ''];
    if (info.row > 0) {
      sheet.getRange(info.row, 1, 1, record.length).setValues([record]);
    } else {
      sheet.appendRow(record);
    }
  } finally {
    lock.releaseLock();
  }

  // 通知放在鎖外面：一個一個打 LINE API 要一點時間，不要卡住其他人
  const [y, m] = yearMonth.split('-');
  // 連結帶上月份，點開就是這個月的薪資條（不然會先看到當月的「尚未發放」）
  const text = `💰 ${y} 年 ${Number(m)} 月薪資條已發放\n請到出勤管家「薪資」頁查看，確認無誤後按「簽收」。\n${LINE_REDIRECT_URL}salary.html?month=${yearMonth}`;
  let notified = 0;
  const notNotified = [];
  const names = (typeof getEmployeeNameMap_ === 'function') ? getEmployeeNameMap_() : {};
  recipients.forEach(id => {
    let ok = false;
    try {
      ok = !!(sendLineNotification_(id, { type: 'text', text: text }) || {}).ok;
    } catch (error) {
      Logger.log(' 薪資發放通知失敗: ' + id + ' ' + error);
    }
    if (ok) notified++;
    else notNotified.push(names[id] || id);
  });

  const info = getPayrollPublishInfo_(yearMonth);
  if (info.row > 0) {
    getPayrollPublishSheet_().getRange(info.row, 5, 1, 2).setValues([[notified, notNotified.join('、')]]);
  }

  return { ok: true, yearMonth: yearMonth, recipients: recipients.length, notified: notified, notNotified: notNotified };
}

/**
 * API（管理員）：撤回發放，員工暫時看不到這個月的薪資單
 */
function handleUnpublishPayroll(params) {
  const admin = requirePayrollAdmin_(params.token);
  if (!admin) return { ok: false, code: 'PERMISSION_DENIED', msg: '需要管理員權限' };
  const yearMonth = String(params.yearMonth || '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) return { ok: false, code: 'INVALID_YEAR_MONTH', msg: '年月格式錯誤' };

  const info = getPayrollPublishInfo_(yearMonth);
  if (!info.published) return { ok: false, code: 'PAYROLL_NOT_PUBLISHED', msg: '這個月還沒有發放' };

  const sheet = getPayrollPublishSheet_();
  sheet.getRange(info.row, 2).setValue(PAYROLL_STATUS_WITHDRAWN);
  sheet.getRange(info.row, 7, 1, 2).setValues([[new Date(), admin.name || admin.userId]]);
  return { ok: true, yearMonth: yearMonth };
}

/**
 * API（管理員）：刪除還沒發放的薪資單（例如誤按試算存下來的那一張）
 * 已發放的月份要先撤回發放才能刪，避免員工看到的薪資單憑空消失
 */
function handleDeleteDraftPayslip(params) {
  if (!requirePayrollAdmin_(params.token)) return { ok: false, code: 'PERMISSION_DENIED', msg: '需要管理員權限' };
  const employeeId = String(params.employeeId || '').trim();
  const yearMonth = String(params.yearMonth || '').trim();
  if (!employeeId) return { ok: false, code: 'MISSING_EMPLOYEE_ID', msg: '缺少員工ID' };
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) return { ok: false, code: 'INVALID_YEAR_MONTH', msg: '年月格式錯誤' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (isPayrollPublished_(yearMonth)) {
      return { ok: false, code: 'PAYROLL_ALREADY_PUBLISHED', msg: '這個月已經發放，請先撤回發放再刪除' };
    }
    const sheet = getMonthlySalarySheetEnhanced();
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim());
    const idIndex = headers.indexOf('員工ID');
    const ymIndex = headers.indexOf('年月');
    let deleted = 0;
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][idIndex]).trim() !== employeeId) continue;
      if (payrollYearMonthText_(data[i][ymIndex]) !== yearMonth) continue;
      sheet.deleteRow(i + 1);
      deleted++;
    }
    if (!deleted) return { ok: false, code: 'PAYSLIP_NOT_FOUND', msg: '查無薪資記錄' };
    return { ok: true, employeeId: employeeId, yearMonth: yearMonth, deleted: deleted };
  } finally {
    lock.releaseLock();
  }
}
