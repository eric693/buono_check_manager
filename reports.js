// Excel 報表匯出：全員月報表、單月出勤報表、員工打卡明細
// 從 script.js 拆出。SheetJS 由 libs.js 的 ensureLib('xlsx') 延遲載入。

// 欄位名稱跟著介面語言；中文的翻譯和原本寫死的欄位名稱一字不差，中文報表不變
function reportColumns() {
    return {
        date: t('RPT_DATE'), weekday: t('RPT_WEEKDAY'),
        inTime: t('RPT_IN_TIME'), inPlace: t('RPT_IN_PLACE'),
        outTime: t('RPT_OUT_TIME'), outPlace: t('RPT_OUT_PLACE'),
        inTime2: t('RPT_IN_TIME_2'), outTime2: t('RPT_OUT_TIME_2'),
        allPunches: t('RPT_ALL_PUNCHES'),
        workHours: t('RPT_WORK_HOURS'), hoursDecimal: t('RPT_HOURS_DECIMAL'),
        status: t('RPT_STATUS'), notes: t('RPT_NOTES')
    };
}

/**
 * 一天的打卡整理成報表用的欄位。
 *
 * 以前只取第一張上班卡、第一張下班卡：兩頭班（上班 → 下班休息 → 上班 → 下班）的第二段
 * 整個不見，工時也只是那兩張卡相減。現在：
 *   ・依時間把算數的卡（一般打卡、已核准的補打卡）配成工作段，第一段、第二段各自一組欄位
 *   ・「全部打卡」列出當天每一張卡，配不起來的也看得到
 *   ・工時用後端算好的（跟薪資同一套規則，扣排班的休息）；舊版後端沒有這個值才自己算
 */
function reportDayInfo(record) {
    const punches = (record.record || []).slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const counted = punches.filter(p => p.note !== '補打卡' || p.audit === 'v');
    const segments = [];
    let open = null;
    counted.forEach(p => {
        if (p.type === '上班') {
            if (!open) open = p;
        } else if (open) {
            segments.push({ in: open, out: p });
            open = null;
        }
    });
    if (open) segments.push({ in: open, out: null });
    // 只有下班卡（忘了打上班）也要看得到
    if (!segments.length && counted.length) segments.push({ in: null, out: counted.find(p => p.type === '下班') || null });

    let hours = parseFloat(record.workHours);
    if (isNaN(hours)) {
        hours = 0;
        segments.forEach(seg => {
            if (!seg.in || !seg.out) return;
            const diff = (new Date(`${record.date} ${seg.out.time}`) - new Date(`${record.date} ${seg.in.time}`)) / 3600000;
            if (diff > 0) hours += diff;
        });
    }

    const typeLabel = type => type === '上班' ? t('PUNCH_IN') : t('PUNCH_OUT');
    const allPunches = punches.map(p => {
        const pending = p.note === '補打卡' && p.audit !== 'v' ? t('RPT_PUNCH_NOT_COUNTED') : '';
        return `${typeLabel(p.type)} ${p.time}${pending}`;
    }).join('、');
    const notes = [...new Set(punches.filter(p => p.note && p.note !== '系統虛擬卡').map(p => p.note))].join('; ');
    const firstIn = counted.find(p => p.type === '上班');
    const lastOut = counted.filter(p => p.type === '下班').pop();

    return {
        seg1: segments[0] || null,
        seg2: segments[1] || null,
        inPlace: firstIn ? firstIn.location : '',
        outPlace: lastOut ? lastOut.location : '',
        allPunches: allPunches,
        hours: hours,
        notes: notes
    };
}

function reportTime(punch, withSeconds) {
    if (!punch) return '-';
    const time = String(punch.time || '');
    return withSeconds && /^\d{1,2}:\d{2}$/.test(time) ? `${time}:00` : time;
}

/**
 * 管理員匯出所有員工的出勤報表
 * @param {string} monthKey - 月份，格式: "YYYY-MM"
 */
