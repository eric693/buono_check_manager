// salary.html 用的 Tailwind 設定。
// 薪資頁原本用 cdn.tailwindcss.com 在瀏覽器裡即時編譯，這裡改成事先編好的
// tailwind.salary.css。Tailwind 只會輸出在下面這些檔案裡「看得到完整字串」的 class，
// 所以不要用 'text-' + color 這種拼接方式產生 class 名稱。
//
// 改了薪資頁或下列任一支 js 的 class 之後要重新產生：
//   bash tools/build-tailwind.sh
// node tools/wiring-check.js 會檢查產出檔是否還跟得上原始碼。
module.exports = {
  darkMode: 'class',
  content: [
    './salary.html',
    './config.js',
    './api.js',
    './utils.js',
    './libs.js',
    './i18n.js',
    './worktime.js',
    './help.js',
    './script.js',
    './payslip.js',
    './salary.js',
    './salary-admin.js',
    './pwa.js'
  ],
  theme: { extend: {} },
  plugins: []
};
