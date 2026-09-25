// 測試區專用的 config.js（nginx 用這支取代 repo 根目錄的 config.js，見 nginx-staging.conf）
//
// 跟正式的 config.js 只差網址：API 走同一個網域的 /exec（自架後端），
// 前端網址是測試區自己。其他設定要跟 config.js 保持一致。
const API_CONFIG = {
  apiUrl: window.location.origin + '/exec',
  redirectUrl: window.location.origin + '/',
  useHttpPost: true,
  workSchedule: {
    start: '08:30',
    end: '17:30',
    lunchStart: '12:00',
    lunchEnd: '13:00'
  }
};
const apiUrl = API_CONFIG.apiUrl;
