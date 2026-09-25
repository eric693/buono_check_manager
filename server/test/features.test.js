// 其他功能模組：加班、請假、工作日誌、排班、薪資、費用、附件、QR、公告、操作紀錄
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRuntime } = require('./helpers');

const t = makeRuntime();
const ADMIN = t.addEmployee('Uadmin', '老闆', '管理員');
const EMP = t.addEmployee('Uemp', '小明', '員工');
const { Utilities } = t.runtime.context;
const fmt = (d, p) => Utilities.formatDate(d, 'Asia/Taipei', p);

// 找一個最近的平日，請假、加班才不會落在假日
function nextWeekday(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
const workday = nextWeekday(3);
const ymd = fmt(workday, 'yyyy-MM-dd');
const month = fmt(new Date(), 'yyyy-MM');

const show = r => JSON.stringify(r).slice(0, 400);

test('加班：申請 → 待審核 → 核准', () => {
  const r = t.api({ action: 'submitOvertime', token: EMP, overtimeDate: ymd, startTime: '18:00', endTime: '20:00', hours: '2', reason: '盤點', compensatoryHours: '0' });
  assert.equal(r.ok, true, show(r));
  const pending = t.api({ action: 'getPendingOvertime', token: ADMIN });
  assert.equal(pending.ok, true, show(pending));
  assert.equal(pending.requests.length, 1, show(pending));
  const review = t.api({ action: 'reviewOvertime', token: ADMIN, rowNumber: pending.requests[0].rowNumber, reviewAction: 'approve', comment: '' });
  assert.equal(review.ok, true, show(review));
  const mine = t.api({ action: 'getEmployeeOvertime', token: EMP });
  assert.equal(mine.ok, true, show(mine));
});

test('請假：額度 → 申請 → 核准', () => {
  const bal = t.api({ action: 'getLeaveBalance', token: EMP });
  assert.equal(bal.ok, true, show(bal));
  const r = t.api({ action: 'submitLeave', token: EMP, leaveType: 'PERSONAL_LEAVE', startDateTime: `${ymd}T09:00`, endDateTime: `${ymd}T12:00`, reason: '辦事' });
  assert.equal(r.ok, true, show(r));
  const pending = t.api({ action: 'getPendingLeaveRequests', token: ADMIN });
  assert.equal(pending.ok, true, show(pending));
  assert.ok(pending.requests.length >= 1, show(pending));
  const review = t.api({ action: 'reviewLeave', token: ADMIN, rowNumber: pending.requests[0].rowNumber, reviewAction: 'approve', comment: '' });
  assert.equal(review.ok, true, show(review));
  assert.equal(t.api({ action: 'getEmployeeLeaveRecords', token: EMP }).ok, true);
});

test('工作日誌：送出 → 待審核 → 核准', () => {
  const r = t.api({ action: 'submitWorklog', token: EMP, date: ymd, hours: '8', content: '整理倉庫並清點本週進貨的商品', userId: 'Uemp' });
  assert.equal(r.ok, true, show(r));
  const pending = t.api({ action: 'getPendingWorklogs', token: ADMIN });
  assert.equal(pending.ok, true, show(pending));
  const list = pending.data || pending.worklogs || pending.records || [];
  assert.ok(list.length >= 1, show(pending));
  const id = list[0].worklogId || list[0].id;
  const review = t.api({ action: 'reviewWorklog', token: ADMIN, worklogId: id, reviewAction: 'approve', reviewComment: '' });
  assert.equal(review.ok, true, show(review));
});

test('排班：新增 → 查詢', () => {
  const r = t.api({ action: 'addShift', token: ADMIN, employeeId: 'Uemp', employeeName: '小明', date: ymd, shiftType: '早班', startTime: '09:00', endTime: '18:00', location: '台北門市' });
  assert.equal(r.ok, true, show(r));
  const list = t.api({ action: 'getShifts', token: EMP, employeeId: 'Uemp' });
  assert.equal(list.ok, true, show(list));
  assert.ok(list.data.length >= 1, show(list));
});

test('薪資：設定 → 計算 → 員工查詢', () => {
  const set = t.api({ action: 'setEmployeeSalaryTW', token: ADMIN, employeeId: 'Uemp', employeeName: '小明', salaryType: '月薪', employeeType: '正職', baseSalary: '32000', mealAllowance: '2400', bankCode: '822', bankAccount: '123456789012' });
  assert.equal(set.ok, true, show(set));
  const cfg = t.api({ action: 'getEmployeeSalaryTW', token: ADMIN, employeeId: 'Uemp' });
  assert.equal(cfg.ok, true, show(cfg));
  const calc = t.api({ action: 'calculateMonthlySalary', token: EMP, employeeId: 'Uemp', yearMonth: month });
  assert.equal(calc.ok, true, show(calc));
  assert.ok(calc.data.grossSalary > 0, show(calc));
  const batch = t.api({ action: 'batchCalculateSalary', token: ADMIN, yearMonth: month });
  assert.equal(batch.ok, true, show(batch));
  const mine = t.api({ action: 'getMySalary', token: EMP, yearMonth: month });
  assert.equal(mine.ok, true, show(mine));
  const all = t.api({ action: 'getAllMonthlySalary', token: ADMIN, yearMonth: month });
  assert.equal(all.ok, true, show(all));
  assert.ok(all.data.length >= 1, show(all));
});

test('費用申請與附件（本機雲端硬碟）', () => {
  const r = t.api({ action: 'submitExpense', token: EMP, type: 'reimbursement', date: ymd, amount: '350', reason: '計程車' });
  assert.equal(r.ok, true, show(r));
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const up = t.api({ action: 'uploadAttachment', token: EMP, type: 'expense', recordKey: 'expense:' + r.id, filename: 'r.png', mimeType: 'image/png', data: png }, 'POST');
  assert.equal(up.ok, true, show(up));
  const got = t.api({ action: 'getAttachment', token: ADMIN, attachmentId: up.attachment.attachmentId });
  assert.equal(got.ok, true, show(got));
  assert.equal(got.data, png, '檔案內容原封不動');
  const review = t.api({ action: 'reviewExpense', token: ADMIN, id: r.id, reviewAction: 'approve' });
  assert.equal(review.ok, true, show(review));
});

test('QR Code 與平板打卡（簽章用 HMAC）', () => {
  const k = t.api({ action: 'resetKioskKey', token: ADMIN, loc: '台北門市' });
  assert.equal(k.ok, true, show(k));
  const q = t.api({ action: 'getKioskQr', kioskKey: k.kioskKey });
  assert.equal(q.ok, true, show(q));
  const p = t.api({ action: 'qrPunch', token: EMP, qrToken: q.checkOut, loc: q.loc });
  assert.equal(p.ok, true, show(p));
  const forged = t.api({ action: 'qrPunch', token: EMP, qrToken: 'I_FFFFFFFFFFF_0123456789abcdef', loc: '' });
  assert.equal(forged.code, 'ERR_QR_INVALID');
});

test('公告、基本資料、操作紀錄', () => {
  assert.equal(t.api({ action: 'addAnnouncement', token: ADMIN, title: '颱風', content: '停班', priority: 'high' }).ok, true);
  const list = t.api({ action: 'getAnnouncements', token: EMP });
  assert.equal(list.announcements.length, 1);
  const basic = t.api({ action: 'setEmployeeBasicInfo', token: EMP, name: '王小明', idNumber: 'A123456789', phone: '0912345678' });
  assert.equal(basic.ok, true, show(basic));
  assert.equal(t.api({ action: 'checkSession', token: EMP }).user.name, '王小明');
  const audit = t.api({ action: 'getAdminAuditLog', token: ADMIN });
  assert.equal(audit.ok, true, show(audit));
  const actions = audit.entries.map(e => e.action);
  for (const a of ['addAnnouncement', 'reviewExpense', 'setEmployeeSalaryTW', 'resetKioskKey']) {
    assert.ok(actions.includes(a), `操作紀錄要有 ${a}：${actions}`);
  }
});

test('初始化 API 與請假額度', () => {
  const init = t.api({ action: 'initApp', token: EMP });
  assert.equal(init.ok, true, show(init));
  assert.equal(t.api({ action: 'getWorkSchedule', token: EMP }).ok, true);
  assert.equal(t.api({ action: 'getSalaryRules', token: ADMIN }).ok, true);
});

test('匯出薪資總表：產生 .xlsx 存在本機，連結可以下載', async () => {
  const ExcelJS = require('exceljs');
  const res = t.api({ action: 'exportAllSalaryExcel', token: ADMIN, yearMonth: month });
  assert.equal(res.ok, true, show(res));
  assert.match(res.fileUrl, /^https:\/\/buono\.example\/files\/[0-9a-f]{32}\//);

  const id = res.fileUrl.match(/files\/([0-9a-f]{32})/)[1];
  const file = t.runtime.DriveApp.__readFile(id);
  assert.ok(file, '檔案要存在');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file.path);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, '薪資明細');
  assert.equal(ws.getCell('C1').value, '員工姓名');
  assert.equal(ws.getCell('C2').value, '小明', '薪資單存的是計算當時的姓名');
  assert.ok(ws.rowCount >= 2);
});
