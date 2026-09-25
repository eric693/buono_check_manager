// spreadsheet.js
//
// SpreadsheetApp 的相容實作。每張工作表 = SQLite 裡一組列（sheet_rows），
// 啟動時整份讀進記憶體，讀取都走記憶體；寫入先改記憶體、標記哪幾列變了，
// 每個請求結束時（flush）一次寫回資料庫。
//
// 只有一個 Node 行程、請求一個接一個處理（GS 程式全是同步的），
// 所以不會有兩個請求同時改同一張表 —— 跟 Apps Script 的 LockService 效果一樣。
//
// 格式相關的方法（setFontWeight、setColumnWidth…）沒有意義，一律接受但不做事。

'use strict';

const { createValues, encodeRow, displayValue, isEmpty } = require('./values');

// 只影響外觀的方法：接受但忽略，回傳自己讓鏈式呼叫能接下去
const FORMAT_METHOD = /^(set(Font|Background|Border|Wrap|Horizontal|Vertical|Number|DataValidation|Note|TextStyle|TextRotation|Column|Row|Frozen|ConditionalFormat|Tab)|autoResize|merge|breakApart|activate|hide|show|protect|insert(Checkboxes)|clearFormat|clearDataValidations|clearNote|applyRowBanding)/;

function withFormatNoops(target, label) {
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      if (typeof prop === 'string' && FORMAT_METHOD.test(prop)) {
        return function () { return this; };
      }
      if (typeof prop === 'string' && prop !== 'then' && prop !== 'toJSON' && !prop.startsWith('__')) {
        throw new Error(`相容層尚未支援 ${label}.${prop}()`);
      }
      return undefined;
    }
  });
}

function columnToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// "A1"、"A1:C3"、"A:A"、"J2:J1000" → { row, col, numRows, numCols }（numRows=null 表示整欄）
function parseA1(a1) {
  const m = String(a1).trim().match(/^([A-Za-z]+)(\d*)(?::([A-Za-z]+)(\d*))?$/);
  if (!m) throw new Error('無法解析的範圍：' + a1);
  const col = columnToIndex(m[1]);
  const row = m[2] ? +m[2] : 1;
  const col2 = m[3] ? columnToIndex(m[3]) : col;
  const wholeColumn = !m[2] || (m[3] && !m[4]);
  const row2 = m[4] ? +m[4] : row;
  return {
    row: row,
    col: col,
    numRows: wholeColumn ? null : row2 - row + 1,
    numCols: col2 - col + 1
  };
}

