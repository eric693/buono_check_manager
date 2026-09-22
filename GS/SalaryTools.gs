// SalaryTools.gs
//
// 管理員的薪資批次工具：
//   1. 批次計算整個公司的月薪資
//   2. 把一位員工的薪資設定複製到其他員工
//
// 這兩個都只是把既有的 calculateMonthlySalary / setEmployeeSalaryTW 包起來跑迴圈，
// 計算邏輯完全沿用單筆的版本，不另外實作一套，避免兩邊算出來不一樣。

// Apps Script 單次執行上限是 6 分鐘，一次算太多人會被砍掉，
// 所以批次計算採分段進行，前端拿 nextIndex 再呼叫一次。
const BATCH_SALARY_DEFAULT_LIMIT = 10;
const BATCH_SALARY_MAX_LIMIT = 30;

/**
 * 取得所有有薪資設定、且狀態為在職的員工
 */
function listPayableEmployees_() {
  const sheet = getEmployeeSalarySheet();
  const data = sheet.getDataRange().getValues();

  if (data.length < 2) return [];

  const headers = data[0].map(h => String(h).trim());
  const idIndex = headers.indexOf('員工ID');
  const nameIndex = headers.indexOf('員工姓名');
  const statusIndex = headers.indexOf('狀態');
  const typeIndex = headers.indexOf('薪資類型');

  if (idIndex === -1) return [];

  const employees = [];

  for (let i = 1; i < data.length; i++) {
    const employeeId = String(data[i][idIndex] || '').trim();
    if (!employeeId) continue;

    // 沒有狀態欄就一律視為在職（舊資料）
    const status = (statusIndex === -1) ? '在職' : String(data[i][statusIndex] || '在職').trim();
    if (status && status !== '在職') continue;

    employees.push({
      employeeId: employeeId,
      employeeName: (nameIndex === -1) ? '' : String(data[i][nameIndex] || '').trim(),
      salaryType: (typeIndex === -1) ? '月薪' : String(data[i][typeIndex] || '月薪').trim()
    });
  }

  return employees;
}

/**
 * API：批次計算薪資（僅管理員）
 *
 * 參數：yearMonth（必填）、startIndex（預設 0）、limit（預設 10，最多 30）
 * 回傳 nextIndex，不是 null 就代表還沒算完，前端要帶著它再呼叫一次。
 */
function handleBatchCalculateSalary(params) {
  try {
    const user = getUserByToken(params.token);
    if (!user || user.dept !== '管理員') {
      return { ok: false, code: 'PERMISSION_DENIED', msg: '此功能僅限管理員使用' };
    }

    const yearMonth = String(params.yearMonth || '').trim();
    if (!/^\d{4}-\d{2}$/.test(yearMonth)) {
      return { ok: false, code: 'INVALID_YEAR_MONTH', msg: '年月格式錯誤，請使用 YYYY-MM' };
    }

    const employees = listPayableEmployees_();
    const total = employees.length;

    if (total === 0) {
      return { ok: true, msg: '沒有可計算的員工', total: 0, results: [], nextIndex: null };
    }

    let startIndex = parseInt(params.startIndex, 10);
    if (isNaN(startIndex) || startIndex < 0) startIndex = 0;

    let limit = parseInt(params.limit, 10);
    if (isNaN(limit) || limit <= 0) limit = BATCH_SALARY_DEFAULT_LIMIT;
    limit = Math.min(limit, BATCH_SALARY_MAX_LIMIT);

    const endIndex = Math.min(startIndex + limit, total);
    const results = [];

    Logger.log(` 批次計算 ${yearMonth}：第 ${startIndex + 1} 到 ${endIndex} 人（共 ${total} 人）`);

    for (let i = startIndex; i < endIndex; i++) {
      const employee = employees[i];

      // 單一員工失敗不能拖垮整批，記下原因繼續跑下一個
      try {
        const calculated = calculateMonthlySalary(employee.employeeId, yearMonth);

        if (!calculated.success) {
          results.push({
            employeeId: employee.employeeId,
            employeeName: employee.employeeName,
            ok: false,
            msg: calculated.message || '計算失敗'
          });
          continue;
        }

        const saved = saveMonthlySalary(calculated.data);

        results.push({
          employeeId: employee.employeeId,
          employeeName: employee.employeeName,
          ok: !!saved.success,
          msg: saved.success ? '' : (saved.message || '儲存失敗'),
          salaryType: calculated.data.salaryType,
          grossSalary: calculated.data.grossSalary,
          netSalary: calculated.data.netSalary
        });

      } catch (error) {
        Logger.log(` ${employee.employeeName} 計算失敗: ${error.message}`);
        results.push({
          employeeId: employee.employeeId,
          employeeName: employee.employeeName,
          ok: false,
          msg: error.message
        });
      }
    }

    const nextIndex = (endIndex < total) ? endIndex : null;

    return {
      ok: true,
      yearMonth: yearMonth,
      total: total,
      processed: endIndex,
      nextIndex: nextIndex,
      results: results,
      msg: nextIndex === null
        ? `已完成 ${total} 位員工的薪資計算`
        : `已計算 ${endIndex} / ${total} 位`
    };

  } catch (error) {
    Logger.log(` handleBatchCalculateSalary 錯誤: ${error.message}`);
    return { ok: false, msg: error.toString() };
  }
}

