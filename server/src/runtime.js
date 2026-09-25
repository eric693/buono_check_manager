// runtime.js
//
// 把 GS/*.gs 載進一個 vm 環境執行，就像 Apps Script 那樣：所有檔案共用同一個全域範圍，
// 某個檔案的 const 其他檔案也看得到；同名 const 宣告兩次會直接報錯（Apps Script 也是）。
//
// Tests.gs 是手動執行的測試與除錯函式，不在任何 API 路徑上，不載入。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const { Store, createSpreadsheetApp } = require('./spreadsheet');
const { encodeRow } = require('./values');
const services = require('./services');

// 先載 Constants，其他檔案在載入時就會用到裡面的常數；其餘照檔名排序
const LOAD_FIRST = ['Constants.gs'];
const SKIP = new Set(['Tests.gs']);

function listGsFiles(gsDir) {
  const files = fs.readdirSync(gsDir).filter(f => f.endsWith('.gs') && !SKIP.has(f)).sort();
  return [...LOAD_FIRST.filter(f => files.includes(f)), ...files.filter(f => !LOAD_FIRST.includes(f))];
}

/**
 * @param {Object} options
 * @param {import('better-sqlite3').Database} options.db
 * @param {string} options.gsDir      GS 程式所在資料夾
 * @param {string} options.dataDir    附件等檔案的存放位置
 * @param {string} options.publicBaseUrl  對外網址（檔案下載連結用）
 * @param {string} options.frontendUrl
 * @param {Function} [options.log]
 */
function createRuntime(options) {
  const { db, gsDir, dataDir, publicBaseUrl, frontendUrl } = options;
  const log = options.log || (line => console.log(line));

  const DriveApp = services.createDriveApp(db, dataDir, publicBaseUrl);

  const context = {
    console: { log: (...a) => log(a.join(' ')), info: (...a) => log(a.join(' ')), warn: (...a) => log(a.join(' ')), error: (...a) => log(a.join(' ')) },
    Utilities: services.createUtilities(),
    Session: services.createSession(),
    PropertiesService: services.createPropertiesService(db),
    CacheService: services.createCacheService(),
    LockService: services.createLockService(),
    ContentService: services.createContentService(),
    HtmlService: services.createHtmlService(frontendUrl),
    UrlFetchApp: services.createUrlFetchApp(),
    DriveApp,
    Logger: services.createLogger(log),
    ScriptApp: {
      getOAuthToken() { throw new Error('相容層沒有 Google OAuth 權杖（只有 Google 雲端的設定工具會用到）'); },
      getService: () => ({ getUrl: () => publicBaseUrl + '/exec' })
    },
    setTimeout, clearTimeout
  };
  context.globalThis = context;
  vm.createContext(context, { name: 'gas' });

  // 試算表讀出來的日期要用 vm 裡的 Date 建立，GS 的 instanceof Date 才會成立
  const VmDate = vm.runInContext('Date', context);
  const store = new Store(db, VmDate);

  // SpreadsheetApp.create() 建的暫存試算表（只有匯出 Excel 用），轉成 .xlsx 後就丟掉
  const tempSpreadsheets = new Map();
  context.SpreadsheetApp = createSpreadsheetApp(store, {
    createTemp(name) {
      const id = 'tmp_' + crypto.randomBytes(12).toString('hex');
      const temp = new Store(new Database(':memory:'), VmDate, { id, name });
      temp.createSheet('工作表1');
      tempSpreadsheets.set(id, temp);
      return temp;
    }
  });

  for (const file of listGsFiles(gsDir)) {
    const source = fs.readFileSync(path.join(gsDir, file), 'utf8');
    try {
      vm.runInContext(source, context, { filename: file });
    } catch (error) {
      // 跟 Apps Script 一樣：任何一個檔案有語法錯誤，整個後端都不能用，所以啟動時就停下來
      error.message = `載入 ${file} 失敗：${error.message}`;
      throw error;
    }
  }
  // 匯出 Excel：原本是把 Google 試算表設成公開、回傳 Google 的下載網址（SalaryManagement.gs）。
  // 這裡改成把暫存試算表寫成 .xlsx 存進本機雲端硬碟，回傳這台伺服器的下載網址。
  context.getSpreadsheetExportUrl_ = function (spreadsheet) {
    const temp = tempSpreadsheets.get(spreadsheet.getId());
    if (!temp) throw new Error('找不到要匯出的試算表：' + spreadsheet.getId());
    tempSpreadsheets.delete(spreadsheet.getId());
    const sheets = [...temp.sheets.values()].map(sheet => ({
      name: sheet.name,
      rows: sheet.rows.map(row => JSON.parse(encodeRow(row || [])))
    }));
    temp.db.close();

    const tmpFile = path.join(os.tmpdir(), `export-${crypto.randomBytes(8).toString('hex')}.xlsx`);
    const result = spawnSync(process.execPath, [path.join(__dirname, 'xlsx-writer.js')], {
      input: JSON.stringify({ file: tmpFile, sheets }),
      env: process.env,
      maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0) {
      throw new Error('產生 Excel 失敗：' + String(result.stderr || result.error || '').slice(0, 300));
    }
    try {
      const blob = context.Utilities.newBlob(fs.readFileSync(tmpFile),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', temp.meta.name + '.xlsx');
      return DriveApp.createFile(blob).getUrl();
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  };

  // 載入時如果有寫入（例如建立工作表），也寫回去
  store.flush();

  function call(fnName, e) {
    const fn = context[fnName];
    if (typeof fn !== 'function') throw new Error(`GS 程式裡沒有 ${fnName}()`);
    try {
      return fn(e);
    } finally {
      // 就算中途丟錯，已經寫進去的資料也要保留（Apps Script 也不會回滾）
      store.flush();
    }
  }

  return {
    context,
    store,
    DriveApp,
    doGet: e => call('doGet', e),
    doPost: e => call('doPost', e),
    /** 執行任意 GS 函式（管理工具、測試用） */
    run(fnName, ...args) {
      try {
        return context[fnName](...args);
      } finally {
        store.flush();
      }
    }
  };
}

module.exports = { createRuntime, listGsFiles };