async function exportAllEmployeesReport(monthKey) {
    await ensureLib('xlsx'); // 匯出時才載入 SheetJS
    const exportBtn = document.getElementById('admin-export-all-btn');
    const loadingText = t('EXPORT_LOADING') || '正在準備報表...';
    
    showNotification(loadingText, 'warning');
    
    if (exportBtn) {
        generalButtonState(exportBtn, 'processing', loadingText);
    }
    
    try {
        // 呼叫 API 取得所有員工的出勤資料（不傳 userId）
        const res = await callApifetch(`getAttendanceDetails&month=${monthKey}`);
        
        if (!res.ok || !res.records || res.records.length === 0) {
            showNotification(t('EXPORT_NO_DATA') || '本月沒有出勤記錄', 'warning');
            return;
        }
        
        //  修正：先檢查資料結構
        console.log('API 回傳的資料:', res.records[0]); // 除錯用
        
        // 按員工分組
        const employeeData = {};
        const col = reportColumns();
        
        res.records.forEach(record => {
            //  修正：確保正確讀取 userId 和 name
            const userId = record.userId || 'unknown';
            const userName = record.name || t('UNKNOWN_EMPLOYEE');
            
            if (!employeeData[userId]) {
                employeeData[userId] = {
                    name: userName,
                    records: []
                };
            }
            
            const day = reportDayInfo(record);
            const statusText = t(record.reason) || record.reason;
            
            employeeData[userId].records.push({
                [col.date]: record.date,
                [col.inTime]: reportTime(day.seg1 && day.seg1.in),
                [col.outTime]: reportTime(day.seg1 && day.seg1.out),
                [col.inTime2]: reportTime(day.seg2 && day.seg2.in),
                [col.outTime2]: reportTime(day.seg2 && day.seg2.out),
                [col.inPlace]: day.inPlace || '-',
                [col.workHours]: day.hours > 0 ? day.hours.toFixed(2) : '-',
                [col.status]: statusText,
                [col.allPunches]: day.allPunches || '-',
                [col.notes]: day.notes || '-'
            });
        });
        
        // 建立工作簿
        const wb = XLSX.utils.book_new();
        
        // 為每位員工建立一個工作表
        for (const userId in employeeData) {
            const employee = employeeData[userId];
            const ws = XLSX.utils.json_to_sheet(employee.records);
            
            const wscols = [
                { wch: 12 },  // 日期
                { wch: 10 },  // 上班時間
                { wch: 10 },  // 下班時間
                { wch: 12 },  // 上班時間（第二段）
                { wch: 12 },  // 下班時間（第二段）
                { wch: 16 },  // 地點
                { wch: 10 },  // 工作時數
                { wch: 15 },  // 狀態
                { wch: 48 },  // 全部打卡
                { wch: 20 }   // 備註
            ];
            ws['!cols'] = wscols;
            
            const sheetName = employee.name.substring(0, 31);
            XLSX.utils.book_append_sheet(wb, ws, sheetName);
        }
        
        const [year, month] = monthKey.split('-');
        const fileName = `${t('RPT_FILE_ALL', { year: year, month: month })}.xlsx`;
        XLSX.writeFile(wb, fileName);
        
        showNotification(t('EXPORT_SUCCESS') || '報表已成功匯出！', 'success');
        
    } catch (error) {
        console.error('匯出失敗:', error);
        showNotification(t('EXPORT_FAILED') || '匯出失敗，請稍後再試', 'error');
        
    } finally {
        if (exportBtn) {
            generalButtonState(exportBtn, 'idle');
        }
    }
}

// ====================  管理員匯出功能結束 ====================

// ====================  匯出出勤報表功能 ====================

/**
 * 匯出指定月份的出勤報表為 Excel 檔案
 * @param {Date} date - 要匯出的月份日期物件
 */
