// config.js

const API_CONFIG = {
  // 正式環境的 API URL
  apiUrl: "https://script.google.com/macros/s/AKfycbxf6v0b4dN2XKqRj2SkTywvLuJRiLYwmFtdtHMQKNs0LuptSvgkYMdfEpqt1EyGi9Az/exec",
  
  // 新增回呼網址
  redirectUrl: "https://eric693.github.io/buono_check_manager/",
  
  // 是否改用 POST 呼叫後端。
  // GET 會把 sessionToken 留在網址列、瀏覽器歷史與各層存取紀錄裡；POST 放在請求主體就不會。
  // 開啟之前必須先重新部署 Apps Script（Main.gs 的 doPost 已經會把表單請求轉給 doGet 路由），
  // 部署完成、確認打卡與查詢都正常之後，再把這個值改成 true。
  useHttpPost: false,
  
  // 標準工作時段的「預設值」，用來計算請假時數。
  // 請假只計算落在工作時段內的時間，跨夜與例假日不計。
  // 實際生效的值由管理員在網頁版的「工作時段設定」調整，存在後端「系統設定」
  // 工作表；登入後 worktime.js 會把後端的值覆寫到這裡。這組只在還沒跟後端
  // 要到設定之前使用，要改預設值請同步 GS/LeaveManagement.gs 的
  // DEFAULT_WORK_SCHEDULE。
  workSchedule: {
    start: '08:30',      // 上班
    end: '17:30',        // 下班
    lunchStart: '12:00', // 午休開始
    lunchEnd: '13:00'    // 午休結束
  }
  // 你也可以在這裡加入其他設定，例如：
  // timeout: 5000,
  // version: 'v4.6.0'
};
//  新增：為了兼容性，同時定義全域變數 apiUrl
const apiUrl = API_CONFIG.apiUrl;
