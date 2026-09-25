// services.js
//
// SpreadsheetApp 以外的 Apps Script 服務：Utilities、Session、PropertiesService、
// CacheService、LockService、ContentService、HtmlService、UrlFetchApp、DriveApp、Logger。
//
// 只實作 GS 程式實際用到的部分；用到沒實作的方法會丟出清楚的錯誤，方便補齊。

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------- 位元組（Apps Script 的 Byte[] 是 -128～127 的數字陣列） ----------------

function toSignedBytes(buf) {
  return Array.from(buf, b => (b > 127 ? b - 256 : b));
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.from(data.map(b => (b + 256) % 256));
  return Buffer.from(String(data), 'utf8');
}

// ---------------- Utilities.formatDate（Java SimpleDateFormat 的常用子集） ----------------

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

const partsFormatters = new Map();

function normalizeTimeZone(tz) {
  const zone = String(tz || process.env.TZ);
  // Apps Script 也接受 "GMT+8" 這種寫法
  const m = zone.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (m && !m[3]) return `Etc/GMT${m[1] === '+' ? '-' : '+'}${+m[2]}`;
  return zone;
}

function zonedParts(date, tz) {
  const zone = normalizeTimeZone(tz);

  // 最常見的情況：要的就是伺服器本身的時區（腳本時區）。直接用 Date 的本地時間欄位，
  // 比 Intl 快幾十倍 —— 打卡前檢查重複時，會對整張打卡表每一列都格式化一次日期。
  if (zone === process.env.TZ) {
    return {
      y: date.getFullYear(), mo: date.getMonth() + 1, d: date.getDate(),
      h: date.getHours(), mi: date.getMinutes(), s: date.getSeconds(), ms: date.getMilliseconds(),
      wd: date.getDay(), offset: -date.getTimezoneOffset(), zone
    };
  }

  let fmt = partsFormatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short'
    });
    partsFormatters.set(zone, fmt);
  }
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const y = +p.year, mo = +p.month, d = +p.day, h = +p.hour % 24, mi = +p.minute, s = +p.second;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  // 這個時區相對 UTC 的偏移（分鐘）
  const offset = Math.round((Date.UTC(y, mo - 1, d, h, mi, s) - (date.getTime() - date.getMilliseconds())) / 60000);
  return { y, mo, d, h, mi, s, ms: date.getMilliseconds(), wd, offset, zone };
}

function formatDate(date, tz, pattern) {
  let d = date;
  // GS 的 Date 來自 vm，跟這裡的 Date 不是同一個建構子，不能用 instanceof
  if (Object.prototype.toString.call(d) !== '[object Date]') d = new Date(d);
  if (isNaN(d.getTime())) throw new Error('Utilities.formatDate 收到無效的日期：' + date);

  const p = zonedParts(d, tz);
  const pad = (n, w) => String(n).padStart(w, '0');
  const offsetStr = colon => {
    const sign = p.offset >= 0 ? '+' : '-';
    const abs = Math.abs(p.offset);
    return sign + pad(Math.floor(abs / 60), 2) + (colon ? ':' : '') + pad(abs % 60, 2);
  };

  let out = '';
  const src = String(pattern);
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    if (ch === "'") {
      // '' 是單引號本身；'文字' 原樣輸出
      if (src[i + 1] === "'") { out += "'"; i += 2; continue; }
      const end = src.indexOf("'", i + 1);
      out += src.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (!/[A-Za-z]/.test(ch)) { out += ch; i++; continue; }
    let n = 1;
    while (src[i + n] === ch) n++;
    i += n;
    switch (ch) {
      case 'y': out += n === 2 ? pad(p.y % 100, 2) : pad(p.y, Math.max(n, 1)); break;
      case 'M': out += n >= 4 ? MONTHS[p.mo - 1] : n === 3 ? MONTHS[p.mo - 1].slice(0, 3) : pad(p.mo, n); break;
      case 'd': out += pad(p.d, n); break;
      case 'H': out += pad(p.h, n); break;
      case 'k': out += pad(p.h === 0 ? 24 : p.h, n); break;
      case 'h': out += pad(p.h % 12 === 0 ? 12 : p.h % 12, n); break;
      case 'K': out += pad(p.h % 12, n); break;
      case 'm': out += pad(p.mi, n); break;
      case 's': out += pad(p.s, n); break;
      case 'S': out += pad(p.ms, 3).slice(0, Math.max(n, 3)).padEnd(n, '0'); break;
      case 'a': out += p.h < 12 ? 'AM' : 'PM'; break;
      case 'E': out += n >= 4 ? WEEKDAYS[p.wd] : WEEKDAYS[p.wd].slice(0, 3); break;
      case 'u': out += String(p.wd === 0 ? 7 : p.wd); break;
      case 'Z': out += offsetStr(false); break;
      case 'X': out += n === 1 ? offsetStr(false).slice(0, 3) : offsetStr(n >= 3); break;
      case 'z': out += n >= 4 ? p.zone : 'GMT' + offsetStr(true); break;
      default: throw new Error(`Utilities.formatDate 尚未支援格式字元「${ch}」（${pattern}）`);
    }
  }
  return out;
}

