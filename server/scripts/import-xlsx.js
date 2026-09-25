// import-xlsx.js - 把 Google 試算表的資料匯進新後端
//
// 用法：
//   1. 在 Google 試算表選「檔案 → 下載 → Microsoft Excel (.xlsx)」
//   2. 先停掉服務（systemctl stop buono-backend），避免匯入時有人在打卡
//   3. node scripts/import-xlsx.js 下載的檔案.xlsx            （試跑：只列出會匯入什麼）
//      node scripts/import-xlsx.js 下載的檔案.xlsx --replace  （真的匯入：清掉現有資料再匯入）
//   4. 再啟動服務
//
// 型別照試算表原樣保留：文字就是文字、數字就是數字、日期就是日期，不再經過自動轉型。
// Excel 的日期沒有時區，這裡當成腳本時區（Asia/Taipei）的當地時間，跟試算表上看到的一樣。

'use strict';

const path = require('path');
const fs = require('fs');

process.env.TZ = process.env.TZ || 'Asia/Taipei';

const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const { encodeRow } = require('../src/values');

const file = process.argv[2];
const replace = process.argv.includes('--replace');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

if (!file || !fs.existsSync(file)) {
  console.error('用法：node scripts/import-xlsx.js <檔案.xlsx> [--replace]');
  process.exit(1);
}

// exceljs 把 Excel 日期當成 UTC；試算表上看到的其實是當地時間，換回來
function localDate(d) {
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

function cellValue(cell) {
  let v = cell.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return localDate(v);
  if (typeof v === 'object') {
    if ('result' in v) v = v.result;                              // 公式：取計算結果
    else if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
    else if ('text' in v) return String(v.text);                  // 超連結
    else if ('error' in v) return String(v.error);
    if (v instanceof Date) return localDate(v);
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return String(v);
  }
  return v;
}

(async () => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);

  const sheets = [];
  workbook.eachSheet(ws => {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values = [];
      for (let c = 1; c <= ws.columnCount; c++) values.push(cellValue(row.getCell(c)));
      rows[rowNumber - 1] = values;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    // 去掉最後面的空列
    while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
    sheets.push({ name: ws.name, rows });
  });

  console.log(`讀到 ${sheets.length} 張工作表：`);
  for (const s of sheets) console.log(`  ${s.name}：${Math.max(s.rows.length - 1, 0)} 筆（不含標題列）`);

  if (!replace) {
    console.log('\n這是試跑，沒有寫入任何資料。確認無誤後加上 --replace 再執行一次。');
    return;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, 'buono.sqlite');
  if (fs.existsSync(dbPath)) {
    const backup = `${dbPath}.before-import-${Date.now()}`;
    fs.copyFileSync(dbPath, backup);
    console.log('\n已備份現有資料庫：' + backup);
  }

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sheets (name TEXT PRIMARY KEY, position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sheet_rows (sheet TEXT NOT NULL, r INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (sheet, r));
  `);
  const putSheet = db.prepare('INSERT INTO sheets (name, position) VALUES (?, ?)');
  const putRow = db.prepare('INSERT INTO sheet_rows (sheet, r, data) VALUES (?, ?, ?)');

  db.transaction(() => {
    db.exec('DELETE FROM sheet_rows; DELETE FROM sheets;');
    sheets.forEach((s, pos) => {
      putSheet.run(s.name, pos);
      s.rows.forEach((row, r) => {
        const json = encodeRow(row);
        if (json !== '[]') putRow.run(s.name, r, json);
      });
    });
  })();
  db.close();

  console.log('匯入完成。');
  console.log('注意：Apps Script 的「指令碼屬性」（LINE 金鑰等）不在試算表裡，要另外用 scripts/properties.js 設定。');
})().catch(error => {
  console.error('匯入失敗：', error);
  process.exit(1);
});
