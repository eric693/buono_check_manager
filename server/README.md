# 自架後端（取代 Google Apps Script）

`GS/*.gs` 原本跑在 Google Apps Script、資料存在 Google 試算表。這個資料夾是一層 Apps Script
相容層，讓同一份 GS 程式**幾乎不改**就能跑在自己的伺服器上，資料改存 SQLite。

- 前端不用改，只要把 `config.js` 的 `apiUrl` 換成這台伺服器的 `/exec`
- 改後端還是改 `GS/*.gs`，`git pull` 後重啟服務就生效，不用再貼到 Apps Script
- 試算表的每張工作表在資料庫裡還是一張表，欄位順序不變，舊資料可以直接匯入

## 運作方式

| Apps Script | 這裡的做法 |
|---|---|
| SpreadsheetApp | SQLite（`src/spreadsheet.js`），連寫入時的自動轉型都照試算表：`"2026-09"` 讀回來是日期、`"0912…"` 是數字 |
| PropertiesService | SQLite 的 `script_properties` 表 |
| CacheService、LockService | 記憶體；只有一個行程、請求依序處理，所以不需要真的鎖 |
| UrlFetchApp | curl（GS 程式預期同步回傳） |
| DriveApp | 本機資料夾 `DATA_DIR/drive`（附件、匯出的 Excel） |
| doGet / doPost | `src/server.js` 組出一樣的 `e` 物件再呼叫 |

跟 Apps Script 不同、刻意加上的：

- **LINE webhook 簽章驗證**：Apps Script 讀不到 HTTP 標頭所以一直沒驗。設定
  `LINE_MESSAGING_CHANNEL_SECRET` 後，簽章不符的請求一律拒絕。
- **薪資總表匯出**：直接產生 .xlsx 存在伺服器上，回傳 `/files/<隨機 ID>/` 下載連結，
  不再建立公開的 Google 試算表。

## 開發

```bash
cd server
npm install
npm test                                  # 相容層與各功能流程的測試
DATA_DIR=/tmp/buono PORT=8041 npm start   # 本機試跑
```

## 部署（以測試區 staging 為例，正式區把 staging 換成 production）

```bash
# 1. 程式：repo 的 clone（跟開發用的資料夾分開）
git clone /root/project/buono/Bryan_check_manager /root/project/buono/deploy/staging -b staging
cd /root/project/buono/deploy/staging/server && npm ci --omit=dev

# 2. 設定：/root/project/buono/deploy/staging.env
PORT=8041
DATA_DIR=/root/project/buono/deploy/data-staging
PUBLIC_BASE_URL=https://buono-staging.crownai.ink
FRONTEND_URL=https://buono-staging.crownai.ink/

# 3. 服務與每日備份
cp server/deploy/buono@.service server/deploy/buono-backup@.* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now buono@staging buono-backup@staging.timer

# 4. 網站（DNS 指到這台之後）
cp server/deploy/nginx-staging.conf /etc/nginx/sites-available/buono-staging.crownai.ink
ln -s /etc/nginx/sites-available/buono-staging.crownai.ink /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d buono-staging.crownai.ink
```

更新程式：`git -C /root/project/buono/deploy/staging pull && systemctl restart buono@staging`

## 從 Google 試算表搬資料

```bash
systemctl stop buono@staging
cd /root/project/buono/deploy/staging/server
export $(cat /root/project/buono/deploy/staging.env | xargs)
node scripts/import-xlsx.js 下載的試算表.xlsx            # 試跑：只列出會匯入什麼
node scripts/import-xlsx.js 下載的試算表.xlsx --replace  # 真的匯入（會先備份現有資料庫）
systemctl start buono@staging
```

試算表在 Google 選「檔案 → 下載 → Microsoft Excel (.xlsx)」。
Google 雲端硬碟裡的附件檔案不在試算表裡，不會一起搬過來（附件表的紀錄會在，但點開會找不到檔案）。

## 指令碼屬性（LINE 金鑰等）

Apps Script「專案設定 → 指令碼屬性」裡的值要重新設定一次，設定後重啟服務：

```bash
node scripts/properties.js set LINE_CHANNEL_ID ...                 # LINE Login channel
node scripts/properties.js set LINE_CHANNEL_SECRET ...             # LINE Login channel
node scripts/properties.js set LINE_CHANNEL_ACCESS_TOKEN ...       # Messaging API channel
node scripts/properties.js set LINE_MESSAGING_CHANNEL_SECRET ...   # Messaging API channel（驗證 webhook）
node scripts/properties.js set LINE_REDIRECT_URL https://buono-staging.crownai.ink/   # 測試區才需要
node scripts/properties.js list
```

LINE 那邊要改的：

- LINE Login channel 的 Callback URL 加上前端網址（測試區：`https://buono-staging.crownai.ink/`）
- Messaging API channel 的 Webhook URL 改成 `https://<網域>/exec`（**正式切換時才改**，改了 LINE Bot 就會打到新後端）

## 其他維運

```bash
node scripts/run.js 函式名稱            # 執行某一支 GS 函式（取代 Apps Script 編輯器的「執行」）
node scripts/backup.js                  # 手動備份（每天 3:15 也會自動備份，保留 30 份）
journalctl -u buono@staging -f          # 看記錄
```

還原備份：停服務 → 解開 `DATA_DIR/backups/buono-日期.tar.gz` 覆蓋 `DATA_DIR` 裡的
`buono.sqlite` 與 `drive/` → 刪掉 `buono.sqlite-wal`、`buono.sqlite-shm` → 啟動服務。

## 已知限制

- 只能跑一個行程（見上面 LockService）。以一間公司幾十位員工的量綽綽有餘：一年約 2.6 萬筆打卡時，
  查詢本人出勤約 30 ms、打卡寫入約 80 ms。
- LINE 圖文選單的設定工具（LineBotPunch.gs 裡用 Google 簡報產生圖片那段）需要 Google OAuth，
  在這裡不能用；圖文選單已經設定好，平常用不到。
