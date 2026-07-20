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
  }
});

test('admin page is available with and without a trailing slash', async () => {
  const { url } = await startTestServer();

  for (const route of ['/admin', '/admin/', '/admin.html', '/admin/index.html']) {
    const response = await fetch(`${url}${route}`);
    const source = await response.text();
    assert.equal(response.status, 200);
    assert.match(source, /operatorView/);
    assert.doesNotMatch(source, /type="password"/);
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

test('visitor updates reach the public admin and survive an admin reconnect', async () => {
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

  const reopenedAdmin = createClient(url, {
    auth: { role: 'admin' },
    transports: ['websocket']
  });
  const latestSnapshotPromise = once(reopenedAdmin, 'admin:snapshot');
  await once(reopenedAdmin, 'connect');
  const latestSnapshot = await latestSnapshotPromise;

  assert.equal(latestSnapshot.value, '38067#');
  reopenedAdmin.disconnect();
  visitor.disconnect();
});
