'use strict';

const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { io: createClient } = require('socket.io-client');
const {
  createApplication,
  passwordsMatch,
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
  const instance = createApplication({ adminPassword: 'correct-horse' });
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

test('compares passwords without accepting empty values', () => {
  assert.equal(passwordsMatch('secret', 'secret'), true);
  assert.equal(passwordsMatch('secret', 'other'), false);
  assert.equal(passwordsMatch('', ''), false);
});

test('health endpoint and security headers are available', async () => {
  const { url } = await startTestServer();
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('root disclosure module is served separately', async () => {
  const { url } = await startTestServer();
  const response = await fetch(`${url}/disclosure/disclosure.js`);
  const source = await response.text();
  assert.equal(response.status, 200);
  assert.match(source, /Набор виден оператору/);
});

test('visitor updates reach an authenticated admin', async () => {
  const { url } = await startTestServer();
  const admin = createClient(url, {
    auth: { role: 'admin', password: 'correct-horse' },
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
});

test('wrong admin password is rejected', async () => {
  const { url } = await startTestServer();
  const admin = createClient(url, {
    auth: { role: 'admin', password: 'wrong' },
    transports: ['websocket']
  });

  await once(admin, 'admin:denied');
  assert.equal(admin.connected, false);
  admin.disconnect();
});
