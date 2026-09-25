// properties.js - 管理「指令碼屬性」（Apps Script 的 PropertiesService）
//
// LINE 的金鑰等設定在 Apps Script 是放在「專案設定 → 指令碼屬性」，搬過來要重新設定一次。
// 設定完要重啟服務（Constants.gs 在啟動時就把 LINE_CHANNEL_ID 等讀進常數）。
//
//   node scripts/properties.js list                 列出所有屬性（值會遮蔽）
//   node scripts/properties.js set KEY VALUE        設定
//   node scripts/properties.js delete KEY           刪除
//
// 需要的屬性：LINE_CHANNEL_ID、LINE_CHANNEL_SECRET（LINE Login channel）、
//            LINE_CHANNEL_ACCESS_TOKEN（Messaging API channel）、
//            LINE_MESSAGING_CHANNEL_SECRET（Messaging API channel 的 secret，用來驗證 webhook 簽章）、
//            RICH_MENU_ID（選填）

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'buono.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS script_properties (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const [cmd, key, ...rest] = process.argv.slice(2);
const mask = v => (v.length <= 8 ? '****' : v.slice(0, 4) + '…' + v.slice(-4) + `（${v.length} 字元）`);

if (cmd === 'list') {
  const rows = db.prepare('SELECT key, value FROM script_properties ORDER BY key').all();
  // LPT_ 是 LINE 打卡的一次性連結，數量多又會自己過期，不列出來
  const shown = rows.filter(r => !r.key.startsWith('LPT_'));
  if (!shown.length) console.log('（沒有任何屬性）');
  for (const r of shown) console.log(`${r.key} = ${mask(r.value)}`);
  const lpt = rows.length - shown.length;
  if (lpt) console.log(`（另有 ${lpt} 筆 LINE 打卡一次性連結）`);
} else if (cmd === 'set' && key && rest.length) {
  db.prepare('INSERT OR REPLACE INTO script_properties (key, value) VALUES (?, ?)').run(key, rest.join(' '));
  console.log(`已設定 ${key}。記得重啟服務才會生效。`);
} else if (cmd === 'delete' && key) {
  db.prepare('DELETE FROM script_properties WHERE key = ?').run(key);
  console.log(`已刪除 ${key}。`);
} else {
  console.log('用法：node scripts/properties.js list | set KEY VALUE | delete KEY');
  process.exitCode = 1;
}
db.close();
