// qr-punch.js
//
// LINE Bot 網頁打卡與 QR Code 打卡。兩者都是用一次性 token 換打卡資格。
//
// 從 script.js 拆出來的：那支原本 4,000 多行，每個頁面都要整份載入。
// 這裡的函式仍然是全域的，載入順序沒有相依性。

async function handleLinePunchFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('linePunchToken');
    if (!token) return;

    history.replaceState({}, '', window.location.pathname);

    // 全螢幕 overlay
    const overlay = document.createElement('div');
    overlay.id = 'line-punch-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:32px 24px;max-width:320px;width:90%;text-align:center;">
        <div id="lpo-icon" style="font-size:48px;margin-bottom:12px;">📍</div>
        <div id="lpo-title" style="font-size:20px;font-weight:bold;margin-bottom:8px;">正在取得位置...</div>
        <div id="lpo-sub" style="font-size:14px;color:#666;margin-bottom:16px;">請允許瀏覽器存取您的 GPS 位置</div>
        <button id="lpo-close" style="display:none;margin-top:8px;padding:10px 28px;border-radius:8px;border:none;background:#4CAF50;color:#fff;font-size:16px;cursor:pointer;">關閉</button>
      </div>`;
    document.body.appendChild(overlay);

    const setResult = (icon, title, sub, btnColor) => {
        overlay.querySelector('#lpo-icon').textContent = icon;
        overlay.querySelector('#lpo-title').textContent = title;
        overlay.querySelector('#lpo-sub').textContent = sub;
        const btn = overlay.querySelector('#lpo-close');
        btn.style.display = 'inline-block';
        btn.style.background = btnColor || '#4CAF50';
        btn.onclick = () => overlay.remove();
    };

    try {
        const position = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                timeout: 15000,
                enableHighAccuracy: true
            });
        });

        overlay.querySelector('#lpo-title').textContent = '正在打卡...';
        overlay.querySelector('#lpo-sub').textContent = '';

        const params = new URLSearchParams({
            token: token,
            lat: position.coords.latitude,
            lng: position.coords.longitude
        });

        const res = await callApifetch(`linePunch&${params.toString()}`);

        if (res.ok) {
            const typeText = res.punchType === '上班' ? '🟢 上班打卡' : '🟠 下班打卡';
            const detailText = `${res.location ? res.location + '｜' : ''}${res.time || ''}`;
            setResult('✅', typeText + ' 成功！', detailText, '#4CAF50');

            // 3 秒倒數後自動關閉，並嘗試返回上一頁
            const card = overlay.querySelector('div');
            const countdownEl = document.createElement('div');
            countdownEl.style.cssText = 'font-size:12px;color:#aaa;margin-top:10px;';
            card.appendChild(countdownEl);
            let secs = 3;
            countdownEl.textContent = `${secs} 秒後自動關閉`;
            const autoCloseTimer = setInterval(() => {
                secs--;
                if (secs <= 0) {
                    clearInterval(autoCloseTimer);
                    overlay.remove();
                    try { window.history.back(); } catch(e) {}
                } else {
                    countdownEl.textContent = `${secs} 秒後自動關閉`;
                }
            }, 1000);
            overlay.querySelector('#lpo-close').onclick = () => {
                clearInterval(autoCloseTimer);
                overlay.remove();
                try { window.history.back(); } catch(e) {}
            };

            await loadAbnormalRecordsInBackground();
        } else {
            const msgMap = {
                ERR_LPT_INVALID:  '連結無效或已使用，請重新在 LINE 輸入打卡指令',
                ERR_LPT_EXPIRED:  '連結已過期（5 分鐘），請重新在 LINE 輸入打卡指令',
                ERR_NOT_IN_RANGE: res.msg || '不在打卡範圍內',
                ERR_DUPLICATE_PUNCH: '您剛剛已打過卡了'
            };
            setResult('❌', '打卡失敗', msgMap[res.code] || res.msg || '請稍後再試', '#f44336');
        }
    } catch (err) {
        const geoErrors = { 1: '請允許位置存取權限後重試', 3: 'GPS 逾時，請確認定位已開啟' };
        setResult('❌', '無法取得位置', geoErrors[err.code] || '請確認 GPS 已開啟', '#f44336');
    }
}

/**
 * 處理登入後待執行的 QR 打卡
 */
async function handlePendingQRPunch() {
    const pendingToken = sessionStorage.getItem('pendingQRToken');
    if (!pendingToken) return;
    sessionStorage.removeItem('pendingQRToken');
    await performQRPunch(pendingToken);
}

/**
 * 員工 QR 打卡（由掃描後的 URL 觸發）
 */
async function performQRPunch(qrTokenId) {
    showNotification(t('NOTIF_QR_PROCESSING'), 'info');
    try {
        const token = localStorage.getItem('sessionToken');
        if (!token) {
            showNotification(t('NOTIF_LOGIN_REQUIRED_QR'), 'error');
            return;
        }
        const qrLoc = sessionStorage.getItem('pendingQRLoc') || '';
        sessionStorage.removeItem('pendingQRLoc');
        const urlParams = new URLSearchParams({ qrToken: qrTokenId });
        if (qrLoc) urlParams.append('loc', qrLoc);
        const res = await callApifetch(`qrPunch&${urlParams.toString()}`);
        if (res.ok) {
            const type = (res.params && res.params.type) || '';
            const loc  = (res.params && res.params.location) || '';
            showNotification(t('NOTIF_QR_PUNCH_OK', { detail: `${type || ''}${loc ? ' - ' + loc : ''}`.trim() }), 'success');
            // 重新載入異常記錄
            await loadAbnormalRecordsInBackground();
        } else {
            const msgMap = {
                'ERR_QR_EXPIRED':       'QR Code 已過期，請聯絡管理員重新產生',
                'ERR_QR_INVALID':       'QR Code 無效或已失效',
                'ERR_DUPLICATE_PUNCH':  res.msg || '今天已打過此類型的卡',
                'ERR_SESSION_INVALID':  '請先登入再掃描 QR Code'
            };
            showNotification(msgMap[res.code] || res.msg || 'QR 打卡失敗', 'error');
        }
    } catch (err) {
        console.error('QR 打卡錯誤:', err);
        showNotification(t('NOTIF_QR_PUNCH_FAILED'), 'error');
    }
}

/**
 * 管理員：產生 QR Code（純前端，不需要後端 API）
 * Token 格式：{I|O}_{到期毫秒HEX}_{8位亂數HEX}
 */
async function generateAdminQRCode() {
    const punchTypeEl = document.querySelector('input[name="qr-punch-type"]:checked');
    const punchType   = punchTypeEl ? punchTypeEl.value : '上班';
    const typeCode    = punchType === '上班' ? 'I' : 'O';

    const validSelect = document.getElementById('qr-valid-minutes');
    let validMinutes;
    if (validSelect.value === 'custom') {
        validMinutes = parseInt(document.getElementById('qr-valid-minutes-custom').value);
        if (!validMinutes || validMinutes < 1 || validMinutes > 1440) {
            showNotification(t('NOTIF_MINUTES_RANGE'), 'error');
            return;
        }
    } else {
        validMinutes = parseInt(validSelect.value);
    }

    const locationName = (document.getElementById('qr-location-name').value || '').trim();

    const btn = document.getElementById('generate-qr-btn');
    btn.disabled    = true;
    btn.textContent = '產生中...';

    try {
        // 純前端產生 token，不呼叫後端
        const expiryMs  = Date.now() + validMinutes * 60 * 1000;
        const expiryHex = expiryMs.toString(16).toUpperCase();
        const random    = Math.random().toString(16).slice(2, 10).toUpperCase();
        const tokenId   = `${typeCode}_${expiryHex}_${random}`;

        // 組成員工掃描後開啟的 URL
        const redirectUrl = API_CONFIG.redirectUrl.replace(/\/$/, '');
        const locParam    = locationName ? `&loc=${encodeURIComponent(locationName)}` : '';
        const punchUrl    = `${redirectUrl}/?qrToken=${tokenId}${locParam}`;

        // 使用 qrcodejs 在瀏覽器端直接產生 QR Code（同步，不需要 Promise）
        const qrContainer = document.getElementById('qr-image');
        qrContainer.innerHTML = '';  // 清除上一次的 QR Code
        new QRCode(qrContainer, {
            text: punchUrl,
            width: 250,
            height: 250,
            colorDark: '#1e1b4b',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
        });

        // 標籤顯示
        const typeBadge = document.getElementById('qr-type-badge');
        typeBadge.textContent = punchType === '上班' ? '上班打卡' : '下班打卡';
        typeBadge.className   = punchType === '上班'
            ? 'inline-block px-3 py-1 rounded-full text-sm font-bold mb-3 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300'
            : 'inline-block px-3 py-1 rounded-full text-sm font-bold mb-3 bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300';

        const locBadge = document.getElementById('qr-location-badge');
        if (locationName) {
            locBadge.textContent = locationName;
            locBadge.style.display = 'inline-block';
        } else {
            locBadge.style.display = 'none';
        }

        document.getElementById('qr-display-area').style.display       = 'block';
        document.getElementById('qr-expired-msg').style.display         = 'none';
        document.getElementById('qr-regenerate-btn').style.display      = 'none';
        document.getElementById('qr-image').style.opacity               = '1';
        document.getElementById('qr-countdown-container').style.display = 'block';

        // 啟動倒數計時
        _qrExpiryTime = expiryMs;
        _qrTotalMs    = validMinutes * 60 * 1000;
        if (_qrCountdownInterval) clearInterval(_qrCountdownInterval);
        _tickQRCountdown();
        _qrCountdownInterval = setInterval(_tickQRCountdown, 1000);

        showNotification(t('NOTIF_QR_GENERATED', { minutes: validMinutes }), 'success');

    } catch (err) {
        console.error('generateAdminQRCode 錯誤:', err);
        showNotification(t('NOTIF_QR_GENERATE_FAILED'), 'error');
    } finally {
        btn.disabled    = false;
        btn.textContent = '產生 QR Code';
    }
}

/**
 * QR Code 倒數計時一次 tick
 */
function _tickQRCountdown() {
    if (!_qrExpiryTime) return;
    const remaining = _qrExpiryTime - Date.now();

    if (remaining <= 0) {
        clearInterval(_qrCountdownInterval);
        _qrCountdownInterval = null;
        document.getElementById('qr-countdown').textContent = '00:00';
        document.getElementById('qr-progress-fill').style.width = '0%';
        document.getElementById('qr-image').style.opacity = '0.3';
        document.getElementById('qr-countdown-container').style.display = 'none';
        document.getElementById('qr-expired-msg').style.display    = 'block';
        document.getElementById('qr-regenerate-btn').style.display = 'block';
        return;
    }

    const totalSec   = Math.ceil(remaining / 1000);
    const mins       = Math.floor(totalSec / 60);
    const secs       = totalSec % 60;
    const countdownEl = document.getElementById('qr-countdown');
    if (countdownEl) {
        countdownEl.textContent = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
        // 顏色警示：剩餘 < 1 分鐘時變紅
        countdownEl.className = remaining < 60000
            ? 'text-4xl font-bold font-mono text-red-500 dark:text-red-400'
            : 'text-4xl font-bold font-mono text-indigo-600 dark:text-indigo-400';
    }

    const pct = _qrTotalMs > 0 ? (remaining / _qrTotalMs) * 100 : 0;
    const fillEl = document.getElementById('qr-progress-fill');
    if (fillEl) {
        fillEl.style.width = Math.max(0, pct) + '%';
        fillEl.className = remaining < 60000
            ? 'bg-red-500 h-2 rounded-full transition-all duration-1000'
            : 'bg-indigo-600 h-2 rounded-full transition-all duration-1000';
    }
}
