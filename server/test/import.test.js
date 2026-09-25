// 從 Google 試算表下載的 .xlsx 匯入：型別要保留，匯入後的資料 GS 程式要能直接用
'use strict';

process.env.TZ = 'Asia/Taipei';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const { createRuntime } = require('../src/runtime');
const { buildEvent } = require('../src/server');
const { isDate } = require('../src/values');

// Excel 的日期沒有時區；Google 匯出的是試算表上看到的當地時間。exceljs 寫入時當 UTC，
// 所以要把「當地時間的數字」放進 UTC 欄位，才等於 Google 匯出的檔案
const excelDate = (y, m, d, h = 0, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi));

async function makeWorkbook(file) {
  const wb = new ExcelJS.Workbook();

  const emp = wb.addWorksheet('員工名單');
  emp.addRow(['userId', 'email', 'name', 'picture', '首次登入時間', '職位', '薪', '狀態', '手動設定姓名']);
  emp.addRow(['Uadmin', 'boss@example.com', '老闆', '', excelDate(2025, 1, 2, 9, 30), '管理員', '', '啟用', '']);
  emp.addRow(['Uemp', '', '小明LINE', '', excelDate(2025, 3, 1, 8, 0), '員工', '', '啟用', '王小明']);
  emp.getColumn(5).numFmt = 'yyyy-mm-dd hh:mm';

  const session = wb.addWorksheet('Session');
  session.addRow(['token', 'userId', '建立時間', 'expiredAt']);
  session.addRow(['tok-emp', 'Uemp', excelDate(2026, 9, 1), excelDate(2099, 1, 1)]);
  session.getColumn(3).numFmt = 'yyyy-mm-dd';
  session.getColumn(4).numFmt = 'yyyy-mm-dd';

  const att = wb.addWorksheet('打卡紀錄');
  att.addRow(['打卡時間', '打卡人員ＩＤ', '-', '打卡人員', '打卡類別', '打卡ＧＰＳ', '打卡地點', '備註', '管理員審核', '裝置']);
  att.addRow([excelDate(2026, 9, 1, 8, 55), 'Uemp', '員工', '小明LINE', '上班', '(25.03,121.56)', '台北門市', '', '', '']);
  att.getColumn(1).numFmt = 'yyyy-mm-dd hh:mm:ss';

  const loc = wb.addWorksheet('打卡地點表');
  loc.addRow(['地點代號', '地點名稱', 'GPS(緯度)', 'GPS(經度)', '容許誤差(公尺)']);
  loc.addRow(['L1', '台北門市', 25.033, 121.5654, { formula: '50*2', result: 100 }]);

  const info = wb.addWorksheet('員工基本資料');
  info.addRow(['員工ID', '姓名', '身分證字號', '地址', '電話', '生日', '建立時間', '更新時間']);
  info.addRow(['Uemp', '王小明', 'A123456789', '台北市', '0912345678', excelDate(1990, 5, 20), excelDate(2026, 1, 1), excelDate(2026, 1, 1)]);
  info.getColumn(6).numFmt = 'yyyy-mm-dd';

  const ot = wb.addWorksheet('加班申請');
  ot.addRow(['申請ID', '員工ID', '員工姓名', '加班日期', '開始時間', '結束時間']);
  // Google 的「時間」儲存格匯出成 1899-12-30 的時間
  ot.addRow(['OT1', 'Uemp', '王小明', excelDate(2026, 9, 1), excelDate(1899, 12, 30, 18, 0), excelDate(1899, 12, 30, 20, 30)]);
  ot.getColumn(4).numFmt = 'yyyy-mm-dd';
  ot.getColumn(5).numFmt = 'hh:mm';
  ot.getColumn(6).numFmt = 'hh:mm';

  await wb.xlsx.writeFile(file);
}

test('匯入 .xlsx：型別保留，GS 程式可以直接使用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buono-import-'));
  const file = path.join(dir, 'sheet.xlsx');
  await makeWorkbook(file);

  const script = path.join(__dirname, '..', 'scripts', 'import-xlsx.js');
  const env = Object.assign({}, process.env, { DATA_DIR: dir });

  const dry = spawnSync(process.execPath, [script, file], { env, encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /試跑/);
  assert.ok(!fs.existsSync(path.join(dir, 'buono.sqlite')), '試跑不能寫入');

  const real = spawnSync(process.execPath, [script, file, '--replace'], { env, encoding: 'utf8' });
  assert.equal(real.status, 0, real.stderr);

  const db = new Database(path.join(dir, 'buono.sqlite'));
  const runtime = createRuntime({ db, gsDir: path.join(__dirname, '..', '..', 'GS'), dataDir: dir,
    publicBaseUrl: 'https://x', frontendUrl: 'https://y/', log: () => {} });
  const { SpreadsheetApp, Utilities } = runtime.context;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const f = (v, p) => Utilities.formatDate(v, 'Asia/Taipei', p);

  const empRow = ss.getSheetByName('員工名單').getDataRange().getValues()[1];
  assert.ok(isDate(empRow[4]));
  assert.equal(f(empRow[4], 'yyyy-MM-dd HH:mm'), '2025-01-02 09:30', '日期時間要是當地時間');

  const phone = ss.getSheetByName('員工基本資料').getDataRange().getValues()[1][4];
  assert.equal(phone, '0912345678', '文字儲存格保持文字，前導零不能掉');
  assert.equal(f(ss.getSheetByName('員工基本資料').getDataRange().getValues()[1][5], 'yyyy-MM-dd'), '1990-05-20');

  assert.equal(ss.getSheetByName('打卡地點表').getDataRange().getValues()[1][4], 100, '公式取計算結果');

  const otRow = ss.getSheetByName('加班申請').getDataRange().getValues()[1];
  assert.equal(otRow[4].getFullYear(), 1899);
  assert.equal(f(otRow[4], 'HH:mm'), '18:00', '時間儲存格');
  assert.equal(f(otRow[5], 'HH:mm'), '20:30');

  // 匯入的登入狀態與資料，API 直接可用
  const api = q => JSON.parse(runtime.doGet(buildEvent(new URL('http://x/exec?' + new URLSearchParams(q)), 'GET', null, '')).getContent());
  const s = api({ action: 'checkSession', token: 'tok-emp' });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.user.name, '王小明', '手動設定的姓名優先');
  const att = api({ action: 'getAttendanceDetails', token: 'tok-emp', month: '2026-09', userId: 'Uemp' });
  assert.equal(att.ok, true, JSON.stringify(att).slice(0, 300));
  assert.ok(JSON.stringify(att).includes('08:55'), '匯入的打卡時間要正確：' + JSON.stringify(att).slice(0, 300));

  // 再匯一次會先備份
  const again = spawnSync(process.execPath, [script, file, '--replace'], { env, encoding: 'utf8' });
  assert.equal(again.status, 0, again.stderr);
  assert.ok(fs.readdirSync(dir).some(n => n.startsWith('buono.sqlite.before-import-')), '重新匯入前要備份');
  db.close();
});