// ---------------- Blob ----------------

function makeBlob(data, contentType, name) {
  let buf = toBuffer(data === undefined ? '' : data);
  let type = contentType || null;
  let blobName = name || null;
  const blob = {
    getBytes: () => toSignedBytes(buf),
    getBuffer_: () => buf,
    getDataAsString: charset => buf.toString(charset && /big5/i.test(charset) ? 'latin1' : 'utf8'),
    setDataFromString(s) { buf = Buffer.from(String(s), 'utf8'); return blob; },
    setBytes(bytes) { buf = toBuffer(bytes); return blob; },
    getContentType: () => type,
    setContentType(t) { type = t; return blob; },
    getName: () => blobName,
    setName(n) { blobName = n; return blob; },
    copyBlob: () => makeBlob(Buffer.from(buf), type, blobName),
    getBlob: () => blob,
    getAs(t) { return makeBlob(Buffer.from(buf), t, blobName); },
    isGoogleType: () => false
  };
  return blob;
}

function createUtilities() {
  return {
    formatDate,
    getUuid: () => crypto.randomUUID(),
    sleep: ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, +ms || 0)); },
    base64Encode: data => toBuffer(data).toString('base64'),
    base64EncodeWebSafe: data => toBuffer(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: s => toSignedBytes(Buffer.from(String(s), 'base64')),
    base64DecodeWebSafe: s => toSignedBytes(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    computeHmacSha256Signature: (value, key) =>
      toSignedBytes(crypto.createHmac('sha256', toBuffer(key)).update(toBuffer(value)).digest()),
    computeDigest: (algorithm, value) =>
      toSignedBytes(crypto.createHash(algorithm).update(toBuffer(value)).digest()),
    DigestAlgorithm: { MD2: 'md2', MD5: 'md5', SHA_1: 'sha1', SHA_256: 'sha256', SHA_384: 'sha384', SHA_512: 'sha512' },
    Charset: { UTF_8: 'UTF-8', US_ASCII: 'US-ASCII' },
    newBlob: (data, contentType, name) => makeBlob(data, contentType, name),
    jsonStringify: v => JSON.stringify(v),
    jsonParse: s => JSON.parse(s)
  };
}

// ---------------- PropertiesService（存在 SQLite） ----------------

