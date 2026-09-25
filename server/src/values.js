// values.js
//
// 模擬 Google 試算表的儲存格行為。
//
// GS 程式是照試算表的行為寫的：寫進去的字串會被自動轉型，讀回來的型別就不同了。
// 例如寫 "2026-09" 讀回來是 Date（程式裡有 `年月 instanceof Date` 的判斷）、
// 寫 "0912345678" 讀回來是數字（所以電話前面會加單引號）。這裡照同樣規則轉，
// 現有程式才能不改就跑。
//
// GS 程式跑在 vm 裡，vm 有自己的一套 Date：相容層交給 GS 的日期一定要用 vm 的 Date 建立，
// 否則 GS 裡的 `x instanceof Date` 會是 false。所以轉型函式要綁定某個 Date 建構子
// （createValues），而判斷是不是日期一律用 isDate（不看是哪個環境建立的）。
//
// 所有日期都用本地時間建構，process.env.TZ 在啟動時設成腳本時區（Asia/Taipei），
// 跟 Apps Script 一樣：getHours() 和 Utilities.formatDate(..., 'HH:mm') 會對得上。

'use strict';

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
// yyyy-MM-dd、yyyy/MM/dd，可帶時間 HH:mm 或 HH:mm:ss
// 試算表不認 ISO 的 "T" 分隔（2026-09-20T10:00 會留成文字），所以只接受空白
const DATE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
// yyyy-MM → 該月 1 日
const YEAR_MONTH_RE = /^(\d{4})[-/](\d{1,2})$/;
// HH:mm 或 HH:mm:ss → 試算表的「時間」，日期部分是 1899-12-30
const TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function isDate(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function isEmpty(value) {
  return value === '' || value === null || value === undefined;
}

/**
 * @param {DateConstructor} DateCtor  GS 程式所在環境的 Date
 */
function createValues(DateCtor) {
  const make = (...args) => new DateCtor(...args);
  const valid = d => (isNaN(d.getTime()) ? null : d);

  /** 寫進儲存格前的轉型（setValue / setValues / appendRow 都走這裡） */
  function coerce(value) {
    if (value === null || value === undefined) return '';
    if (isDate(value)) return make(value.getTime());
    if (typeof value === 'number') return isFinite(value) ? value : String(value);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'object') return String(value);  // 試算表會存成 [object Object] 之類的字串

    const s = String(value);
    if (s === '') return '';
    if (s[0] === "'") return s.slice(1);  // 單引號開頭：強制文字

    const t = s.trim();
    if (NUMBER_RE.test(t)) {
      // 超過 15 位數試算表會失去精度，但仍然是數字；照做
      const n = Number(t);
      if (isFinite(n)) return n;
    }

    const upper = t.toUpperCase();
    if (upper === 'TRUE') return true;
    if (upper === 'FALSE') return false;

    let m = t.match(DATE_RE);
    if (m) {
      const d = valid(make(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
      // 2026-02-30 這種不存在的日期，試算表會當成文字
      if (d && d.getMonth() === +m[2] - 1) return d;
      return s;
    }

    m = t.match(YEAR_MONTH_RE);
    if (m && +m[2] >= 1 && +m[2] <= 12) return make(+m[1], +m[2] - 1, 1);

    m = t.match(TIME_RE);
    if (m && +m[1] < 24 && +m[2] < 60) return make(1899, 11, 30, +m[1], +m[2], +(m[3] || 0));

    return s;
  }

  /** 讀出來給程式用：日期複製一份，程式改了不會動到儲存的值 */
  function readCell(value) {
    if (value === undefined || value === null) return '';
    if (isDate(value)) return make(value.getTime());
    return value;
  }

  function decodeRow(json) {
    return JSON.parse(json).map(v => (v && typeof v === 'object' && '$d' in v ? make(v.$d) : v));
  }

  return { coerce, readCell, decodeRow };
}

// ---- 存進 SQLite 的編碼（不分哪個環境的 Date） ----

function encodeRow(row) {
  const out = row.map(v => (isDate(v) ? { $d: v.getTime() } : v === undefined || v === null ? '' : v));
  while (out.length && out[out.length - 1] === '') out.pop();
  return JSON.stringify(out);
}

// ---- 試算表的「顯示文字」（createTextFinder、getDisplayValues 用） ----

function displayValue(value) {
  if (isEmpty(value)) return '';
  if (isDate(value)) {
    const pad = n => String(n).padStart(2, '0');
    if (value.getFullYear() === 1899) return `${value.getHours()}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
    return `${value.getFullYear()}/${value.getMonth() + 1}/${value.getDate()}`;
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

// 相容層外（測試、匯入工具）用本環境的 Date
const hostValues = createValues(Date);

module.exports = {
  createValues, isDate, isEmpty, encodeRow, displayValue,
  coerce: hostValues.coerce, readCell: hostValues.readCell, decodeRow: hostValues.decodeRow
};
