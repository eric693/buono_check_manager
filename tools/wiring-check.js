// 串接檢查：把前端呼叫、Main.gs 路由、GS handler、HTML 元素四邊對起來，
// 任何一邊缺了就列出來。純靜態掃描，不需要連到 Apps Script。
//
// 用法：node tools/wiring-check.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const listFiles = (dir, ext) =>
  fs.readdirSync(path.join(ROOT, dir))
    .filter(f => f.endsWith(ext))
    .map(f => path.join(dir, f));

const problems = [];
const report = (section, items) => {
  console.log(`\n── ${section} ──`);
  if (items.length === 0) {
    console.log('   OK');
  } else {
    items.forEach(i => console.log('   ✗ ' + i));
    problems.push(...items.map(i => `${section}: ${i}`));
  }
};

const gsFiles = listFiles('GS', '.gs');
const gsSource = gsFiles.map(read).join('\n');
const frontFiles = [...listFiles('.', '.js'), ...listFiles('.', '.html')]
  .filter(f => !f.includes('qrcode.min') && !f.startsWith('tools'));
const frontSource = frontFiles.map(read).join('\n');

// ---------- 1. 後端路由 → handler 函式 ----------
const main = read('GS/Main.gs');
const routes = new Map();   // action -> handler 名稱（抓不到對應函式時為 null）
// 先把所有 case 標籤收下來，這才是「這個 action 有沒有被處理」的依據
for (const m of main.matchAll(/case\s+["'](\w+)["']\s*:/g)) {
  routes.set(m[1], null);
}
// 再補上「case 後面直接 return respond(handleXxx(...))」這種可以靜態對到函式的
for (const m of main.matchAll(/case\s+["'](\w+)["']\s*:\s*(?:\r?\n)?\s*return\s+respond1?\((\w+)\(/g)) {
  routes.set(m[1], m[2]);
}
for (const m of main.matchAll(/case\s+["'](\w+)["']\s*:\s*(?:\r?\n)?\s*return\s+(\w+)\(\)/g)) {
  if (!routes.get(m[1])) routes.set(m[1], m[2]);
}

const definedGsFns = new Set(
  [...gsSource.matchAll(/^\s*function\s+(\w+)\s*\(/gm)].map(m => m[1])
);

report('後端路由指向的 handler 不存在', [...routes.entries()]
  .filter(([, fn]) => fn && !definedGsFns.has(fn))
  .map(([action, fn]) => `${action} → ${fn}()`));

// ---------- 2. 前端呼叫的 action → 後端路由 ----------
const calledActions = new Set();
for (const m of frontSource.matchAll(/callApifetch\(\s*[`'"]([A-Za-z]\w*)/g)) {
  calledActions.add(m[1]);
}
// 樣板字串組出來的（例如 `${action}&...`）抓不到，另外撈常見寫法
for (const m of frontSource.matchAll(/action=([A-Za-z]\w*)/g)) {
  calledActions.add(m[1]);
}

report('前端呼叫了但後端沒有路由的 action',
  [...calledActions].filter(a => !routes.has(a)).sort());

// ---------- 3. 後端 handler 有寫但沒接路由 ----------
const handlerFns = [...definedGsFns].filter(fn => /^handle[A-Z]/.test(fn));
const routedHandlers = new Set([...routes.values()].filter(Boolean));
// 有些 handler 是被別的程式直接呼叫的（LINE webhook、內部流程），不走 doGet 路由
const calledElsewhere = (fn) => {
  const pattern = new RegExp(`\\b${fn}\\s*\\(`, 'g');
  const hits = (gsSource.match(pattern) || []).length;
  return hits > 1;  // 1 次是自己的宣告
};
// 已知例外：LINE Bot 的文字指令處理函式，簽章是 (replyToken, userId, ...) 而不是 (params)，
// 本來就不該掛在 doGet 路由上；目前還沒接到任何指令，先留著。
const KNOWN_UNROUTED = new Set(['handleLeaveReview']);
report('有 handler 但沒掛上路由、也沒被其他程式呼叫',
  handlerFns
    .filter(fn => !routedHandlers.has(fn) && !calledElsewhere(fn) && !KNOWN_UNROUTED.has(fn))
    .sort());

// ---------- 4. HTML 的 onclick/onchange 指向的函式 ----------
const htmlFiles = listFiles('.', '.html');
const definedFrontFns = new Set(
  [...frontSource.matchAll(/function\s+(\w+)\s*\(/g)].map(m => m[1])
);
const inlineMissing = [];
for (const file of htmlFiles) {
  const html = read(file);
  for (const m of html.matchAll(/on(?:click|change|input|submit)="(\w+)\(/g)) {
    if (!definedFrontFns.has(m[1])) inlineMissing.push(`${file}: ${m[1]}()`);
  }
}
report('HTML 內嵌事件指向未定義的函式', [...new Set(inlineMissing)].sort());

// ---------- 5. 新模組用到的 DOM id 是否存在 ----------
const pageIds = {};
for (const file of htmlFiles) {
  const html = read(file);
  pageIds[file] = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
}

const checkIds = (jsFile, pages) => {
  const js = read(jsFile);
  const ids = new Set(
    [...js.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  );
  return [...ids]
    .filter(id => !pages.some(p => pageIds[p].has(id)))
    .map(id => `${jsFile}: #${id}`);
};

report('salary-admin.js 用到但頁面沒有的 id', checkIds('salary-admin.js', ['salary.html']));
report('worktime.js 用到但頁面沒有的 id',
  checkIds('worktime.js', ['index.html', 'salary.html']));
report('pwa.js 用到但頁面沒有的 id',
  checkIds('pwa.js', ['index.html', 'salary.html', 'shift.html']));

// ---------- 6. PWA 檔案 ----------
const pwaMissing = [];
const manifest = JSON.parse(read('manifest.webmanifest'));
manifest.icons.forEach(icon => {
  if (!fs.existsSync(path.join(ROOT, icon.src))) pwaMissing.push(`manifest 少了圖示 ${icon.src}`);
});
const sw = read('sw.js');
for (const m of sw.matchAll(/'\.\/([^']+)'/g)) {
  const target = m[1];
  if (target === '' || target.endsWith('/')) continue;
  if (!fs.existsSync(path.join(ROOT, target))) pwaMissing.push(`sw.js 預快取了不存在的 ${target}`);
}
htmlFiles.forEach(file => {
  const html = read(file);
  if (!html.includes('manifest.webmanifest')) pwaMissing.push(`${file} 沒有連到 manifest`);
  if (!html.includes('pwa.js')) pwaMissing.push(`${file} 沒有載入 pwa.js`);
});
report('PWA 設定', pwaMissing);

// ---------- 7. i18n：HTML 用到的鍵是否每個語系都有 ----------
const langs = fs.readdirSync(path.join(ROOT, 'i18n'))
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace('.json', ''));
const dicts = {};
langs.forEach(l => { dicts[l] = JSON.parse(read(`i18n/${l}.json`)); });

const usedKeys = new Set();
htmlFiles.forEach(file => {
  const html = read(file);
  for (const m of html.matchAll(/data-i18n(?:-option|-key)?="([^"]+)"/g)) usedKeys.add(m[1]);
});

const i18nMissing = [];
[...usedKeys].sort().forEach(key => {
  const missing = langs.filter(l => !(key in dicts[l]));
  if (missing.length === langs.length) {
    i18nMissing.push(`${key}：所有語系都沒有`);
  } else if (missing.length > 0) {
    i18nMissing.push(`${key}：缺 ${missing.join(', ')}`);
  }
});
report('i18n 翻譯鍵', i18nMissing);

// ---------- 總結 ----------
console.log('\n════════════════════════════════');
if (problems.length === 0) {
  console.log(' 全部串接檢查通過');
} else {
  console.log(` 共 ${problems.length} 個問題待處理`);
}
process.exit(problems.length === 0 ? 0 : 1);