function createPropertiesService(db) {
  db.exec('CREATE TABLE IF NOT EXISTS script_properties (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const get = db.prepare('SELECT value FROM script_properties WHERE key = ?');
  const put = db.prepare('INSERT OR REPLACE INTO script_properties (key, value) VALUES (?, ?)');
  const del = db.prepare('DELETE FROM script_properties WHERE key = ?');
  const all = db.prepare('SELECT key, value FROM script_properties');

  const store = {
    getProperty: key => { const row = get.get(String(key)); return row ? row.value : null; },
    setProperty(key, value) { put.run(String(key), String(value)); return store; },
    setProperties(obj, deleteAllOthers) {
      db.transaction(() => {
        if (deleteAllOthers) db.exec('DELETE FROM script_properties');
        for (const [k, v] of Object.entries(obj || {})) put.run(String(k), String(v));
      })();
      return store;
    },
    deleteProperty(key) { del.run(String(key)); return store; },
    deleteAllProperties() { db.exec('DELETE FROM script_properties'); return store; },
    getProperties: () => Object.fromEntries(all.all().map(r => [r.key, r.value])),
    getKeys: () => all.all().map(r => r.key)
  };
  return {
    getScriptProperties: () => store,
    getUserProperties: () => store,
    getDocumentProperties: () => store
  };
}

// ---------------- CacheService（記憶體，重啟就清空，跟 Apps Script 的快取一樣不保證保留） ----------------

function createCacheService() {
  const map = new Map();
  const alive = key => {
    const item = map.get(key);
    if (!item) return null;
    if (item.expires < Date.now()) { map.delete(key); return null; }
    return item.value;
  };
  const cache = {
    get: key => alive(String(key)),
    getAll: keys => Object.fromEntries(keys.map(k => [k, alive(String(k))]).filter(([, v]) => v !== null)),
    put(key, value, seconds) {
      const ttl = Math.min(Math.max(+seconds || 600, 1), 21600);
      map.set(String(key), { value: String(value), expires: Date.now() + ttl * 1000 });
    },
    putAll(obj, seconds) { for (const [k, v] of Object.entries(obj)) cache.put(k, v, seconds); },
    remove: key => { map.delete(String(key)); },
    removeAll: keys => { keys.forEach(k => map.delete(String(k))); }
  };
  return { getScriptCache: () => cache, getUserCache: () => cache, getDocumentCache: () => cache };
}

// ---------------- LockService（單一行程依序處理請求，本來就不會同時執行） ----------------

function createLockService() {
  const lock = { waitLock() {}, tryLock: () => true, releaseLock() {}, hasLock: () => true };
  return { getScriptLock: () => lock, getUserLock: () => lock, getDocumentLock: () => lock };
}

// ---------------- ContentService / HtmlService ----------------

const MIME = {
  JSON: 'application/json', JAVASCRIPT: 'application/javascript', TEXT: 'text/plain',
  CSV: 'text/csv', XML: 'text/xml', ICAL: 'text/calendar', RSS: 'application/rss+xml',
  ATOM: 'application/atom+xml', VCARD: 'text/vcard'
};

function createContentService() {
  return {
    MimeType: MIME,
    createTextOutput(content) {
      let text = content === undefined ? '' : String(content);
      let mime = MIME.TEXT;
      const out = {
        __output: true,
        getContent: () => text,
        setContent(c) { text = String(c); return out; },
        append(c) { text += String(c); return out; },
        getMimeType: () => mime,
        setMimeType(m) { mime = m; return out; },
        downloadAsFile() { return out; }
      };
      return out;
    }
  };
}

function createHtmlService(frontendUrl) {
  const html = content => {
    const out = {
      __output: true,
      getContent: () => content,
      getMimeType: () => 'text/html',
      setXFrameOptionsMode() { return out; },
      setTitle() { return out; },
      addMetaTag() { return out; },
      setSandboxMode() { return out; }
    };
    return out;
  };
  return {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    SandboxMode: { IFRAME: 'IFRAME' },
    // 原本 doGet 的預設分支會回傳整個前端頁面；前端現在放在 GitHub Pages，這裡改成導過去
    createHtmlOutputFromFile: () => html(
      `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${frontendUrl}">` +
      `<a href="${frontendUrl}">${frontendUrl}</a>`),
    createHtmlOutput: content => html(String(content || ''))
  };
}

// ---------------- UrlFetchApp（同步 HTTP：用 curl，因為 GS 程式預期 fetch 立刻回傳） ----------------

function encodeForm(obj) {
  return Object.entries(obj)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v === undefined || v === null ? '' : v))
    .join('&');
}