async function exportAttendanceReport(date) {
    await ensureLib('xlsx'); // 匯出時才載入 SheetJS
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const userId = localStorage.getItem("sessionUserId");
    
    // 取得匯出按鈕
    const exportBtn = document.getElementById('export-attendance-btn');
    const loadingText = t('EXPORT_LOADING') || '正在準備報表...';
    
    // 顯示載入提示
    showNotification(loadingText, 'warning');
    
    // 按鈕進入處理中狀態
    if (exportBtn) {
        generalButtonState(exportBtn, 'processing', loadingText);
    }
    
    try {
        // 呼叫 API 取得出勤資料
        const res = await callApifetch(`getAttendanceDetails&month=${monthKey}&userId=${userId}`);
        
        if (!res.ok || !res.records || res.records.length === 0) {
            showNotification(t('EXPORT_NO_DATA') || '本月沒有出勤記錄', 'warning');
            return;
        }
        
        // 整理資料為 Excel 格式
        const exportData = [];
        const col = reportColumns();
        
        res.records.forEach(record => {
            const day = reportDayInfo(record);
            const statusText = t(record.reason) || record.reason;
            
            exportData.push({
                [col.date]: record.date,
                [col.inTime]: reportTime(day.seg1 && day.seg1.in),
                [col.outTime]: reportTime(day.seg1 && day.seg1.out),
                [col.inTime2]: reportTime(day.seg2 && day.seg2.in),
                [col.outTime2]: reportTime(day.seg2 && day.seg2.out),
                [col.inPlace]: day.inPlace || '-',
                [col.workHours]: day.hours > 0 ? day.hours.toFixed(2) : '-',
                [col.status]: statusText,
                [col.allPunches]: day.allPunches || '-',
                [col.notes]: day.notes || '-'
            });
        });
        
        // 使用 SheetJS 建立 Excel 檔案
        const ws = XLSX.utils.json_to_sheet(exportData);
        
        // 設定欄位寬度
        const wscols = [
            { wch: 12 },  // 日期
            { wch: 10 },  // 上班時間
            { wch: 10 },  // 下班時間
            { wch: 12 },  // 上班時間（第二段）
            { wch: 12 },  // 下班時間（第二段）
            { wch: 16 },  // 地點
            { wch: 10 },  // 工作時數
            { wch: 15 },  // 狀態
            { wch: 48 },  // 全部打卡
            { wch: 20 }   // 備註
        ];
        ws['!cols'] = wscols;
        
        // 建立工作簿
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, t('RPT_SHEET_MINE', { month: month }).slice(0, 31));
        
        // 下載檔案
        const fileName = `${t('RPT_FILE_MINE', { year: year, month: month })}.xlsx`;
        XLSX.writeFile(wb, fileName);
        
        showNotification(t('EXPORT_SUCCESS') || '報表已成功匯出！', 'success');
        
    } catch (error) {
        console.error('匯出失敗:', error);
        showNotification(t('EXPORT_FAILED') || '匯出失敗，請稍後再試', 'error');
        
    } finally {
        // 恢復按鈕狀態
        if (exportBtn) {
            generalButtonState(exportBtn, 'idle');
        }
    }
}

// ====================  匯出功能結束 ====================

/**
 * 匯出員工打卡報表（含時分秒和每日總時數）
 */
