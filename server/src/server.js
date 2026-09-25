// server.js
//
// 取代 Apps Script 網頁應用程式的 HTTP 伺服器。
//
// 把 HTTP 請求轉成 Apps Script 的事件物件 e（parameter / parameters / postData），
// 交給 GS 程式的 doGet / doPost，再把 ContentService 的輸出送回去。
// 前端只要把 config.js 的 apiUrl 換成這台伺服器的網址（/exec），其他都不用改。
//
// 其他路徑：
//   GET /healthz          健康檢查
//   GET /files/<id>/<名>  下載 DriveApp 存的檔案（匯出的 Excel）；ID 是 128 位元亂數

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const MAX_BODY_BYTES = 12 * 1024 * 1024; // 附件上限 3 MB，base64 後約 4 MB，留足空間

function parseQuery(search) {
  const parameter = {};
  const parameters = {};
  for (const [k, v] of new URLSearchParams(search)) {
    if (!(k in parameter)) parameter[k] = v;
    (parameters[k] = parameters[k] || []).push(v);
  }
  return { parameter, parameters };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('請求內容太大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 組出跟 Apps Script 一樣的 e 物件 */
function buildEvent(url, method, body, contentType) {
  const query = parseQuery(url.search);
  const e = {
    parameter: query.parameter,
    parameters: query.parameters,
    queryString: url.search.replace(/^\?/, ''),
    contextPath: '',
    contentLength: body ? body.length : -1
  };
  if (method === 'POST') {
    const contents = body ? body.toString('utf8') : '';
    const type = (contentType || '').split(';')[0].trim();
    e.postData = { contents, length: body ? body.length : 0, type, name: 'postData' };
    // 表單送出的欄位，Apps Script 也會放進 parameter
    if (type === 'application/x-www-form-urlencoded') {
      const form = parseQuery(contents);
      for (const [k, v] of Object.entries(form.parameter)) if (!(k in e.parameter)) e.parameter[k] = v;
      for (const [k, list] of Object.entries(form.parameters)) e.parameters[k] = (e.parameters[k] || []).concat(list);
    }
  }
  return e;
}

/**
 * LINE webhook 簽章驗證。
 *
 * Apps Script 讀不到 HTTP 標頭，所以原本完全沒驗證：任何人知道網址就能冒用員工送假訊息
 * （例如假的位置訊息幫別人打卡）。這裡用 Messaging API channel 的 secret 驗證
 * X-Line-Signature。還沒設定 LINE_MESSAGING_CHANNEL_SECRET 時照舊放行，只記警告。
 *
 * @returns {'ok'|'invalid'|'unconfigured'}
 */
function verifyLineSignature(runtime, body, signature) {
  const secret = runtime.context.PropertiesService.getScriptProperties().getProperty('LINE_MESSAGING_CHANNEL_SECRET');
  if (!secret) return 'unconfigured';
  if (!signature) return 'invalid';
  const expected = crypto.createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(String(signature), 'base64');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected) ? 'ok' : 'invalid';
}

function send(res, status, body, type) {
  res.writeHead(status, {
    'Content-Type': type,
    // Apps Script 網頁應用程式對任何來源都開放；前端在 GitHub Pages，照樣開放
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function createServer(runtime, options = {}) {
  const log = options.log || (line => console.log(line));

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        });
        res.end();
        return;
      }

      if (url.pathname === '/healthz') {
        send(res, 200, JSON.stringify({ ok: true }), 'application/json');
        return;
      }

      const fileMatch = url.pathname.match(/^\/files\/([0-9a-f]{32})(?:\/.*)?$/);
      if (fileMatch && req.method === 'GET') {
        const file = runtime.DriveApp.__readFile(fileMatch[1]);
        if (!file || !fs.existsSync(file.path)) { send(res, 404, 'Not found', 'text/plain'); return; }
        res.writeHead(200, {
          'Content-Type': file.mime || 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          'Cache-Control': 'private, no-store'
        });
        fs.createReadStream(file.path).pipe(res);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'POST') {
        send(res, 405, 'Method not allowed', 'text/plain');
        return;
      }

      const body = req.method === 'POST' ? await readBody(req) : null;

      // LINE webhook：JSON 主體，帶 X-Line-Signature 標頭
      const isLineWebhook = req.method === 'POST' &&
        (req.headers['x-line-signature'] !== undefined || /application\/json/.test(req.headers['content-type'] || ''));
      if (isLineWebhook) {
        const verdict = verifyLineSignature(runtime, body, req.headers['x-line-signature']);
        if (verdict === 'invalid') {
          log('拒絕簽章不符的 LINE webhook');
          send(res, 401, JSON.stringify({ status: 'error', message: 'invalid signature' }), 'application/json');
          return;
        }
        if (verdict === 'unconfigured') log('警告：還沒設定 LINE_MESSAGING_CHANNEL_SECRET，LINE webhook 沒有驗證簽章');
      }

      const e = buildEvent(url, req.method, body, req.headers['content-type']);
      const output = req.method === 'POST' ? runtime.doPost(e) : runtime.doGet(e);

      if (output && output.__output) {
        const mime = output.getMimeType() || 'text/plain';
        send(res, 200, output.getContent(), mime + '; charset=utf-8');
      } else {
        send(res, 200, JSON.stringify(output === undefined ? null : output), 'application/json; charset=utf-8');
      }

      log(`${req.method} ${e.parameter.action || url.pathname} ${Date.now() - started}ms`);
    } catch (error) {
      log(`${req.method} ${url.pathname} 錯誤: ${error.stack || error}`);
      // 前端看到的是 JSON 錯誤而不是 HTML 錯誤頁，才能顯示訊息而不是「連線失敗」
      send(res, error.status || 500, JSON.stringify({ ok: false, code: 'SERVER_ERROR', msg: String(error.message || error) }),
        'application/json; charset=utf-8');
    }
  });
}

module.exports = { createServer, buildEvent, verifyLineSignature };
