// 把 Main.gs 路由裡的每一個 action 都呼叫一遍（管理員與一般員工各一次），
// 確認沒有任何一支因為相容層缺東西、或 GS 程式本身的執行錯誤而爆掉。
//
// 這裡不檢查結果對不對（各功能的測試在其他檔案），只抓「程式壞掉」這類錯誤：
// GS 自己回的「缺少參數」「權限不足」是正常的。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRuntime } = require('./helpers');

const RUNTIME_ERROR = /相容層|is not a function|is not defined|Cannot read prop|Cannot set prop|\(reading '|SyntaxError|TypeError|ReferenceError|RangeError|Invalid time value|Maximum call stack/;

test('每一個 API action 都能執行，沒有執行期錯誤', () => {
  const t = makeRuntime();
  const ADMIN = t.addEmployee('Uadmin', '老闆', '管理員');
  const EMP = t.addEmployee('Uemp', '小明', '員工');
  t.ss.getSheetByName('打卡地點表').appendRow(['L1', '台北門市', 25.033, 121.5654, 100]);
  t.runtime.store.flush();

  const { Utilities } = t.runtime.context;
  const ym = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  const d = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');

  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'GS', 'Main.gs'), 'utf8');
  const actions = [...new Set([...main.matchAll(/case ['"](\w+)['"]:/g)].map(m => m[1]))];
  assert.ok(actions.length >= 100, `只找到 ${actions.length} 個 action，Main.gs 的路由格式可能變了`);

  // 常見參數一次帶齊，讓每支 handler 盡量走進主要邏輯
  const params = {
    yearMonth: ym, month: ym, date: d, employeeId: 'Uemp', userId: 'Uemp', employeeName: '小明', year: ym.slice(0, 4),
    type: '上班', lat: '25.0331', lng: '121.5655', datetime: d + 'T09:00:00', note: '測試備註', reason: '測試原因說明文字',
    startDate: d, endDate: d, startTime: '09:00', endTime: '18:00', hours: '2', overtimeDate: d, shiftType: '早班',
    location: '台北門市', leaveType: 'PERSONAL_LEAVE', startDateTime: d + 'T09:00', endDateTime: d + 'T12:00',
    content: '整理倉庫並清點本週進貨的商品', baseSalary: '30000', salaryType: '月薪', title: '公告', priority: 'normal',
    role: 'employee', newName: '王小明', name: '王小明', idNumber: 'A123456789', bonusType: '中秋節獎金', amount: '1000',
    status: '已發放', punchType: '上班', minutes: '10', loc: '台北門市', items: '[]', groups: '["allowance"]',
    targetEmployeeIds: '["Uadmin"]', sourceEmployeeId: 'Uemp', dailySalary: '1500', workDays: '20',
    shiftsArray: '[]', recordKeys: '[]', limit: '5'
  };

  const failures = [];
  for (const action of actions) {
    for (const [who, token] of [['管理員', ADMIN], ['員工', EMP]]) {
      let text;
      try {
        text = JSON.stringify(t.api(Object.assign({ action, token }, params), 'POST'));
      } catch (error) {
        text = 'THROWN ' + String(error.stack || error).split('\n')[0];
      }
      if (text.startsWith('THROWN') || RUNTIME_ERROR.test(text)) failures.push(`${action}（${who}）：${text.slice(0, 200)}`);
    }
  }
  assert.deepEqual(failures, [], '\n' + failures.join('\n'));
});
