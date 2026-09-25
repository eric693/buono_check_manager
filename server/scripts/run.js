// run.js - 執行某一支 GS 函式（取代 Apps Script 編輯器的「執行」按鈕）
//
//   node scripts/run.js setupLeaveSystemDatabase
//   node scripts/run.js batchFillHireDateFromCreated
//   node scripts/run.js 函式名稱 '["參數1", 2]'      參數用 JSON 陣列
//
// 會直接改到資料庫，先停掉服務再執行（systemctl stop buono-backend），避免兩邊同時寫入。
// Logger.log 的輸出會印在畫面上。

'use strict';

const path = require('path');
const fs = require('fs');

process.env.TZ = process.env.TZ || 'Asia/Taipei';

const Database = require('better-sqlite3');
const { createRuntime } = require('../src/runtime');
const { ensureCoreSheets } = require('../src/bootstrap');

const [fnName, argsJson] = process.argv.slice(2);
if (!fnName) {
  console.error('用法：node scripts/run.js <函式名稱> [JSON 參數陣列]');
  process.exit(1);
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'buono.sqlite'));

const runtime = createRuntime({
  db,
  gsDir: path.join(__dirname, '..', '..', 'GS'),
  dataDir: DATA_DIR,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  frontendUrl: process.env.FRONTEND_URL || '',
  log: line => console.log(line)
});

ensureCoreSheets(runtime);

if (typeof runtime.context[fnName] !== 'function') {
  console.error(`GS 程式裡沒有 ${fnName}()`);
  process.exit(1);
}

let args = [];
if (argsJson) {
  try {
    args = JSON.parse(argsJson);
    if (!Array.isArray(args)) throw new Error('要是陣列');
  } catch (error) {
    console.error('參數要是 JSON 陣列，例如 \'["2026-09"]\'：' + error.message);
    process.exit(1);
  }
}

try {
  const result = runtime.run(fnName, ...args);
  if (result !== undefined) {
    const text = result && result.getContent ? result.getContent() : JSON.stringify(result, null, 2);
    console.log('\n回傳值：\n' + text);
  }
} finally {
  db.close();
}
