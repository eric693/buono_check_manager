// backup.js - 備份資料庫與附件
//
//   node scripts/backup.js            備份到 DATA_DIR/backups，保留最近 30 份
//   KEEP=60 node scripts/backup.js    保留份數
//
// 用 SQLite 的線上備份，服務運作中也能安全執行（不會備份到寫一半的資料）。
// 附件（DATA_DIR/drive）一起打包，還原時兩者要是同一時間點的。

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const KEEP = Math.max(1, +(process.env.KEEP || 30));
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

(async () => {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const workDir = path.join(BACKUP_DIR, `tmp-${stamp}`);
  fs.mkdirSync(workDir);

  const db = new Database(path.join(DATA_DIR, 'buono.sqlite'), { readonly: true, fileMustExist: true });
  await db.backup(path.join(workDir, 'buono.sqlite'));
  db.close();

  const archive = path.join(BACKUP_DIR, `buono-${stamp}.tar.gz`);
  const parts = ['-C', workDir, 'buono.sqlite'];
  if (fs.existsSync(path.join(DATA_DIR, 'drive'))) parts.push('-C', DATA_DIR, 'drive');
  const tar = spawnSync('tar', ['-czf', archive, ...parts]);
  fs.rmSync(workDir, { recursive: true, force: true });
  if (tar.status !== 0) throw new Error('打包失敗：' + tar.stderr);

  // 只留最近 KEEP 份
  const old = fs.readdirSync(BACKUP_DIR).filter(f => /^buono-\d{8}-\d{6}\.tar\.gz$/.test(f)).sort().reverse().slice(KEEP);
  old.forEach(f => fs.rmSync(path.join(BACKUP_DIR, f)));

  const size = (fs.statSync(archive).size / 1024).toFixed(0);
  console.log(`已備份：${archive}（${size} KB）${old.length ? `，刪除 ${old.length} 份舊備份` : ''}`);
})().catch(error => {
  console.error('備份失敗：', error);
  process.exit(1);
});
