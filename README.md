# 出勤管家

以 **LINE Login** 登入、**Google Apps Script + 試算表** 當後端的出勤與薪資系統。
員工用手機打卡、請假、看薪資單；管理員審核申請、排班、算薪、匯報表。

前端是純靜態檔案（部署在 GitHub Pages），後端是一份 Apps Script 專案，資料全部
存在同一個 Google 試算表裡。沒有資料庫、沒有伺服器要維運。

---

## 功能

### 出勤
- **LINE 登入**：以 LINE 帳號認證身分
- **不用 LINE 登入**：LINE 不能用（或沒有 LINE）的員工，由管理員產生一次性「登入連結」，在自己的手機打開就登入。也可以直接新增不使用 LINE 的員工
- **一天兩組上下班**：餐飲業兩頭班休息前要打卡，同一天可以「上班 → 下班 → 上班 → 下班」。系統會擋下順序錯誤或連按兩次的打卡
- **首頁「今天」卡片**：今天的班、已打的卡、下一張該打什麼、今天有沒有請假、這週每天的工時
- **GPS 打卡**：上下班打卡，會檢查是否在允許的地點範圍內
- **QR Code 打卡**：管理員產生限時 QR Code，員工掃碼打卡。代碼由後端簽章，無法自行偽造
- **平板打卡**：公司平板開啟 `kiosk.html` 後放著，同時顯示上班／下班 QR Code，每 30 秒自動更新（代碼 3 分鐘失效）。平板用專用金鑰，不登入帳號，管理員可隨時重設或停用
- **LINE Bot 打卡**：在 LINE 對話中直接打卡，或用一次性連結開網頁打卡
- **生物辨識**：支援裝置的指紋／臉部辨識做二次確認
- **補打卡**：當日調整與歷史補登，都要經管理員審核
- **異常提醒**：忘記打卡、遲到早退會標示出來
- **打卡失敗紀錄**：每一次打卡失敗（不在範圍內、順序不對、連線逾時等）都記在「打卡失敗紀錄」，員工說打不了卡時可以查原因。尖峰時段連線忙碌會自動重試

### 申請與審核
- **加班申請**：平日／休息日／例假日／國定假日分別計費
- **請假申請**：15 種假別、額度管理、時數自動計算（跳過非工作日與午休）
- **工作日誌**：每日工時與內容，主管審核
- **費用申請**：預支（先向公司借款）與報銷（代墊後請款，可附發票照片），管理員審核
- **附件**：請假的診斷證明、加班的佐證可以上傳（圖片或 PDF，3 MB 內）

### 排班
- 單筆新增、批次匯入、月曆檢視、時數統計，可以刪除單一班次（重複排班時不用整個重置）
- **班別設定**：班別代碼、上下班時間、跨日、休息分鐘（兩頭班的中間休息）。工時會扣掉排班的休息時間
- 排班影響早退判定與薪資計算

### 薪資
- **月薪／時薪**自動計算：工時、加班費、請假扣薪、早退扣款
- **勞健保**：依投保級距表自動計算
- **所得稅**：依級距自動計算（月薪可選自動或手填）
- **自訂項目**：公司可自行定義津貼與扣款項目
- **批次計算**：一次算完全公司，分批執行避開 Apps Script 執行上限
- **設定複製**：把一位員工的薪資條件套用到其他人
- **計薪規則**：全勤獎金（遲到、忘卡、請假的門檻）、餐費、生日禮金，正職與兼職分開設定；每張薪資單都寫明有沒有全勤與原因。另可逐張填銷售獎金、預支抵扣、手動加減項目與備註
- **手動薪資單**：系統上線前的月份（或特殊情況）可以直接輸入金額產生薪資單
- **三節獎金**記錄
- **薪資單**：線上檢視、列印、員工簽收；時薪人員顯示時薪
- **薪資發放**：存好的薪資單都是草稿，員工看不到。管理員在「薪資發放」核對整個月的清單（金額合計、誰還沒有薪資單），確認後統一發放，員工才看得到並收到 LINE 通知。可撤回發放、重新發送通知（會顯示 LINE 沒送出的原因），還沒發放的草稿可以刪除
- **薪資設定管理**：可刪除員工的薪資設定；同一人重複的設定在儲存時自動合併
- **異動記錄**：每次薪資單被覆寫都留下「哪一欄、從多少改成多少、誰改的」
- **報表匯出**：個人與全員的出勤、薪資報表（Excel）

