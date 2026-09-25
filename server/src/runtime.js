// runtime.js
//
// 把 GS/*.gs 載進一個 vm 環境執行，就像 Apps Script 那樣：所有檔案共用同一個全域範圍，
// 某個檔案的 const 其他檔案也看得到；同名 const 宣告兩次會直接報錯（Apps Script 也是）。
//
// Tests.gs 是手動執行的測試與除錯函式，不在任何 API 路徑上，不載入。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { Store, createSpreadsheetApp } = require('./spreadsheet');
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
  const store = new Store(db, vm.runInContext('Date', context));
  context.SpreadsheetApp = createSpreadsheetApp(store);

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
