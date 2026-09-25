// xlsx-writer.js
//
// 把試算表資料寫成 .xlsx。
//
// GS 程式是同步的，但 exceljs 寫檔是非同步的，所以這支以子行程執行：
// 主行程用 spawnSync 把資料從 stdin 傳進來，這裡寫完檔再結束。
//
// stdin：{ "file": "輸出路徑", "sheets": [{ "name": "...", "rows": [[...]] }] }
// 日期以 { "$d": 毫秒 } 傳入，寫成 Excel 的日期（當地時間，跟試算表上看到的一樣）。

'use strict';

process.env.TZ = process.env.TZ || 'Asia/Taipei';

const ExcelJS = require('exceljs');

function toExcel(value) {
  if (value && typeof value === 'object' && '$d' in value) {
    // exceljs 把 Date 當 UTC 寫入；要讓 Excel 顯示當地時間，把當地時間的數字當成 UTC
    const d = new Date(value.$d);
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
  }
  return value;
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { file, sheets } = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31));
    sheet.rows.forEach(row => ws.addRow(row.map(toExcel)));

    if (sheet.rows.length) {
      // 第一列當標題：粗體、凍結
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
      ws.columns.forEach((col, i) => {
        let width = 8;
        for (const row of sheet.rows) {
          const v = row[i];
          const text = v && typeof v === 'object' ? '2026-01-01 00:00' : String(v === undefined ? '' : v);
          // 中文字算兩格寬
          width = Math.max(width, [...text].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0) + 2);
        }
        col.width = Math.min(width, 40);
        if (sheet.rows.some(row => row[i] && typeof row[i] === 'object')) col.numFmt = 'yyyy-mm-dd hh:mm';
      });
    }
  }
  await workbook.xlsx.writeFile(file);
}

main().catch(error => {
  process.stderr.write(String(error.stack || error));
  process.exit(1);
});