### 管理
- **資料管理**（`records.html`）：直接在網頁上查詢與修改打卡紀錄、工時明細（可下載 CSV、列印）、假期餘額、請假與加班紀錄，也能查看、修改這份試算表裡的各資料表，不用打開 Google 試算表。每筆修改都記在操作紀錄（含修改前的內容）；登入資料表不顯示，身分證、帳號類欄位會遮蔽
- **即時出勤數據**：選一天，看上班打卡（已到／應到）、未打卡、遲到、請假、下班打卡、加班，點開有名單
- 公告發布
- 員工角色管理（管理員／排班人員／員工）
- 員工姓名：員工在「我的基本資料」填真實姓名（管理員也能在員工管理修改），之後打卡紀錄與報表都顯示真實姓名，LINE 改名不會蓋掉；舊的打卡紀錄也會跟著顯示新姓名
- 打卡地點設定（座標與半徑）
- 離職處理：標記狀態、作廢登入、排除薪資計算，可復職。離職的人無法再用 LINE 重新登入
- 出勤分析圖表
- 操作紀錄：審核、權限、員工、排班、薪資設定等管理操作，記下誰在什麼時候做了什麼（身分證字號、帳號會遮蔽）

### 系統
- **多國語系**：繁中、英、日、韓、越、泰、印尼
- **PWA**：可安裝到手機主畫面，離線仍可開啟
- **操作說明**：每個功能頁內建可收合的說明，另有整合的[使用手冊](manual.html)
- **LINE 通知**：打卡成功、忘記打卡、各類申請的核准與拒絕、薪資條發放都會推播
  > 推播會算進 LINE 官方帳號每月的訊息額度（免費方案則數很少，打卡成功通知很快就會用完）。額度用完時打卡照常，只是收不到推播；員工在 LINE 裡收到的打卡連結、查詢回覆不算額度
- **打卡紀錄封存**：每月把上上個月以前的打卡搬到按年份分的封存分頁（`打卡紀錄_2026`），主表保持很小，打卡和查詢才不會越用越慢。報表、薪資、資料管理會自動一起讀封存分頁

---

## 設定與部署

### 1. Google Apps Script
1. 建立 Google 試算表，從「擴充功能 → Apps Script」開啟專案
2. 把 `GS/` 底下所有 `.gs` 貼進去
3. 在「專案設定 → 指令碼屬性」填入：
   - `LINE_CHANNEL_ID`、`LINE_CHANNEL_SECRET`（LINE Login）
   - `LINE_CHANNEL_ACCESS_TOKEN`（LINE Bot 推播，選用）
4. 部署為「網頁應用程式」，執行身分選自己，存取權限選「任何人」
5. 記下部署網址
6. 在編輯器執行一次 `installAttendanceArchiveTrigger()`，裝上每月自動封存打卡紀錄的排程

工作表會在第一次用到時自動建立，不需要手動準備。

**確認部署是否完整**：打開 `部署網址?action=healthCheck`（不用登入）。
`ok: true` 代表每個 `.gs` 都在而且是最新版；`missingOrOutdated` 會列出缺少或還是舊版的檔案，
`version` 是後端版本（`GS/Main.gs` 的 `BACKEND_VERSION`），`attendanceArchiveTrigger` 顯示自動封存有沒有裝。
更新後端時只貼了部分檔案，常見的狀況是某個功能出現「xxx is not defined」，用這個檢查就能找到漏掉的檔案。

### 2. LINE Developers
1. 建立 LINE Login 頻道，記下 Channel ID 與 Secret
2. 回呼網址填前端部署網址（例如 `https://你的帳號.github.io/你的repo/`）
3. 要用 LINE Bot 的話另外建立 Messaging API 頻道，Webhook 指向 Apps Script 部署網址

### 3. 前端
1. 編輯 `config.js`：
   - `apiUrl` → Apps Script 部署網址
   - `redirectUrl` → 前端網址（要與 LINE 回呼網址一致）
2. 把所有檔案推到 GitHub Pages 或其他靜態託管

> **改了 `GS/` 底下的檔案要重新部署 Apps Script 才會生效**，前端則是推上去就生效。
> 兩邊不會同時更新，所以 `api.js` 在 POST 打不通時會自動退回 GET。

---

## 開發

### 檢查工具
```bash
npm install jsdom          # 只需要裝一次

node tools/wiring-check.js     # 串接檢查：前端 action ↔ 後端路由 ↔ handler ↔ DOM ↔ i18n
node tools/smoke-test.js       # 冒煙測試：用 jsdom 跑過整個頁面
node tools/smoke-test.js salary.html
```

