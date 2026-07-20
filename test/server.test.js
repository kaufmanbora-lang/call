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
  }
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

test('root disclosure module is served separately', async () => {
  const { url } = await startTestServer();
  const response = await fetch(`${url}/disclosure/disclosure.js`);
  const source = await response.text();
  assert.equal(response.status, 200);
  assert.match(source, /Набор виден оператору/);
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
