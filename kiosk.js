// kiosk.js - 公司平板的打卡頁
//
// 管理員在後台「平板打卡」產生連結（kiosk.html#key=...），平板開啟一次後就放著。
// 每 30 秒向後端要新的上班／下班 QR 代碼（每個 3 分鐘失效，見 GS/QrPunch.gs），
// 員工用手機掃描後進入一般的 QR 打卡流程。
//
// 平板不登入任何帳號：金鑰只能拿來產生 QR Code，存在這台平板的 localStorage。

const KIOSK_STORAGE_KEY = 'kioskKey';
const KIOSK_REFRESH_MS = 30 * 1000;
const KIOSK_RETRY_MS = 10 * 1000;

let kioskKey = '';
let kioskExpiresAt = 0;
let kioskClockOffset = 0;   // 伺服器時間 - 平板時間，平板時鐘不準時仍顯示正確時間
let kioskRefreshTimer = null;
let kioskWakeLock = null;

function kioskStorageGet() {
    try { return localStorage.getItem(KIOSK_STORAGE_KEY) || ''; } catch (error) { return ''; }
}

function kioskStorageSet(value) {
    try {
        if (value) localStorage.setItem(KIOSK_STORAGE_KEY, value);
        else localStorage.removeItem(KIOSK_STORAGE_KEY);
    } catch (error) {
        // 無痕模式等情況存不了，這次開著的期間仍然可用
    }
}

// 網址上的 #key= 優先（管理員剛給的新連結），讀到後存起來並從網址列拿掉
function readKioskKey() {
    const match = window.location.hash.match(/key=([^&]+)/);
    if (match) {
        const key = decodeURIComponent(match[1]);
        kioskStorageSet(key);
        history.replaceState({}, '', window.location.pathname);
        return key;
    }
    return kioskStorageGet();
}

function showKioskSetup(messageKey) {
    document.getElementById('kiosk-main').style.display = 'none';
    document.getElementById('kiosk-setup').style.display = 'block';
    if (messageKey) {
        const el = document.getElementById('kiosk-setup-message');
        el.setAttribute('data-i18n', messageKey);
        el.textContent = t(messageKey);
    }
}

function setKioskStatus(text) {
    document.getElementById('kiosk-status').textContent = text || '';
}

function buildPunchUrl(token, loc) {
    const base = API_CONFIG.redirectUrl.replace(/\/$/, '');
    return `${base}/?qrToken=${encodeURIComponent(token)}${loc ? '&loc=' + encodeURIComponent(loc) : ''}`;
}

function drawKioskQr(elementId, text) {
    const box = document.getElementById(elementId);
    box.innerHTML = '';
    new QRCode(box, { text: text, width: 320, height: 320, correctLevel: QRCode.CorrectLevel.M });
    box.classList.remove('stale');
}

function scheduleKioskRefresh(delay) {
    clearTimeout(kioskRefreshTimer);
    kioskRefreshTimer = setTimeout(refreshKioskQr, delay);
}

async function refreshKioskQr() {
    try {
        const res = await apiRequestJson(`getKioskQr&kioskKey=${encodeURIComponent(kioskKey)}`);

        if (!res.ok) {
            if (res.code === 'ERR_KIOSK_KEY_INVALID') {
                // 管理員重設或停用了：清掉舊金鑰，不再重試
                kioskStorageSet('');
                showKioskSetup('KIOSK_KEY_INVALID');
                return;
            }
            throw new Error(res.msg || 'getKioskQr failed');
        }

        if (res.serverTime) kioskClockOffset = res.serverTime - Date.now();
        kioskExpiresAt = res.expiresAt;

        document.getElementById('kiosk-location').textContent = res.loc || '';
        drawKioskQr('kiosk-qr-in', buildPunchUrl(res.checkIn, res.loc));
        drawKioskQr('kiosk-qr-out', buildPunchUrl(res.checkOut, res.loc));
        setKioskStatus('');

        scheduleKioskRefresh(KIOSK_REFRESH_MS);
    } catch (error) {
        console.error('更新 QR Code 失敗:', error);
        setKioskStatus(t('KIOSK_OFFLINE'));
        scheduleKioskRefresh(KIOSK_RETRY_MS);
    }
}

function tickKioskClock() {
    const now = new Date(Date.now() + kioskClockOffset);
    const lang = (typeof currentLang !== 'undefined' && currentLang) || 'zh-TW';

    document.getElementById('kiosk-clock').textContent =
        now.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    document.getElementById('kiosk-date').textContent =
        now.toLocaleDateString(lang, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });

    // 斷線太久、手上的代碼已經過期：把 QR Code 淡掉，免得員工掃了才發現不能用
    if (kioskExpiresAt && Date.now() + kioskClockOffset > kioskExpiresAt) {
        document.querySelectorAll('.qr-box').forEach(box => box.classList.add('stale'));
    }
}

// 讓平板螢幕不要自動關閉（瀏覽器支援才有效）
async function requestKioskWakeLock() {
    try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
            kioskWakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (error) {
        console.warn('無法保持螢幕常亮:', error);
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    requestKioskWakeLock();
    // 平板休眠醒來時，手上的代碼可能早就過期了，馬上換新的
    if (kioskKey) refreshKioskQr();
});

document.addEventListener('DOMContentLoaded', async () => {
    if (typeof loadTranslations === 'function') {
        window.I18N_TITLE_KEY = 'KIOSK_PAGE_TITLE';
        try {
            await loadTranslations(detectLang());
        } catch (error) {
            console.warn('載入翻譯失敗，使用預設文字:', error);
        }
    }

    kioskKey = readKioskKey();
    if (!kioskKey) {
        showKioskSetup();
        return;
    }

    document.getElementById('kiosk-main').style.display = 'flex';
    document.getElementById('kiosk-fullscreen').addEventListener('click', () => {
        const root = document.documentElement;
        if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    });

    tickKioskClock();
    setInterval(tickKioskClock, 1000);
    requestKioskWakeLock();
    await refreshKioskQr();
});
