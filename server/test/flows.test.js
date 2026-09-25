// 透過 doGet / doPost 跑一遍主要流程，確認現有 GS 程式在相容層上行為正常
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRuntime } = require('./helpers');
const { isDate } = require('../src/values');

const t = makeRuntime();
const ADMIN = t.addEmployee('Uadmin', '老闆', '管理員');
const EMP = t.addEmployee('Uemp', '小明', '員工');
t.ss.getSheetByName('打卡地點表').appendRow(['L1', '台北門市', 25.0330, 121.5654, 100]);
t.runtime.store.flush();

const today = t.runtime.context.Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
const month = today.slice(0, 7);

test('登入狀態與權限關卡', () => {
  const s = t.api({ action: 'checkSession', token: EMP });
  assert.equal(s.ok, true);
  assert.equal(s.user.name, '小明');
  assert.equal(t.api({ action: 'checkSession', token: 'nope' }).ok, false);
  assert.equal(t.api({ action: 'getReviewRequest', token: EMP }).code, 'PERMISSION_DENIED');
  assert.equal(t.api({ action: 'getReviewRequest' }).code, 'ERR_SESSION_INVALID');
});

test('POST 表單與 GET 結果一致', () => {
  assert.equal(t.api({ action: 'checkSession', token: EMP }, 'POST').user.userId, 'Uemp');
});

test('GPS 打卡：範圍內成功、重複擋下、範圍外失敗', () => {
  const ok = t.api({ action: 'punch', token: EMP, type: '上班', lat: '25.0331', lng: '121.5655', note: 'test' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const dup = t.api({ action: 'punch', token: EMP, type: '上班', lat: '25.0331', lng: '121.5655' });
  assert.equal(dup.ok, false);
  const far = t.api({ action: 'punch', token: EMP, type: '下班', lat: '24.0', lng: '120.0' });
  assert.equal(far.ok, false);

  const rows = t.ss.getSheetByName('打卡紀錄').getDataRange().getValues();
  assert.equal(rows.length, 2, '只有一筆打卡');
  assert.ok(isDate(rows[1][0]));
  assert.equal(rows[1][1], 'Uemp');
  assert.equal(rows[1][6], '台北門市');
});

test('出勤明細：本人可查、查別人被擋、管理員可查全部', () => {
  const mine = t.api({ action: 'getAttendanceDetails', token: EMP, month, userId: 'Uemp' });
  assert.equal(mine.ok, true, JSON.stringify(mine).slice(0, 300));
  assert.ok(mine.records.length >= 1);
  assert.equal(t.api({ action: 'getAttendanceDetails', token: EMP, month, userId: 'Uadmin' }).code, 'PERMISSION_DENIED');
  assert.equal(t.api({ action: 'getAttendanceDetails', token: ADMIN, month }).ok, true);
});

test('補打卡：申請 → 管理員看到 → 核准', () => {
  const r = t.api({ action: 'adjustPunch', token: EMP, type: '下班', lat: '0', lng: '0', datetime: `${today}T18:00:00`, note: '忘記打卡' });
  assert.equal(r.ok, true, JSON.stringify(r));

  const list = t.api({ action: 'getReviewRequest', token: ADMIN });
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.reviewRequest.length, 1);
  const item = list.reviewRequest[0];

  const approved = t.api({ action: 'approveReview', token: ADMIN, id: item.id });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(t.api({ action: 'getReviewRequest', token: ADMIN }).reviewRequest.length, 0);
});

test('資料確實寫進資料庫（重新載入後還在）', () => {
  const again = t.reload();
  const rows = again.context.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('打卡紀錄').getDataRange().getValues();
  assert.ok(rows.length >= 2);
  assert.ok(isDate(rows[1][0]), '日期型別要保留');
});