async function exportEmployeePunchReport() {
    await ensureLib('xlsx'); // 匯出時才載入 SheetJS
    const employeeSelect = document.getElementById('analysis-employee');
    const monthInput = document.getElementById('analysis-month');
    const exportBtn = document.getElementById('export-employee-punch-btn');
    
    if (!employeeSelect || !monthInput) return;
    
    const employeeId = employeeSelect.value;
    const yearMonth = monthInput.value;
    
    if (!employeeId) {
        showNotification(t('NOTIF_SELECT_EMPLOYEE'), 'error');
        return;
    }
    
    if (!yearMonth) {
        showNotification(t('NOTIF_SELECT_MONTH'), 'error');
        return;
    }
    
    const loadingText = t('EXPORT_LOADING') || '正在準備報表...';
    showNotification(loadingText, 'warning');
    
    if (exportBtn) {
        generalButtonState(exportBtn, 'processing', loadingText);
    }
    
    try {
        // 取得員工名稱
        const employeeName = employeeSelect.options[employeeSelect.selectedIndex].text.split(' (')[0];
        
        // 呼叫後端 API 取得詳細打卡資料
        const res = await callApifetch(`getAttendanceDetails&month=${yearMonth}&userId=${employeeId}`);
        
        if (!res.ok || !res.records || res.records.length === 0) {
            showNotification(t('EXPORT_NO_DATA') || '本月沒有出勤記錄', 'warning');
            return;
        }
        
        // 整理資料為 Excel 格式
        const exportData = [];
        const col = reportColumns();
        
        res.records.forEach(record => {
            const day = reportDayInfo(record);
            let workHours = '-';
            if (day.hours > 0) {
                const hours = Math.floor(day.hours);
                const minutes = Math.round((day.hours - hours) * 60);
                workHours = t('RPT_HOURS_MINUTES', { h: hours, m: minutes });
            }
            const statusText = t(record.reason) || record.reason;
            
            exportData.push({
                [col.date]: record.date,
                [col.weekday]: getDayOfWeek(record.date),
                [col.inTime]: reportTime(day.seg1 && day.seg1.in, true),
                [col.outTime]: reportTime(day.seg1 && day.seg1.out, true),
                [col.inTime2]: reportTime(day.seg2 && day.seg2.in, true),
                [col.outTime2]: reportTime(day.seg2 && day.seg2.out, true),
                [col.inPlace]: day.inPlace || '-',
                [col.workHours]: workHours,
                [col.hoursDecimal]: day.hours > 0 ? day.hours.toFixed(2) : '-',
                [col.status]: statusText,
                [col.allPunches]: day.allPunches || '-',
                [col.notes]: day.notes || '-'
            });
        });
        
        // 計算統計資料
        const totalWorkHours = exportData.reduce((sum, row) => {
            const hours = parseFloat(row[col.hoursDecimal]);
            return sum + (isNaN(hours) ? 0 : hours);
        }, 0);
        
        const totalDays = exportData.filter(row => row[col.hoursDecimal] !== '-').length;
        const avgWorkHours = totalDays > 0 ? (totalWorkHours / totalDays).toFixed(2) : 0;
        
        // 新增統計行
        exportData.push({});
        exportData.push({
            [col.date]: t('RPT_SUMMARY'),
            [col.weekday]: '',
            [col.inTime]: '',
            [col.outTime]: '',
            [col.inTime2]: '',
            [col.outTime2]: '',
            [col.inPlace]: '',
            [col.workHours]: t('RPT_TOTAL_DAYS', { n: totalDays }),
            [col.hoursDecimal]: totalWorkHours.toFixed(2),
            [col.status]: t('RPT_AVERAGE', { n: avgWorkHours }),
            [col.notes]: ''
        });
        
        // 使用 SheetJS 建立 Excel 檔案
        const ws = XLSX.utils.json_to_sheet(exportData);
        
        // 設定欄位寬度
        const wscols = [
            { wch: 12 },  // 日期
            { wch: 8 },   // 星期
            { wch: 12 },  // 上班時間
            { wch: 12 },  // 下班時間
            { wch: 14 },  // 上班時間（第二段）
            { wch: 14 },  // 下班時間（第二段）
            { wch: 16 },  // 地點
            { wch: 15 },  // 工作時數
            { wch: 12 },  // 工時（小時）
            { wch: 18 },  // 狀態
            { wch: 48 },  // 全部打卡
            { wch: 20 }   // 備註
        ];
        ws['!cols'] = wscols;
        
        // 建立工作簿
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, t('RPT_SHEET_EMPLOYEE', { month: yearMonth.split('-')[1] }).slice(0, 31));
        
        // 下載檔案
        const [year, month] = yearMonth.split('-');
        const fileName = `${t('RPT_FILE_EMPLOYEE', { name: employeeName, year: year, month: month })}.xlsx`;
        XLSX.writeFile(wb, fileName);
        
        showNotification(t('EXPORT_SUCCESS') || '報表已成功匯出！', 'success');
        
    } catch (error) {
        console.error('匯出失敗:', error);
        showNotification(t('EXPORT_FAILED') || '匯出失敗，請稍後再試', 'error');
        
    } finally {
        if (exportBtn) {
            generalButtonState(exportBtn, 'idle');
        }
    }
}
