// pidlock.js
//
// 服務運作時整份資料都在記憶體裡，每個請求結束只寫回改過的列。
// 這時如果另外有人用 import-xlsx.js 或 run.js 改資料庫，服務手上的是舊資料，
// 之後寫回會跟新資料混在一起。所以服務啟動時留下 PID 檔，工具看到服務還在跑就拒絕。

'use strict';

const fs = require('fs');
const path = require('path');

const pidFile = dataDir => path.join(dataDir, 'server.pid');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** 服務啟動時呼叫；同一份資料已經有服務在跑就丟錯 */
function acquire(dataDir) {
  const file = pidFile(dataDir);
  const running = runningPid(dataDir);
  if (running && running !== process.pid) {
    throw new Error(`這份資料（${dataDir}）已經有服務在運作（PID ${running}），不能再開一個`);
  }
  fs.writeFileSync(file, String(process.pid));
  const release = () => {
    try { if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.rmSync(file); } catch (error) { /* 已經不在 */ }
  };
  process.on('exit', release);
  return release;
}

/** 還在運作的服務 PID；沒有就回傳 0 */
function runningPid(dataDir) {
  try {
    const pid = Number(fs.readFileSync(pidFile(dataDir), 'utf8'));
    return pid && isAlive(pid) ? pid : 0;
  } catch (error) {
    return 0;
  }
}

/** 給會直接改資料庫的工具用：服務在跑就結束程式 */
function refuseIfRunning(dataDir, toolName) {
  const pid = runningPid(dataDir);
  if (!pid) return;
  console.error(`服務正在運作（PID ${pid}），${toolName} 會直接改資料庫，服務手上的資料會跟著亂掉。`);
  console.error('請先停止服務（例如 systemctl stop buono@staging），完成後再啟動。');
  process.exit(2);
}

module.exports = { acquire, runningPid, refuseIfRunning };
