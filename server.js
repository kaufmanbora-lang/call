'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { Server } = require('socket.io');

const PUBLIC_DIR = path.join(__dirname, 'public');
const DISCLOSURE_DIR = path.join(__dirname, 'disclosure');
const MAX_VALUE_LENGTH = 32;
const VISITOR_TTL_MS = 5 * 60 * 1000;

function sanitizeDialValue(input) {
  if (typeof input !== 'string') return null;
  if (input.length > MAX_VALUE_LENGTH) return null;
  if (!/^\+?[0-9*#]*$/.test(input)) return null;
  if (input.slice(1).includes('+')) return null;
  return input;
}

function safeId(input) {
  if (typeof input !== 'string') return crypto.randomUUID();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(input) ? input : crypto.randomUUID();
}

function passwordsMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }

  const actualDigest = crypto.createHash('sha256').update(actual).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function createApplication(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    serveClient: true,
    maxHttpBufferSize: 8 * 1024,
    transports: ['websocket', 'polling']
  });
  const visitors = new Map();
  const adminPassword = options.adminPassword ?? process.env.ADMIN_PASSWORD ?? '';

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
    );
    next();
  });

  app.get('/health', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });

  function sendPage(response, fileName) {
    response.setHeader('Cache-Control', 'no-store');
    response.sendFile(path.join(PUBLIC_DIR, fileName));
  }

  app.get(['/', '/index.html'], (_request, response) => {
    sendPage(response, 'index.html');
  });

  app.get(['/admin', '/admin/', '/admin.html', '/admin/index.html'], (_request, response) => {
    sendPage(response, 'admin.html');
  });

  app.use(
    '/disclosure',
    express.static(DISCLOSURE_DIR, {
      etag: true,
      fallthrough: false
    })
  );

  app.use(
    express.static(PUBLIC_DIR, {
      etag: true,
      index: 'index.html',
      setHeaders(response, filePath) {
        if (filePath.endsWith('.html')) response.setHeader('Cache-Control', 'no-store');
      }
    })
  );

  app.use((request, response, next) => {
    if (request.method === 'GET' && request.accepts('html')) {
      sendPage(response, 'index.html');
      return;
    }

    next();
  });

  function newestSnapshot() {
    return [...visitors.values()]
      .filter((visitor) => visitor.expiresAt > Date.now())
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  function broadcastSnapshot() {
    const snapshot = newestSnapshot();
    io.to('admins').emit('admin:snapshot', snapshot ? {
      value: snapshot.value,
      updatedAt: snapshot.updatedAt,
      visitorId: snapshot.id,
      submitted: snapshot.submitted
    } : null);
  }

  io.on('connection', (socket) => {
    const role = socket.handshake.auth?.role;

    if (role === 'admin') {
      if (!passwordsMatch(socket.handshake.auth?.password, adminPassword)) {
        socket.emit('admin:denied');
        socket.disconnect(true);
        return;
      }

      socket.join('admins');
      const snapshot = newestSnapshot();
      socket.emit('admin:snapshot', snapshot ? {
        value: snapshot.value,
        updatedAt: snapshot.updatedAt,
        visitorId: snapshot.id,
        submitted: snapshot.submitted
      } : null);
      return;
    }

    const visitorId = safeId(socket.handshake.auth?.visitorId);
    let lastAcceptedAt = 0;

    socket.join(`visitor:${visitorId}`);
    visitors.set(visitorId, {
      id: visitorId,
      value: '',
      updatedAt: Date.now(),
      expiresAt: Date.now() + VISITOR_TTL_MS,
      submitted: false
    });

    socket.on('dial:update', (payload) => {
      const now = Date.now();
      if (now - lastAcceptedAt < 25) return;

      const value = sanitizeDialValue(payload?.value);
      if (value === null) return;

      lastAcceptedAt = now;
      visitors.set(visitorId, {
        id: visitorId,
        value,
        updatedAt: now,
        expiresAt: now + VISITOR_TTL_MS,
        submitted: false
      });
      broadcastSnapshot();
    });

    socket.on('dial:submit', (payload) => {
      const value = sanitizeDialValue(payload?.value);
      if (value === null || value.length === 0) return;

      const now = Date.now();
      visitors.set(visitorId, {
        id: visitorId,
        value,
        updatedAt: now,
        expiresAt: now + VISITOR_TTL_MS,
        submitted: true
      });
      broadcastSnapshot();
    });

    socket.on('disconnect', () => {
      const visitor = visitors.get(visitorId);
      if (!visitor) return;
      visitor.expiresAt = Date.now() + VISITOR_TTL_MS;
    });
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, visitor] of visitors.entries()) {
      if (visitor.expiresAt <= now) {
        visitors.delete(id);
        changed = true;
      }
    }
    if (changed) broadcastSnapshot();
  }, 30_000);
  cleanupTimer.unref();

  return { app, server, io, visitors };
}

if (require.main === module) {
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
    console.error('ADMIN_PASSWORD is required in production.');
    process.exit(1);
  }

  const port = Number(process.env.PORT) || 3000;
  const { server } = createApplication({
    adminPassword: process.env.ADMIN_PASSWORD || '123457'
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`Phone Live is listening on port ${port}`);
  });
}

module.exports = {
  createApplication,
  passwordsMatch,
  sanitizeDialValue
};
