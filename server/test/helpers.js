// 測試共用：用暫存資料庫建一個完整的相容層，放入測試員工與登入狀態
'use strict';

process.env.TZ = 'Asia/Taipei';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createRuntime } = require('../src/runtime');
const { ensureCoreSheets } = require('../src/bootstrap');
const { buildEvent } = require('../src/server');

const GS_DIR = path.join(__dirname, '..', '..', 'GS');

function makeRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buono-test-'));
  const db = new Database(path.join(dir, 'test.sqlite'));
  const logs = [];
  const runtime = createRuntime({
    db, gsDir: GS_DIR, dataDir: dir,
    publicBaseUrl: 'https://buono.example', frontendUrl: 'https://front.example/',
    log: line => logs.push(line)
  });
  ensureCoreSheets(runtime);

  // 不打真的外部 API：記錄下來，回一個成功的空回應
  const fetches = [];
  runtime.context.UrlFetchApp = {
    fetch(url, params) {
      fetches.push({ url, params: params || {} });
      return {
        getResponseCode: () => 200,
        getContentText: () => '{}',
        getContent: () => [],
        getHeaders: () => ({}),
        getBlob: () => runtime.context.Utilities.newBlob('')
      };
    }
  };

  const ss = runtime.context.SpreadsheetApp.getActiveSpreadsheet();

  function addEmployee(userId, name, dept) {
    ss.getSheetByName('員工名單').appendRow([userId, '', name, '', new Date(), dept, '', '啟用', '']);
    const token = 'tok-' + userId;
    ss.getSheetByName('Session').appendRow([token, userId, new Date(), new Date(Date.now() + 86400000)]);
    runtime.store.flush();
    return token;
  }

  function api(params, method = 'GET') {
    const qs = new URLSearchParams(params).toString();
    let out;
    if (method === 'POST') {
      const body = Buffer.from(qs);
      out = runtime.doPost(buildEvent(new URL('http://x/exec'), 'POST', body, 'application/x-www-form-urlencoded'));
    } else {
      out = runtime.doGet(buildEvent(new URL('http://x/exec?' + qs), 'GET', null, ''));
    }
    const text = out.getContent();
    try { return JSON.parse(text); } catch (e) { return { raw: text }; }
  }

  // 重新從資料庫載入一次，確認資料真的寫進去了（不是只在記憶體裡）
  function reload() {
    return createRuntime({
      db, gsDir: GS_DIR, dataDir: dir,
      publicBaseUrl: 'https://buono.example', frontendUrl: 'https://front.example/', log: () => {}
    });
  }

  return { runtime, db, dir, ss, api, addEmployee, fetches, logs, reload };
}

module.exports = { makeRuntime };
