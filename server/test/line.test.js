// LINE：webhook 簽章、LINE Bot 訊息、LINE Login 換 token
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { makeRuntime } = require('./helpers');
const { createServer, buildEvent } = require('../src/server');

const t = makeRuntime();
t.addEmployee('Uemp', '小明', '員工');

function webhookBody(text, id) {
  return JSON.stringify({
    destination: 'x',
    events: [{
      type: 'message', mode: 'active', timestamp: Date.now(), webhookEventId: id,
      replyToken: 'reply-' + id, source: { type: 'user', userId: 'Uemp' },
      message: { id: 'm' + id, type: 'text', text }
    }]
  });
}

async function post(port, body, headers) {
  const res = await fetch(`http://127.0.0.1:${port}/exec`, {
    method: 'POST', body, headers: Object.assign({ 'Content-Type': 'application/json' }, headers)
  });
  return { status: res.status, body: await res.text() };
}

test('webhook 簽章：設定 secret 後，簽章不符就拒絕', async () => {
  const server = createServer(t.runtime, { log: () => {} });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const props = t.runtime.context.PropertiesService.getScriptProperties();
    props.setProperty('LINE_MESSAGING_CHANNEL_SECRET', 'channel-secret');

    const body = webhookBody('你好', 'e1');
    const good = crypto.createHmac('sha256', 'channel-secret').update(body).digest('base64');

    assert.equal((await post(port, body, { 'X-Line-Signature': 'bad' })).status, 401);
    assert.equal((await post(port, body, {})).status, 401, '沒帶簽章也拒絕');
    const ok = await post(port, body, { 'X-Line-Signature': good });
    assert.equal(ok.status, 200, ok.body);
    assert.match(ok.body, /"status":"ok"/);

    // 前端的表單 POST 不受影響
    const form = await fetch(`http://127.0.0.1:${port}/exec`, {
      method: 'POST', body: 'action=testEndpoint', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    assert.equal((await form.json()).ok, true);
    props.deleteProperty('LINE_MESSAGING_CHANNEL_SECRET');
  } finally {
    server.close();
  }
});

test('LINE Bot 收到「打卡」會回覆（呼叫 LINE reply API）', () => {
  t.runtime.context.PropertiesService.getScriptProperties().setProperty('LINE_CHANNEL_ACCESS_TOKEN', 'test-token');
  t.fetches.length = 0;
  const body = Buffer.from(webhookBody('打卡', 'e2'));
  const out = t.runtime.doPost(buildEvent(new URL('http://x/exec'), 'POST', body, 'application/json'));
  assert.match(out.getContent(), /"status":"ok"/);
  const replies = t.fetches.filter(f => /api\.line\.me\/v2\/bot\/message\/reply/.test(f.url));
  assert.ok(replies.length >= 1, '要有回覆：' + t.fetches.map(f => f.url).join(', '));
  const payload = JSON.parse(replies[0].params.payload);
  assert.equal(payload.replyToken, 'reply-e2');

  // 同一個事件 ID 重送，不重複處理
  t.fetches.length = 0;
  t.runtime.doPost(buildEvent(new URL('http://x/exec'), 'POST', body, 'application/json'));
  assert.equal(t.fetches.length, 0);
});

test('LINE Login：用 code 換 token → 建立員工與 Session', () => {
  const idToken = ['x', Buffer.from(JSON.stringify({ email: 'new@example.com' })).toString('base64url'), 'y'].join('.');
  t.runtime.context.UrlFetchApp = {
    fetch(url) {
      const json = /oauth2\/v2\.1\/token/.test(url)
        ? { access_token: 'at', id_token: idToken }
        : { userId: 'Unew', displayName: '新同事', pictureUrl: 'https://p/x.png' };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(json) };
    }
  };
  const res = JSON.parse(t.runtime.doGet(buildEvent(new URL('http://x/exec?action=getProfile&otoken=abc'), 'GET', null, '')).getContent());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.user.userId, 'Unew');
  const session = JSON.parse(t.runtime.doGet(buildEvent(new URL('http://x/exec?action=checkSession&token=' + res.sToken), 'GET', null, '')).getContent());
  assert.equal(session.ok, true, JSON.stringify(session));
  assert.equal(session.user.name, '新同事');
});