`wiring-check.js` 會擋下這些問題：
- 前端呼叫了不存在的 action，或 handler 沒掛上路由
- 前端或後端有同名函式重複定義（Apps Script 是後載入的蓋掉先載入的，很難查）
- 「月薪資記錄」的欄位名稱與實際寫入順序對不上
- 測試函式散落在正式模組裡
- 缺少的 i18n 翻譯鍵、缺少容器的操作說明模組、PWA 資源缺漏

送出改動前兩個都跑一次。

### 檔案結構

```text
├── index.html              主頁（打卡、出勤、加班、請假、工作日誌、管理員）
├── salary.html             薪資管理（我的薪資／設定／試算／報表）
├── shift.html              排班管理
├── kiosk.html              公司平板的打卡頁（常駐顯示 QR Code）
├── records.html            資料管理（管理員：打卡、工時、假期、請假、加班、所有資料表）
├── manual.html             使用手冊（由操作說明資料自動彙整）
│
├── config.js               API 網址與環境設定
├── api.js                  所有後端呼叫的唯一入口（GET/POST 切換）
├── script.js               主頁邏輯
├── my-today.js             首頁「今天」卡片
├── attendance-dashboard.js 管理員頁的即時出勤數據
├── records.js              資料管理頁
├── announcements.js        公告
├── audit-log.js            管理員分頁的操作紀錄
├── expense.js              費用申請（預支／報銷）與審核
├── users.js                員工管理、離職處理
├── punch-adjust.js         補打卡
├── qr-punch.js             QR Code 與 LINE Bot 網頁打卡、平板打卡設定
├── kiosk.js                平板打卡頁
├── attachments.js          申請單附件
├── leave.js / overtime.js / worklog.js / shift.js
├── salary.js               薪資明細與設定表單
├── salary-admin.js         公司層級設定、批次計算、複製設定、手動薪資單、薪資發放、稽核查詢
├── worktime.js             工作時段設定
├── payslip.js / reports.js / analytics.js
├── i18n.js / help.js       語系與操作說明
├── pwa.js / sw.js / manifest.webmanifest
├── utils.js / libs.js / holidays.js / biometric.js / location-picker.js
│
├── i18n/                   介面語系檔（7 種語言）
│   └── help/               操作說明內容（同樣 7 種）
├── icons/                  PWA 圖示
├── tools/                  檢查工具
│
└── GS/                     Apps Script 後端
    ├── Main.gs             doGet / doPost 路由
    ├── Constants.gs        工作表名稱、假別、系統常數
    ├── Handlers.gs         API handler
    ├── DbOperations.gs     打卡、Session、員工資料
    ├── PunchRules.gs       一天兩組上下班的順序規則、工時配對、打卡失敗紀錄
    ├── LoginLinks.gs       不用 LINE 的登入連結、不使用 LINE 的員工
    ├── QrPunch.gs          QR 代碼簽章與驗證、平板金鑰
    ├── MyToday.gs          首頁「今天」卡片
    ├── AttendanceDashboard.gs 即時出勤數據
    ├── AttendanceArchive.gs   打卡紀錄每月封存
    ├── RecordsAdmin.gs     資料管理頁
    ├── SystemSettings.gs   工作時段、加班倍率、投保級距、所得稅、自訂項目
    ├── SalaryManagement.gs 薪資計算核心
    ├── SalaryTools.gs      批次計算、設定複製、刪除薪資設定
    ├── PayrollRules.gs     計薪規則（全勤、餐費、生日禮金）與逐張調整
    ├── ManualPayslip.gs    手動薪資單
    ├── PayrollPublish.gs   薪資發放（草稿／發放／撤回、LINE 通知）
    ├── ShiftTemplates.gs   班別設定與休息時間
    ├── EmployeeSheetRepair.gs 員工名單欄位錯位的修復工具
    ├── Dailysalary.gs      日薪
    ├── AdminTools.gs / DatabaseSetup.gs  手動執行的初始化工具（假期額度、資料表結構）
    ├── AuditLog.gs         薪資異動記錄、管理操作記錄
    ├── Offboarding.gs      薪資簽收、離職處理
    ├── Attachments.gs      附件
    ├── Expense.gs          費用申請（預支／報銷）
    ├── LeaveManagement.gs / OvertimeOperations.gs / ShiftManagement.gs
    ├── WorklogOperations.gs / WorklogHandlers.gs
    ├── LineBotPunch.gs / LineNotification.gs / LineApi.gs
    ├── Utils.gs            共用工具（日期格式化、距離計算、讀取快取）
    └── Tests.gs            所有測試與除錯函式（手動執行，不在任何路徑上）
```

---

## 授權

見 [LICENSE](LICENSE)。
