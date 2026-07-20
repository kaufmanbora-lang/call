'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { io: createClient } = require('socket.io-client');
const {
  createApplication,
  sanitizeDialValue
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
  }
});

test('standalone web app manifest is available for home-screen launch', async () => {
  const { url } = await startTestServer();
  const response = await fetch(`${url}/manifest.webmanifest`);
  const manifest = await response.json();

  assert.equal(response.status, 200);
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.display_override, ['fullscreen', 'standalone']);
  assert.equal(manifest.theme_color, '#000000');
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

test('optional disclosure preferences are served separately', async () => {
  const { url } = await startTestServer();
  const response = await fetch(`${url}/disclosure/disclosure.json`);
  const preferences = await response.json();
  assert.equal(response.status, 200);
  assert.equal(preferences.noticeText, 'Набор виден оператору в реальном времени');
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
