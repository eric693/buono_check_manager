// 前後端整合：真正的前端頁面（jsdom）接真正的新後端（HTTP），以管理員身分點過每個分頁。
//
// 確認前端拿到的回應格式都對得上：不能有未捕捉的錯誤，後端也不能回執行期錯誤。
// 前端的 console.error 有些是「查無資料」這類正常情況，只列出來不算失敗。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRuntime } = require('./helpers');
const { createServer } = require('../src/server');

const ROOT = path.join(__dirname, '..', '..');
const { JSDOM, VirtualConsole } = require(require.resolve('jsdom', { paths: [ROOT] }));

const RUNTIME_ERROR = /相容層|is not a function|is not defined|Cannot read prop|\(reading '|TypeError|ReferenceError|SERVER_ERROR/;

async function runPage(page, port, token, userId) {
  const errors = [];
  const consoleErrors = [];
  const calls = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
  vc.on('error', (...a) => consoleErrors.push(a.join(' ').slice(0, 200)));

  const raw = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const scripts = [...raw.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]).filter(s => !s.startsWith('http'));
  let html = raw.replace(/<script[^>]*src="https?:[^"]*"[^>]*>\s*<\/script>/g, '');
  const api = `http://127.0.0.1:${port}/exec`;
  for (const s of scripts) {
    let code = fs.readFileSync(path.join(ROOT, s), 'utf8');
    // config.js 換成指向測試後端
    if (s === 'config.js') code = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'staging-config.js'), 'utf8')
      .replace(/window\.location\.origin \+ '\/exec'/, JSON.stringify(api));
    html = html.replace(`<script src="${s}"></script>`, () => `<script data-file="${s}">\n${code}\n</script>`);
  }

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://buono-staging.example/' + page,
    virtualConsole: vc,
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url, options) => {
        const u = String(url);
        const i18n = u.match(/i18n\/(help\/)?([\w-]+)\.json/);
        if (i18n) {
          const file = path.join(ROOT, 'i18n', i18n[1] ? 'help' : '', i18n[2] + '.json');
          return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
        }
        // 前端用的是 jsdom 的 URLSearchParams，Node 的 fetch 認不得，轉成一般的表單字串
        const opts = Object.assign({}, options);
        if (opts.body && typeof opts.body !== 'string') {
          opts.body = String(opts.body);
          opts.headers = Object.assign({ 'Content-Type': 'application/x-www-form-urlencoded' }, opts.headers || {});
        }
        delete opts.signal; // jsdom 的 AbortSignal 也不能直接給 Node
        const res = await fetch(u.replace('https://buono-staging.example', `http://127.0.0.1:${port}`), opts);
        const text = await res.text();
        const action = (options && options.body ? new URLSearchParams(String(options.body)) : new URL(u).searchParams).get('action');
        calls.push({ action, text });
        return { ok: res.ok, status: res.status, json: async () => JSON.parse(text), text: async () => text };
      };
      window.tailwind = { config: {} }; // 測試環境不載入 Tailwind CDN
      window.alert = () => {};
      window.confirm = () => false;
      window.prompt = () => null;
      window.print = () => {};
      window.open = () => null;
      window.scrollTo = () => {};
      window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {} });
      window.navigator.geolocation = { getCurrentPosition: ok => ok({ coords: { latitude: 25.0331, longitude: 121.5655, accuracy: 10 } }) };
      window.localStorage.setItem('sessionToken', token);
      window.localStorage.setItem('sessionUserId', userId);
      window.localStorage.setItem('lang', 'zh-TW');
      window.addEventListener('error', e => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
      window.addEventListener('unhandledrejection', e => errors.push('unhandledRejection: ' + String(e.reason && e.reason.stack || e.reason).split('\n')[0]));
    }
  });

  const { window } = dom;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  window.document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true }));
  await wait(2500);
  for (const el of window.document.querySelectorAll('[id^="tab-"][id$="-btn"], .shift-tab, .tab-btn')) {
    try { el.click(); } catch (e) { errors.push(`點擊 ${el.id} 失敗: ${e.message}`); }
    await wait(700);
  }
  await wait(1500);
  window.close();

  const backendErrors = calls.filter(c => RUNTIME_ERROR.test(c.text)).map(c => `${c.action}: ${c.text.slice(0, 200)}`);
  return { errors, consoleErrors, calls, backendErrors };
}

test('前端頁面接新後端：管理員與員工點過每個分頁都正常', async () => {
  const t = makeRuntime();
  const ADMIN = t.addEmployee('Uadmin', '老闆', '管理員');
  const EMP = t.addEmployee('Uemp', '小明', '員工');
  t.ss.getSheetByName('打卡地點表').appendRow(['L1', '台北門市', 25.033, 121.5654, 100]);
  t.runtime.store.flush();
  t.api({ action: 'setEmployeeSalaryTW', token: ADMIN, employeeId: 'Uemp', employeeName: '小明', salaryType: '月薪', baseSalary: '32000' });
  t.api({ action: 'punch', token: ADMIN, type: '上班', lat: '25.0331', lng: '121.5655' });

  const server = createServer(t.runtime, { log: () => {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const report = [];
    for (const [who, token, userId] of [['管理員', ADMIN, 'Uadmin'], ['員工', EMP, 'Uemp']])
    for (const page of ['index.html', 'salary.html', 'shift.html']) {
      const r = await runPage(page, port, token, userId);
      const actions = [...new Set(r.calls.map(c => c.action))];
      report.push(`${who} ${page}：呼叫 ${r.calls.length} 次、${actions.length} 種 API；前端 console.error ${r.consoleErrors.length} 則`);
      r.consoleErrors.forEach(e => report.push('    console.error ' + e));
      assert.ok(r.calls.length > 5, `${page} 應該要呼叫後端：${actions}`);
      assert.deepEqual(r.backendErrors, [], `${page} 後端執行期錯誤`);
      assert.deepEqual(r.errors, [], `${page} 前端未捕捉的錯誤`);
    }
    console.log(report.join('\n'));
  } finally {
    server.close();
  }
});
