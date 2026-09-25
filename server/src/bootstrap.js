// bootstrap.js
//
// 全新安裝時要先有的工作表。其他表（請假、薪資、附件…）GS 程式第一次用到會自己建立，
// 只有這幾張是程式假設「本來就在」的，Apps Script 版是手動從範本
// GS/Attendance-System.ods 建立的。從舊試算表匯入時這些表本來就有，不會動到。

'use strict';

const CORE_SHEETS = {
  '員工名單': ['userId', 'email', 'name', 'picture', '首次登入時間', '職位', '薪', '狀態', '手動設定姓名'],
  '打卡紀錄': ['打卡時間', '打卡人員ＩＤ', '-', '打卡人員', '打卡類別', '打卡ＧＰＳ', '打卡地點', '備註', '管理員審核', '裝置'],
  'Session': ['token', 'userId', '建立時間', 'expiredAt'],
  '打卡地點表': ['地點代號', '地點名稱', 'GPS(緯度)', 'GPS(經度)', '容許誤差(公尺)'],
  '補打卡申請': ['申請ID', '用戶ID', '姓名', '日期', '時間', '類型', '原因', '狀態', '申請時間', '審核人', '審核時間']
};

/** 建立缺少的核心工作表，回傳這次建立的表名 */
function ensureCoreSheets(runtime) {
  const ss = runtime.context.SpreadsheetApp.getActiveSpreadsheet();
  const created = [];
  for (const [name, headers] of Object.entries(CORE_SHEETS)) {
    if (ss.getSheetByName(name)) continue;
    ss.insertSheet(name).appendRow(headers);
    created.push(name);
  }
  runtime.store.flush();
  return created;
}

module.exports = { CORE_SHEETS, ensureCoreSheets };
