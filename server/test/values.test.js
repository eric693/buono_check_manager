'use strict';
process.env.TZ = 'Asia/Taipei';

const test = require('node:test');
const assert = require('node:assert/strict');
const { coerce, encodeRow, decodeRow } = require('../src/values');
const { formatDate } = require('../src/services');

test('寫入時照試算表規則轉型', () => {
  assert.equal(coerce('123'), 123);
  assert.equal(coerce('12.5'), 12.5);
  assert.equal(coerce('0912345678'), 912345678, '試算表會把電話變成數字，所以程式加了單引號');
  assert.equal(coerce("'0912345678"), '0912345678');
  assert.equal(coerce('TRUE'), true);
  assert.equal(coerce('abc'), 'abc');
  assert.equal(coerce(''), '');
  assert.equal(coerce(null), '');
  assert.equal(coerce('2026-09-20T10:00'), '2026-09-20T10:00', 'ISO 的 T 格式不轉');
  assert.equal(coerce('2026-02-30'), '2026-02-30', '不存在的日期留成文字');

  const d = coerce('2026-09-20');
  assert.ok(d instanceof Date);
  assert.equal(formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd HH:mm'), '2026-09-20 00:00');

  const ym = coerce('2026-09');
  assert.ok(ym instanceof Date, '年月會變成日期（程式裡有 instanceof Date 的判斷）');
  assert.equal(formatDate(ym, 'Asia/Taipei', 'yyyy-MM'), '2026-09');

  const dt = coerce('2026/9/20 18:30:05');
  assert.equal(formatDate(dt, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'), '2026-09-20 18:30:05');

  const time = coerce('09:05');
  assert.ok(time instanceof Date);
  assert.equal(time.getFullYear(), 1899);
  assert.equal(time.getHours(), 9);
  assert.equal(formatDate(time, 'Asia/Taipei', 'HH:mm'), '09:05', '1899 年的時間也要格式化正確');
});

test('SQLite 編碼保留型別', () => {
  const row = [new Date(2026, 8, 20, 9, 0), 12, 'x', true, '', ''];
  const back = decodeRow(encodeRow(row));
  assert.equal(back.length, 4, '尾端空白不存');
  assert.ok(back[0] instanceof Date);
  assert.equal(back[0].getTime(), row[0].getTime());
  assert.deepEqual(back.slice(1), [12, 'x', true]);
});

test('formatDate 支援程式用到的格式', () => {
  const d = new Date(2026, 8, 5, 7, 3, 9);
  assert.equal(formatDate(d, 'Asia/Taipei', 'yyyy年MM月'), '2026年09月');
  assert.equal(formatDate(d, 'Asia/Taipei', 'MM/dd HH:mm'), '09/05 07:03');
  assert.equal(formatDate(d, 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ss"), '2026-09-05T07:03:09');
  assert.equal(formatDate(d, 'UTC', 'HH:mm'), '23:03');
  assert.equal(formatDate(d, 'GMT+8', 'HH:mm'), '07:03');
  assert.equal(formatDate(d, 'Asia/Taipei', 'EEE'), 'Sat');
  assert.equal(formatDate('2026-09-05', 'Asia/Taipei', 'yyyy-MM-dd'), '2026-09-05');
});