function createUrlFetchApp() {
  function fetch(url, params) {
    params = params || {};
    const method = String(params.method || 'get').toUpperCase();
    const headers = Object.assign({}, params.headers || {});
    let body = null;

    if (params.payload !== undefined && params.payload !== null) {
      const payload = params.payload;
      if (typeof payload === 'string') {
        body = Buffer.from(payload, 'utf8');
      } else if (Array.isArray(payload) || Buffer.isBuffer(payload)) {
        body = toBuffer(payload);
      } else if (payload.getBytes) {
        body = toBuffer(payload.getBytes());
      } else {
        body = Buffer.from(encodeForm(payload), 'utf8');
      }
      if (params.contentType) headers['Content-Type'] = params.contentType;
      else if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'urlfetch-'));
    const bodyFile = path.join(tmp, 'body');
    const headerFile = path.join(tmp, 'headers');
    const args = ['-sS', '-X', method, '-o', bodyFile, '-D', headerFile, '-w', '%{http_code}', '--max-time', '60'];
    if (params.followRedirects !== false) args.push('-L');
    if (params.validateHttpsCertificates === false) args.push('-k');
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
    if (body) args.push('--data-binary', '@-');
    args.push(url);

    try {
      const result = spawnSync('curl', args, { input: body || undefined, maxBuffer: 1024 * 1024 });
      if (result.error) throw result.error;
      const code = parseInt(String(result.stdout), 10);
      if (!code) {
        throw new Error(`無法連線到 ${url}：${String(result.stderr).trim()}`);
      }
      const content = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile) : Buffer.alloc(0);
      const rawHeaders = fs.existsSync(headerFile) ? fs.readFileSync(headerFile, 'utf8') : '';
      // 有轉址時會有好幾段標頭，取最後一段
      const block = rawHeaders.trim().split(/\r?\n\r?\n/).pop() || '';
      const headerObj = {};
      block.split(/\r?\n/).slice(1).forEach(line => {
        const i = line.indexOf(':');
        if (i > 0) headerObj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      const contentType = Object.entries(headerObj).find(([k]) => k.toLowerCase() === 'content-type');

      const response = {
        getResponseCode: () => code,
        getContentText: () => content.toString('utf8'),
        getContent: () => toSignedBytes(content),
        getBlob: () => makeBlob(content, contentType ? contentType[1].split(';')[0] : null, path.basename(url.split('?')[0])),
        getHeaders: () => headerObj,
        getAllHeaders: () => headerObj
      };

      if (code >= 400 && !params.muteHttpExceptions) {
        throw new Error(`Request failed for ${url} returned code ${code}. Truncated server response: ${content.toString('utf8').slice(0, 300)}`);
      }
      return response;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  return {
    fetch,
    fetchAll: requests => requests.map(req => (typeof req === 'string' ? fetch(req) : fetch(req.url, req)))
  };
}

// ---------------- DriveApp（本機資料夾，metadata 存在 SQLite） ----------------

function createDriveApp(db, dataDir, publicBaseUrl) {
  const fileDir = path.join(dataDir, 'drive');
  fs.mkdirSync(fileDir, { recursive: true });
  db.exec(`CREATE TABLE IF NOT EXISTS drive_items (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, parent TEXT,
    mime TEXT, size INTEGER DEFAULT 0, trashed INTEGER DEFAULT 0, created INTEGER NOT NULL
  )`);
  const ROOT = 'root';
  const getItem = db.prepare('SELECT * FROM drive_items WHERE id = ?');
  const insert = db.prepare('INSERT INTO drive_items (id, kind, name, parent, mime, size, created) VALUES (?, ?, ?, ?, ?, ?, ?)');

  const iterator = items => {
    let i = 0;
    return { hasNext: () => i < items.length, next: () => items[i++] };
  };

  function wrapFile(row) {
    const file = {
      getId: () => row.id,
      getName: () => row.name,
      getMimeType: () => row.mime,
      getSize: () => row.size,
      getDateCreated: () => new Date(row.created),
      isTrashed: () => !!row.trashed,
      getUrl: () => `${publicBaseUrl}/files/${row.id}/${encodeURIComponent(row.name)}`,
      getDownloadUrl: () => file.getUrl(),
      getBlob: () => makeBlob(fs.readFileSync(path.join(fileDir, row.id)), row.mime, row.name),
      getAs: mime => makeBlob(fs.readFileSync(path.join(fileDir, row.id)), mime, row.name),
      setTrashed(value) {
        db.prepare('UPDATE drive_items SET trashed = ? WHERE id = ?').run(value ? 1 : 0, row.id);
        row.trashed = value ? 1 : 0;
        return file;
      },
      setName(name) { db.prepare('UPDATE drive_items SET name = ? WHERE id = ?').run(name, row.id); row.name = name; return file; },
      // 本機檔案沒有「分享」這回事：下載網址帶有隨機 ID，不公開列出
      setSharing() { return file; },
      setDescription() { return file; }
    };
    return file;
  }

  function createFileIn(parentId, blobOrName, content, mimeType) {
    const blob = typeof blobOrName === 'string' ? makeBlob(content || '', mimeType || 'text/plain', blobOrName) : blobOrName;
    const buf = blob.getBuffer_ ? blob.getBuffer_() : toBuffer(blob.getBytes());
    const id = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(path.join(fileDir, id), buf);
    insert.run(id, 'file', blob.getName() || 'untitled', parentId, blob.getContentType() || 'application/octet-stream', buf.length, Date.now());
    return wrapFile(getItem.get(id));
  }

  function wrapFolder(row) {
    const folder = {
      getId: () => row.id,
      getName: () => row.name,
      getUrl: () => '',
      getFoldersByName: name => iterator(db.prepare(
        "SELECT * FROM drive_items WHERE kind = 'folder' AND parent = ? AND name = ? AND trashed = 0 ORDER BY created"
      ).all(row.id, String(name)).map(wrapFolder)),
      getFolders: () => iterator(db.prepare(
        "SELECT * FROM drive_items WHERE kind = 'folder' AND parent = ? AND trashed = 0 ORDER BY created"
      ).all(row.id).map(wrapFolder)),
      getFiles: () => iterator(db.prepare(
        "SELECT * FROM drive_items WHERE kind = 'file' AND parent = ? AND trashed = 0 ORDER BY created"
      ).all(row.id).map(wrapFile)),
      getFilesByName: name => iterator(db.prepare(
        "SELECT * FROM drive_items WHERE kind = 'file' AND parent = ? AND name = ? AND trashed = 0 ORDER BY created"
      ).all(row.id, String(name)).map(wrapFile)),
      createFolder(name) {
        const id = crypto.randomBytes(16).toString('hex');
        insert.run(id, 'folder', String(name), row.id, null, 0, Date.now());
        return wrapFolder(getItem.get(id));
      },
      createFile: (blobOrName, content, mimeType) => createFileIn(row.id, blobOrName, content, mimeType),
      setSharing() { return folder; },
      setTrashed(value) { db.prepare('UPDATE drive_items SET trashed = ? WHERE id = ?').run(value ? 1 : 0, row.id); return folder; }
    };
    return folder;
  }

  const rootRow = { id: ROOT, kind: 'folder', name: '我的雲端硬碟', parent: null };
  const root = wrapFolder(rootRow);

  return {
    Access: { ANYONE: 'ANYONE', ANYONE_WITH_LINK: 'ANYONE_WITH_LINK', DOMAIN: 'DOMAIN', DOMAIN_WITH_LINK: 'DOMAIN_WITH_LINK', PRIVATE: 'PRIVATE' },
    Permission: { VIEW: 'VIEW', EDIT: 'EDIT', COMMENT: 'COMMENT', OWNER: 'OWNER', ORGANIZER: 'ORGANIZER', NONE: 'NONE' },
    getRootFolder: () => root,
    // Apps Script 的 getFoldersByName 是搜尋整個雲端硬碟
    getFoldersByName: name => iterator(db.prepare(
      "SELECT * FROM drive_items WHERE kind = 'folder' AND name = ? AND trashed = 0 ORDER BY created"
    ).all(String(name)).map(wrapFolder)),
    createFolder: name => root.createFolder(name),
    createFile: (blobOrName, content, mimeType) => createFileIn(ROOT, blobOrName, content, mimeType),
    getFileById(id) {
      const row = getItem.get(String(id));
      if (!row || row.kind !== 'file') throw new Error('找不到這個檔案：' + id);
      return wrapFile(row);
    },
    getFolderById(id) {
      if (id === ROOT) return root;
      const row = getItem.get(String(id));
      if (!row || row.kind !== 'folder') throw new Error('找不到這個資料夾：' + id);
      return wrapFolder(row);
    },
    // 給 HTTP 伺服器的 /files 下載用
    __readFile(id) {
      const row = getItem.get(String(id));
      if (!row || row.kind !== 'file' || row.trashed) return null;
      return { name: row.name, mime: row.mime, path: path.join(fileDir, row.id) };
    }
  };
}

// ---------------- Logger / Session ----------------

function createLogger(write) {
  const lines = [];
  return {
    log(message, ...args) {
      let text = typeof message === 'string' ? message : JSON.stringify(message);
      if (args.length) {
        let i = 0;
        text = text.replace(/%s|%d|%f|%o/g, () => (i < args.length ? String(args[i++]) : ''));
      }
      write(text);
      return this;
    },
    info(m) { return this.log(m); },
    warn(m) { return this.log(m); },
    severe(m) { return this.log(m); },
    getLog: () => lines.join('\n'),
    clear() {}
  };
}

function createSession() {
  const user = { getEmail: () => '' };
  return {
    getScriptTimeZone: () => process.env.TZ,
    getActiveUser: () => user,
    getEffectiveUser: () => user,
    getTemporaryActiveUserKey: () => '',
    getActiveUserLocale: () => 'zh_TW'
  };
}

module.exports = {
  createUtilities, createPropertiesService, createCacheService, createLockService,
  createContentService, createHtmlService, createUrlFetchApp, createDriveApp,
  createLogger, createSession, formatDate, makeBlob, toSignedBytes, toBuffer
};