// 可複製的欄位分組。身分證、銀行帳號、到職日這類個人資料刻意不在裡面，
// 複製薪資設定不該把別人的帳號也蓋過去。
const SALARY_COPY_GROUPS = {
  base: ['員工類型', '薪資類型', '基本薪資', '發薪日'],
  allowances: ['職務加給', '伙食費', '交通補助', '全勤獎金', '業績獎金', '其他津貼'],
  deductions: ['勞退自提率(%)', '勞保費', '健保費', '就業保險費', '勞退自提', '所得稅',
               '福利金扣款', '宿舍費用', '團保費用', '其他扣款']
  // custom 另外處理，它是單一 JSON 欄
};

/**
 * API：把一位員工的薪資設定複製到其他員工（僅管理員）
 *
 * 參數：
 *   sourceEmployeeId - 來源員工
 *   targetEmployeeIds - JSON 陣列，目標員工（必須已經有薪資設定）
 *   groups - JSON 陣列，要複製哪幾組：base / allowances / deductions / custom
 */
function handleCopySalaryConfig(params) {
  try {
    const user = getUserByToken(params.token);
    if (!user || user.dept !== '管理員') {
      return { ok: false, code: 'PERMISSION_DENIED', msg: '此功能僅限管理員使用' };
    }

    const sourceId = String(params.sourceEmployeeId || '').trim();
    if (!sourceId) {
      return { ok: false, code: 'MISSING_SOURCE', msg: '請選擇來源員工' };
    }

    let targetIds = [];
    let groups = [];
    try {
      targetIds = JSON.parse(params.targetEmployeeIds || '[]');
      groups = JSON.parse(params.groups || '[]');
    } catch (error) {
      return { ok: false, code: 'INVALID_PARAMS', msg: '參數格式錯誤' };
    }

    if (!Array.isArray(targetIds) || targetIds.length === 0) {
      return { ok: false, code: 'MISSING_TARGETS', msg: '請選擇要套用的員工' };
    }
    if (!Array.isArray(groups) || groups.length === 0) {
      return { ok: false, code: 'MISSING_GROUPS', msg: '請選擇要複製的項目' };
    }

    const sourceResult = getEmployeeSalaryTW(sourceId);
    if (!sourceResult.success) {
      return { ok: false, code: 'SOURCE_NOT_FOUND', msg: '找不到來源員工的薪資設定' };
    }
    const source = sourceResult.data;

    const sheet = getEmployeeSalarySheet();
    const data = sheet.getDataRange().getValues();
    const headers = data[0].map(h => String(h).trim());

    // 把要複製的欄位名稱攤平成一份清單
    const columnsToCopy = [];
    groups.forEach(group => {
      if (group === 'custom') {
        columnsToCopy.push(SALARY_CUSTOM_ITEMS_COLUMN);
      } else if (SALARY_COPY_GROUPS[group]) {
        SALARY_COPY_GROUPS[group].forEach(name => columnsToCopy.push(name));
      }
    });

    if (columnsToCopy.length === 0) {
      return { ok: false, code: 'MISSING_GROUPS', msg: '沒有可複製的欄位' };
    }

    const results = [];
    let updatedCount = 0;

    targetIds.forEach(rawTargetId => {
      const targetId = String(rawTargetId || '').trim();
      if (!targetId || targetId === sourceId) return;

      let rowIndex = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]).trim() === targetId) {
          rowIndex = i + 1;
          break;
        }
      }

      if (rowIndex === -1) {
        results.push({ employeeId: targetId, ok: false, msg: '該員工尚未建立薪資設定' });
        return;
      }

      columnsToCopy.forEach(columnName => {
        const columnIndex = headers.indexOf(columnName);
        if (columnIndex === -1) return;  // 舊試算表沒有這一欄就略過
        sheet.getRange(rowIndex, columnIndex + 1).setValue(source[columnName]);
      });

      // 更新時間要跟著動，不然看不出這筆被改過
      const updatedAtIndex = headers.indexOf('最後更新時間');
      if (updatedAtIndex !== -1) {
        sheet.getRange(rowIndex, updatedAtIndex + 1).setValue(new Date());
      }

      updatedCount++;
      results.push({ employeeId: targetId, ok: true, msg: '' });
    });

    Logger.log(` 管理員 ${user.name} 從 ${sourceId} 複製薪資設定到 ${updatedCount} 位員工`);

    return {
      ok: true,
      msg: `已套用到 ${updatedCount} 位員工`,
      updatedCount: updatedCount,
      results: results
    };

  } catch (error) {
    Logger.log(` handleCopySalaryConfig 錯誤: ${error.message}`);
    return { ok: false, msg: error.toString() };
  }
}

/**
 * API：取得可批次操作的員工清單（僅管理員）
 */
function handleListPayableEmployees(params) {
  try {
    const user = getUserByToken(params.token);
    if (!user || user.dept !== '管理員') {
      return { ok: false, code: 'PERMISSION_DENIED', msg: '此功能僅限管理員使用' };
    }

    return { ok: true, employees: listPayableEmployees_() };

  } catch (error) {
    Logger.log(` handleListPayableEmployees 錯誤: ${error.message}`);
    return { ok: false, msg: error.toString() };
  }
}