class Store {
  /**
   * @param {import('better-sqlite3').Database} db
   * @param {DateConstructor} DateCtor  GS 程式所在 vm 的 Date（讀給 GS 的日期要用它建立）
   */
  constructor(db, DateCtor, meta) {
    this.db = db;
    this.meta = meta || { id: 'local', name: '出勤管家' };
    this.values = createValues(DateCtor || Date);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sheets (name TEXT PRIMARY KEY, position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sheet_rows (
        sheet TEXT NOT NULL, r INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (sheet, r)
      );
    `);
    this.sheets = new Map();   // name → { name, rows: [[...]] }
    this.dirtyRows = new Map(); // name → Set(row index 0-based)
    this.rewrite = new Set();   // 整張表要重寫（刪列之後列號位移）
    this.removed = new Set();
    this.load();
  }

  load() {
    const names = this.db.prepare('SELECT name FROM sheets ORDER BY position').all();
    const rowStmt = this.db.prepare('SELECT r, data FROM sheet_rows WHERE sheet = ? ORDER BY r');
    for (const { name } of names) {
      const rows = [];
      for (const { r, data } of rowStmt.iterate(name)) rows[r] = this.values.decodeRow(data);
      for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
      this.sheets.set(name, { name, rows });
    }
  }

  markRow(name, index) {
    if (!this.dirtyRows.has(name)) this.dirtyRows.set(name, new Set());
    this.dirtyRows.get(name).add(index);
  }

  /** 把這次請求改過的資料寫回資料庫 */
  flush() {
    if (!this.dirtyRows.size && !this.rewrite.size && !this.removed.size) return;
    const db = this.db;
    const upsert = db.prepare('INSERT OR REPLACE INTO sheet_rows (sheet, r, data) VALUES (?, ?, ?)');
    const delRow = db.prepare('DELETE FROM sheet_rows WHERE sheet = ? AND r = ?');
    const delSheetRows = db.prepare('DELETE FROM sheet_rows WHERE sheet = ?');
    const delSheet = db.prepare('DELETE FROM sheets WHERE name = ?');
    const putSheet = db.prepare('INSERT OR IGNORE INTO sheets (name, position) VALUES (?, ?)');

    db.transaction(() => {
      for (const name of this.removed) { delSheetRows.run(name); delSheet.run(name); }
      let pos = 0;
      for (const name of this.sheets.keys()) putSheet.run(name, pos++);

      for (const name of this.rewrite) {
        const sheet = this.sheets.get(name);
        if (!sheet) continue;
        delSheetRows.run(name);
        sheet.rows.forEach((row, r) => {
          const json = encodeRow(row);
          if (json !== '[]') upsert.run(name, r, json);
        });
      }
      for (const [name, set] of this.dirtyRows) {
        if (this.rewrite.has(name)) continue;
        const sheet = this.sheets.get(name);
        if (!sheet) continue;
        for (const r of set) {
          const json = encodeRow(sheet.rows[r] || []);
          if (json === '[]') delRow.run(name, r); else upsert.run(name, r, json);
        }
      }
    })();

    this.dirtyRows.clear();
    this.rewrite.clear();
    this.removed.clear();
  }

  createSheet(name) {
    if (this.sheets.has(name)) throw new Error(`已經有名為「${name}」的工作表`);
    const sheet = { name, rows: [] };
    this.sheets.set(name, sheet);
    this.removed.delete(name);
    this.rewrite.add(name);
    return sheet;
  }

  deleteSheet(name) {
    this.sheets.delete(name);
    this.removed.add(name);
  }
}

// ---------------- Range ----------------

function makeRange(store, sheetData, row, col, numRows, numCols) {
  const { coerce, readCell } = store.values;
  const lastRow = () => lastRowOf(sheetData);
  // 整欄（A:A）：列數跟著資料走
  const rowsCount = () => (numRows === null ? Math.max(lastRow() - row + 1, 0) : numRows);

  const getCell = (r, c) => {
    const rowArr = sheetData.rows[r - 1];
    return rowArr ? readCell(rowArr[c - 1]) : '';
  };

  const setCell = (r, c, value) => {
    const idx = r - 1;
    while (sheetData.rows.length <= idx) sheetData.rows.push([]);
    const rowArr = sheetData.rows[idx];
    while (rowArr.length < c - 1) rowArr.push('');
    rowArr[c - 1] = coerce(value);
    store.markRow(sheetData.name, idx);
  };

  const range = {
    getRow: () => row,
    getColumn: () => col,
    getNumRows: () => rowsCount(),
    getNumColumns: () => numCols,
    getLastRow: () => row + rowsCount() - 1,
    getLastColumn: () => col + numCols - 1,
    getSheet: () => makeSheet(store, sheetData),

    getValues() {
      const out = [];
      for (let r = 0; r < rowsCount(); r++) {
        const line = [];
        for (let c = 0; c < numCols; c++) line.push(getCell(row + r, col + c));
        out.push(line);
      }
      return out;
    },
    getDisplayValues() {
      return range.getValues().map(line => line.map(displayValue));
    },
    getValue: () => getCell(row, col),
    getDisplayValue: () => displayValue(getCell(row, col)),

    setValue(value) {
      for (let r = 0; r < rowsCount(); r++) for (let c = 0; c < numCols; c++) setCell(row + r, col + c, value);
      return proxied;
    },
    setValues(values) {
      if (!Array.isArray(values) || values.length !== rowsCount() ||
          values.some(line => !Array.isArray(line) || line.length !== numCols)) {
        throw new Error(`資料的列數或欄數與範圍不符（範圍 ${rowsCount()}x${numCols}）`);
      }
      values.forEach((line, r) => line.forEach((v, c) => setCell(row + r, col + c, v)));
      return proxied;
    },
    clearContent() {
      for (let r = 0; r < rowsCount(); r++) for (let c = 0; c < numCols; c++) {
        const rowArr = sheetData.rows[row + r - 1];
        if (rowArr && rowArr.length >= col + c) { rowArr[col + c - 1] = ''; store.markRow(sheetData.name, row + r - 1); }
      }
      return proxied;
    },
    clear() { return range.clearContent(); },

    // createTextFinder(text).findNext()：不分大小寫、部分符合（試算表預設）
    createTextFinder(text) {
      const needle = String(text).toLowerCase();
      let matchEntire = false;
      let caseSensitive = false;
      const finder = {
        matchEntireCell(v) { matchEntire = !!v; return finder; },
        matchCase(v) { caseSensitive = !!v; return finder; },
        findAll() {
          const hits = [];
          for (let r = 0; r < rowsCount(); r++) for (let c = 0; c < numCols; c++) {
            let shown = displayValue(getCell(row + r, col + c));
            let target = String(text);
            if (!caseSensitive) { shown = shown.toLowerCase(); target = needle; }
            if (matchEntire ? shown === target : (target !== '' && shown.includes(target))) {
              hits.push(makeRange(store, sheetData, row + r, col + c, 1, 1));
            }
          }
          return hits;
        },
        findNext() { return finder.findAll()[0] || null; }
      };
      return finder;
    }
  };

  const proxied = withFormatNoops(range, 'Range');
  return proxied;
}

function lastRowOf(sheetData) {
  for (let r = sheetData.rows.length - 1; r >= 0; r--) {
    const rowArr = sheetData.rows[r];
    if (rowArr && rowArr.some(v => !isEmpty(v))) return r + 1;
  }
  return 0;
}

function lastColumnOf(sheetData) {
  let max = 0;
  for (const rowArr of sheetData.rows) {
    if (!rowArr) continue;
    for (let c = rowArr.length - 1; c >= 0; c--) {
      if (!isEmpty(rowArr[c])) { max = Math.max(max, c + 1); break; }
    }
  }
  return max;
}

// ---------------- Sheet ----------------

function makeSheet(store, sheetData) {
  const sheet = {
    getName: () => sheetData.name,
    getSheetName: () => sheetData.name,
    getSheetId: () => Math.abs([...sheetData.name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)),
    getLastRow: () => lastRowOf(sheetData),
    getLastColumn: () => lastColumnOf(sheetData),
    getMaxRows: () => Math.max(lastRowOf(sheetData), 1000),
    getMaxColumns: () => Math.max(lastColumnOf(sheetData), 26),
    getFrozenRows: () => 0,
    getParent: () => spreadsheetFor(store),

    getDataRange() {
      return makeRange(store, sheetData, 1, 1, Math.max(lastRowOf(sheetData), 1), Math.max(lastColumnOf(sheetData), 1));
    },

    getRange(a, b, c, d) {
      // 只給一個字串才是 A1 表示法；getRange("2", 12) 這種數字字串列號 Apps Script 也接受
      if (typeof a === 'string' && b === undefined) {
        const p = parseA1(a);
        return makeRange(store, sheetData, p.row, p.col, p.numRows, p.numCols);
      }
      const r = Number(a), col = Number(b);
      const nr = c === undefined ? 1 : Number(c), nc = d === undefined ? 1 : Number(d);
      if (!(r >= 1) || !(col >= 1) || !Number.isInteger(r) || !Number.isInteger(col)) {
        throw new Error(`範圍的列或欄必須是從 1 開始的整數（收到 ${a}, ${b}）`);
      }
      if (!(nr >= 1) || !(nc >= 1)) throw new Error(`範圍的列數或欄數必須大於 0（收到 ${c}, ${d}）`);
      return makeRange(store, sheetData, r, col, nr, nc);
    },

    appendRow(values) {
      const { coerce } = store.values;
      // 永遠接在最後一筆有資料的列後面；之後殘留的空列本來就沒內容，直接截掉
      const idx = lastRowOf(sheetData);
      sheetData.rows.length = idx;
      sheetData.rows[idx] = values.map(coerce);
      store.markRow(sheetData.name, idx);
      return proxied;
    },

    deleteRow(rowPosition) { return sheet.deleteRows(rowPosition, 1); },
    deleteRows(rowPosition, howMany) {
      if (!(rowPosition >= 1)) throw new Error('列號必須從 1 開始');
      sheetData.rows.splice(rowPosition - 1, howMany || 1);
      store.rewrite.add(sheetData.name);
      return proxied;
    },

    insertRowBefore(rowPosition) { sheetData.rows.splice(rowPosition - 1, 0, []); store.rewrite.add(sheetData.name); return proxied; },
    insertRowAfter(rowPosition) { sheetData.rows.splice(rowPosition, 0, []); store.rewrite.add(sheetData.name); return proxied; },

    clear() { sheetData.rows = []; store.rewrite.add(sheetData.name); return proxied; },
    clearContents() { return sheet.clear(); },

    getConditionalFormatRules: () => [],
    setName(name) {
      if (store.sheets.has(name)) throw new Error(`已經有名為「${name}」的工作表`);
      store.deleteSheet(sheetData.name);
      sheetData.name = name;
      store.sheets.set(name, sheetData);
      store.rewrite.add(name);
      return proxied;
    }
  };
  const proxied = withFormatNoops(sheet, 'Sheet');
  return proxied;
}

// ---------------- Spreadsheet / SpreadsheetApp ----------------

function spreadsheetFor(store) {
  const ss = {
    getId: () => store.meta.id,
    getName: () => store.meta.name,
    getUrl: () => '',
    getSpreadsheetTimeZone: () => process.env.TZ,
    getSheetByName(name) {
      const data = store.sheets.get(name);
      return data ? makeSheet(store, data) : null;
    },
    insertSheet(name) {
      return makeSheet(store, store.createSheet(String(name || `工作表${store.sheets.size + 1}`)));
    },
    getSheets: () => [...store.sheets.values()].map(data => makeSheet(store, data)),
    getActiveSheet: () => ss.getSheets()[0] || null,
    deleteSheet(sheet) { store.deleteSheet(sheet.getName()); }
  };
  return withFormatNoops(ss, 'Spreadsheet');
}

function builder() {
  const b = new Proxy({}, {
    get(_, prop) {
      if (prop === 'build') return () => ({});
      return () => b;
    }
  });
  return b;
}

function createSpreadsheetApp(store, options = {}) {
  return {
    getActive: () => spreadsheetFor(store),
    getActiveSpreadsheet: () => spreadsheetFor(store),
    flush() {},
    newDataValidation: builder,
    newConditionalFormatRule: builder,
    // create() 只有匯出 Excel 在用：建一份暫存的試算表，由 runtime 轉成 .xlsx（見 runtime.js）
    create(name) {
      if (!options.createTemp) throw new Error('相容層不支援建立新的試算表');
      return spreadsheetFor(options.createTemp(String(name || '未命名試算表')));
    },
    getUi() { throw new Error('相容層沒有試算表介面（getUi 只能在 Apps Script 編輯器手動執行）'); }
  };
}

module.exports = { Store, createSpreadsheetApp, spreadsheetFor, parseA1 };
