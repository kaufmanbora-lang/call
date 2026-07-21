'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { io: createClient } = require('socket.io-client');
const {
  createApplication,
  sanitizeDialValue,
  sanitizeScriptedValue
} = require('../server');

const openServers = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(({ io, server }) => new Promise((resolve) => {
    io.close();
    server.close(resolve);
  })));
});

async function startTestServer() {
  const instance = createApplication();
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  openServers.push(instance);
  const address = instance.server.address();
  return { ...instance, url: `http://127.0.0.1:${address.port}` };
}

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

test('sanitizes dial values', () => {
  assert.equal(sanitizeDialValue('+38067*#'), '+38067*#');
  assert.equal(sanitizeDialValue(''), '');
  assert.equal(sanitizeDialValue('12 34'), null);
  assert.equal(sanitizeDialValue('1+2'), null);
  assert.equal(sanitizeDialValue('1'.repeat(33)), null);
});

test('health endpoint and security headers are available', async () => {
  const { url } = await startTestServer();
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('visitor page is available from root aliases', async () => {
  const { url } = await startTestServer();

  for (const route of ['/', '/index.html']) {
    const response = await fetch(`${url}${route}`);
    const source = await response.text();
    assert.equal(response.status, 200);
    assert.match(source, /dialOutput/);
    assert.match(source, /operatorView/);
    assert.match(source, /apple-mobile-web-app-capable/);
    assert.match(source, /manifest\.webmanifest/);
    assert.match(source, /<title>Телефон<\/title>/);
    assert.match(source, /phone-icon\.svg/);
    assert.doesNotMatch(source, /class="status-bar"/);
    assert.match(source, /id="operatorScriptForm"/);
    assert.match(source, /id="scriptedDialNotice"/);
    assert.match(source, /id="operatorBackButton"/);
    assert.match(source, /app\.js\?v=7/);
    assert.match(source, /pattern="\[0-9\]\{4,20\}"/);
    assert.match(source, /minlength="4"/);
    assert.match(source, /maxlength="20"/);
  }
});

test('sanitizes operator demo sequences', () => {
  assert.equal(sanitizeScriptedValue('5880'), '5880');
  assert.equal(sanitizeScriptedValue(''), '');
  assert.equal(sanitizeScriptedValue('588'), null);
  assert.equal(sanitizeScriptedValue('58#'), null);
  assert.equal(sanitizeScriptedValue('5 8 8'), null);
  assert.equal(sanitizeScriptedValue('1'.repeat(20)), '1'.repeat(20));
  assert.equal(sanitizeScriptedValue('1'.repeat(21)), null);
});

test('mobile shell omits the duplicate phone status bar and keeps navigation at the bottom', async () => {
  const { url } = await startTestServer();
  const [pageResponse, stylesResponse, appResponse] = await Promise.all([
    fetch(`${url}/`),
    fetch(`${url}/styles.css`),
    fetch(`${url}/app.js`)
  ]);
  const page = await pageResponse.text();
  const styles = await stylesResponse.text();
  const app = await appResponse.text();

  assert.doesNotMatch(page, /id="statusTime"/);
  assert.doesNotMatch(page, /class="battery-icon"/);
  assert.doesNotMatch(page, /class="home-indicator"/);
  assert.doesNotMatch(app, /updateClock/);
  assert.match(page, /styles\.css\?v=2/);
  assert.match(styles, /\.tab-bar\s*\{[\s\S]*?left: 2\.1%/);
  assert.match(styles, /\.tab-bar\s*\{[\s\S]*?height: 7\.05%/);
  assert.match(styles, /bottom: max\(\.18%, calc\(env\(safe-area-inset-bottom\) - 32px\)\)/);
  assert.doesNotMatch(styles, /\.home-indicator\s*\{/);
  assert.match(styles, /\.dialer-page\s*\{[\s\S]*?overflow: hidden/);
});

test('operator view has a same-page return control', async () => {
  const { url } = await startTestServer();
  const [pageResponse, appResponse, stylesResponse] = await Promise.all([
    fetch(`${url}/`),
    fetch(`${url}/app.js`),
    fetch(`${url}/styles.css`)
  ]);
  const page = await pageResponse.text();
  const app = await appResponse.text();
  const styles = await stylesResponse.text();

  assert.match(page, /id="operatorBackButton"/);
  assert.match(page, />Назад</);
  assert.match(app, /function closeAdmin\(\)/);
  assert.match(app, /operatorBackButton\.addEventListener\('click', closeAdmin\)/);
  assert.match(app, /if \(!socket\.connected\) socket\.connect\(\)/);
  assert.match(app, /if \(intentionalVisitorDisconnect\)/);
  assert.match(styles, /\.operator-back-button\s*\{/);
});

test('standalone web app manifest is available for home-screen launch', async () => {
  const { url } = await startTestServer();
  const response = await fetch(`${url}/manifest.webmanifest`);
  const manifest = await response.json();

  assert.equal(response.status, 200);
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.name, 'Телефон');
  assert.equal(manifest.short_name, 'Телефон');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.display_override, ['fullscreen', 'standalone']);
  assert.equal(manifest.theme_color, '#000000');
  assert.deepEqual(manifest.icons, [{
    src: '/phone-icon.svg',
    sizes: 'any',
    type: 'image/svg+xml',
    purpose: 'any maskable'
  }]);
});

test('legacy admin routes redirect to the single-page interface', async () => {
  const { url } = await startTestServer();

  for (const route of ['/admin', '/admin/', '/admin.html', '/admin/index.html']) {
    const response = await fetch(`${url}${route}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
  }
});

test('unknown browser routes fall back to the visitor page', async () => {
  const { url } = await startTestServer();
  const response = await fetch(`${url}/wrong/render/path`, {
    headers: { accept: 'text/html' }
  });
  const source = await response.text();

  assert.equal(response.status, 200);
  assert.match(source, /dialOutput/);
});

test('optional disclosure presentation remains independent', async () => {
  const { url } = await startTestServer();
  const [stylesResponse, pageResponse, appResponse] = await Promise.all([
    fetch(`${url}/disclosure/disclosure.css`),
    fetch(`${url}/`),
    fetch(`${url}/app.js`)
  ]);
  const styles = await stylesResponse.text();
  const page = await pageResponse.text();
  const app = await appResponse.text();

  assert.equal(stylesResponse.status, 200);
  assert.match(styles, /font-size: clamp\(11px, 1\.65cqw, 15px\)/);
  assert.match(page, /disclosure\/disclosure\.css\?v=6/);
  assert.match(app, /async function loadNoticePreferences\(\)/);
});

test('operator demo sequence is available over HTTP', async () => {
  const { url } = await startTestServer();
  const saveResponse = await fetch(`${url}/api/scripted-dial`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: '5880' })
  });
  const saved = await saveResponse.json();

  assert.equal(saveResponse.status, 202);
  assert.equal(saved.snapshot.value, '5880');
  assert.equal(saved.snapshot.version, 1);

  const readResponse = await fetch(`${url}/api/scripted-dial`);
  const current = await readResponse.json();
  assert.equal(readResponse.status, 200);
  assert.equal(readResponse.headers.get('cache-control'), 'no-store');
  assert.equal(current.snapshot.value, '5880');
  assert.equal(current.snapshot.version, 1);
});

test('operator demo endpoint rejects sequences outside 4 to 20 digits', async () => {
  const { url } = await startTestServer();

  for (const value of ['123', '1'.repeat(21)]) {
    const response = await fetch(`${url}/api/scripted-dial`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value })
    });
    assert.equal(response.status, 400);
  }
});

test('operator demo sequence is pushed to connected visitor devices', async () => {
  const { url } = await startTestServer();
  const visitor = createClient(url, {
    auth: { role: 'visitor', visitorId: 'visitor_script_123' },
    transports: ['websocket']
  });
  await once(visitor, 'connect');

  const scriptedSnapshotPromise = once(visitor, 'script:snapshot');
  const saveResponse = await fetch(`${url}/api/scripted-dial`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: '3806' })
  });
  const snapshot = await scriptedSnapshotPromise;

  assert.equal(saveResponse.status, 202);
  assert.equal(snapshot.value, '3806');
  assert.equal(snapshot.version, 1);
  visitor.disconnect();
});

test('live transport is independent from the optional disclosure module', async () => {
  const { url } = await startTestServer();
  const [pageSource, appSource] = await Promise.all([
    fetch(`${url}/`).then((response) => response.text()),
    fetch(`${url}/app.js`).then((response) => response.text())
  ]);

  assert.match(pageSource, /id="sharingNotice"/);
  assert.doesNotMatch(appSource, /disclosure\.installed/);
  assert.doesNotMatch(appSource, /if \(!disclosure/);
  assert.match(appSource, /socket\.emit\('dial:update', payload\)/);
  assert.match(appSource, /socket\.emit\('dial:submit', payload\)/);
});

test('the newest device update always replaces the previous operator value', async () => {
  const { url } = await startTestServer();

  for (const [visitorId, value] of [
    ['visitor_first_device', '417'],
    ['visitor_second_device', '902#'],
    ['visitor_third_device', '16*']
  ]) {
    const updateResponse = await fetch(`${url}/api/dial`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorId, value, revision: 1 })
    });
    assert.equal(updateResponse.status, 202);

    const snapshotResponse = await fetch(`${url}/api/dial`);
    const payload = await snapshotResponse.json();
    assert.equal(payload.snapshot.value, value);
    assert.equal(payload.snapshot.visitorId, visitorId);
  }
});

test('visitor updates survive both visitor and admin reconnects', async () => {
  const { url } = await startTestServer();
  const admin = createClient(url, {
    auth: { role: 'admin' },
    transports: ['websocket']
  });
  const visitor = createClient(url, {
    auth: { role: 'visitor', visitorId: 'visitor_test_123' },
    transports: ['websocket']
  });

  await Promise.all([once(admin, 'connect'), once(visitor, 'connect')]);
  const snapshotPromise = once(admin, 'admin:snapshot');
  visitor.emit('dial:update', { value: '38067#' });
  const snapshot = await snapshotPromise;

  assert.equal(snapshot.value, '38067#');
  assert.equal(snapshot.submitted, false);
  admin.disconnect();
  visitor.disconnect();

  const emptySecondDevice = createClient(url, {
    auth: { role: 'visitor', visitorId: 'visitor_empty_device_456' },
    transports: ['websocket']
  });
  await once(emptySecondDevice, 'connect');

  const reopenedVisitor = createClient(url, {
    auth: { role: 'visitor', visitorId: 'visitor_test_123' },
    transports: ['websocket']
  });
  await once(reopenedVisitor, 'connect');

  const reopenedAdmin = createClient(url, {
    auth: { role: 'admin' },
    transports: ['websocket']
  });
  const latestSnapshotPromise = once(reopenedAdmin, 'admin:snapshot');
  await once(reopenedAdmin, 'connect');
  const latestSnapshot = await latestSnapshotPromise;

  assert.equal(latestSnapshot.value, '38067#');
  reopenedAdmin.disconnect();
  reopenedVisitor.disconnect();
  emptySecondDevice.disconnect();
});

test('an active visitor snapshot does not expire while its tab remains connected', async () => {
  const { url, visitors } = await startTestServer();
  const visitorId = 'visitor_active_123';
  const visitor = createClient(url, {
    auth: { role: 'visitor', visitorId },
    transports: ['websocket']
  });

  await once(visitor, 'connect');
  visitor.emit('dial:update', { value: '765#', revision: 1 });

  for (let attempt = 0; attempt < 20 && !visitors.has(visitorId); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const stored = visitors.get(visitorId);
  assert.ok(stored);
  stored.expiresAt = Date.now() - 1;

  const snapshotResponse = await fetch(`${url}/api/dial`);
  const payload = await snapshotResponse.json();
  assert.equal(payload.snapshot.value, '765#');
  visitor.disconnect();
});

test('HTTP fallback stores the latest revision for the admin', async () => {
  const { url } = await startTestServer();
  const updateResponse = await fetch(`${url}/api/dial`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      visitorId: 'visitor_http_123',
      value: '42#',
      revision: 7
    })
  });
  assert.equal(updateResponse.status, 202);

  await fetch(`${url}/api/dial`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      visitorId: 'visitor_http_123',
      value: '1',
      revision: 6
    })
  });

  const snapshotResponse = await fetch(`${url}/api/dial`);
  const payload = await snapshotResponse.json();
  assert.equal(snapshotResponse.status, 200);
  assert.equal(snapshotResponse.headers.get('cache-control'), 'no-store');
  assert.equal(payload.snapshot.value, '42#');
});
