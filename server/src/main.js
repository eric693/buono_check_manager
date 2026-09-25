// main.js - 啟動點
//
// 環境變數（也可以寫在 server/.env）：
//   PORT            監聽埠號，預設 8040（只綁 127.0.0.1，由 nginx 對外）
//   DATA_DIR        資料庫與檔案的位置，預設 server/data
//   PUBLIC_BASE_URL 對外網址，例如 https://buono.crownai.ink
//   FRONTEND_URL    前端網址，預設 https://eric693.github.io/buono_check_manager/
//   TZ              腳本時區，預設 Asia/Taipei（Apps Script 專案的時區）

'use strict';

const fs = require('fs');
const path = require('path');

// .env：簡單的 KEY=VALUE，不另外裝套件
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// 時區一定要在建立任何 Date 之前設定
process.env.TZ = process.env.TZ || 'Asia/Taipei';

const Database = require('better-sqlite3');
const { createRuntime } = require('./runtime');
const { createServer } = require('./server');
const { ensureCoreSheets } = require('./bootstrap');
const pidlock = require('./pidlock');

const PORT = +(process.env.PORT || 8040);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://eric693.github.io/buono_check_manager/';

fs.mkdirSync(DATA_DIR, { recursive: true });
pidlock.acquire(DATA_DIR);

const db = new Database(path.join(DATA_DIR, 'buono.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

const log = line => console.log(`[${new Date().toISOString()}] ${line}`);

const runtime = createRuntime({
  db,
  gsDir: path.join(__dirname, '..', '..', 'GS'),
  dataDir: DATA_DIR,
  publicBaseUrl: PUBLIC_BASE_URL,
  frontendUrl: FRONTEND_URL,
  log
});

const created = ensureCoreSheets(runtime);
if (created.length) log('已建立核心工作表：' + created.join('、'));

createServer(runtime, { log }).listen(PORT, HOST, () => {
  log(`出勤管家後端已啟動：http://${HOST}:${PORT}（資料：${DATA_DIR}）`);
});

const shutdown = () => { try { runtime.store.flush(); db.close(); } finally { process.exit(0); } };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
