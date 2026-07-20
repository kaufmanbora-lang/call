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

function createApplication() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    serveClient: true,
    maxHttpBufferSize: 8 * 1024,
    transports: ['websocket', 'polling']
  });
  const visitors = new Map();
  const connectedVisitors = new Map();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb' }));
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

  app.get('/api/dial', (_request, response) => {
    const snapshot = newestSnapshot();
    response.setHeader('Cache-Control', 'no-store');
    response.status(200).json({
      snapshot: snapshot ? publicSnapshot(snapshot) : null
    });
  });

  app.post('/api/dial', (request, response) => {
    const value = sanitizeDialValue(request.body?.value);
    if (value === null) {
      response.status(400).json({ error: 'invalid_value' });
      return;
    }

    const visitorId = safeId(request.body?.visitorId);
    storeVisitorSnapshot(visitorId, value, Boolean(request.body?.submitted), request.body?.revision);
    broadcastSnapshot();
    response.status(202).json({ status: 'accepted' });
  });

  function sendPage(response, fileName) {
    response.setHeader('Cache-Control', 'no-store');
    response.sendFile(path.join(PUBLIC_DIR, fileName));
  }

  app.get(['/', '/index.html'], (_request, response) => {
    sendPage(response, 'index.html');
  });

  app.get(['/admin', '/admin/', '/admin.html', '/admin/index.html'], (_request, response) => {
    response.redirect(302, '/');
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
      .filter((visitor) => connectedVisitors.has(visitor.id) || visitor.expiresAt > Date.now())
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  function publicSnapshot(snapshot) {
    return {
      value: snapshot.value,
      updatedAt: snapshot.updatedAt,
      visitorId: snapshot.id,
      submitted: snapshot.submitted
    };
  }

  function storeVisitorSnapshot(visitorId, value, submitted, requestedRevision) {
    const existing = visitors.get(visitorId);
    const revision = Number.isSafeInteger(requestedRevision) && requestedRevision >= 0
      ? requestedRevision
      : (existing?.revision ?? -1) + 1;

    if (existing && revision < existing.revision) return existing;
    if (existing && revision === existing.revision && existing.value === value && (!submitted || existing.submitted)) {
      existing.expiresAt = Date.now() + VISITOR_TTL_MS;
      return existing;
    }

    const now = Date.now();
    const snapshot = {
      id: visitorId,
      value,
      revision,
      updatedAt: now,
      expiresAt: connectedVisitors.has(visitorId)
        ? Number.POSITIVE_INFINITY
        : now + VISITOR_TTL_MS,
      submitted: submitted || (existing?.submitted && existing.value === value) || false
    };
    visitors.set(visitorId, snapshot);
    return snapshot;
  }

  function broadcastSnapshot() {
    const snapshot = newestSnapshot();
    io.to('admins').emit('admin:snapshot', snapshot ? publicSnapshot(snapshot) : null);
  }

  io.on('connection', (socket) => {
    const role = socket.handshake.auth?.role;

    if (role === 'admin') {
      socket.join('admins');
      const snapshot = newestSnapshot();
      socket.emit('admin:snapshot', snapshot ? publicSnapshot(snapshot) : null);
      return;
    }

    const visitorId = safeId(socket.handshake.auth?.visitorId);
    let lastAcceptedAt = 0;

    connectedVisitors.set(visitorId, (connectedVisitors.get(visitorId) ?? 0) + 1);
    socket.join(`visitor:${visitorId}`);
    const existingVisitor = visitors.get(visitorId);
    if (existingVisitor) {
      existingVisitor.expiresAt = Number.POSITIVE_INFINITY;
    }

    socket.on('dial:update', (payload) => {
      const now = Date.now();
      if (now - lastAcceptedAt < 25) return;

      const value = sanitizeDialValue(payload?.value);
      if (value === null) return;

      lastAcceptedAt = now;
      storeVisitorSnapshot(visitorId, value, false, payload?.revision);
      broadcastSnapshot();
    });

    socket.on('dial:submit', (payload) => {
      const value = sanitizeDialValue(payload?.value);
      if (value === null || value.length === 0) return;

      storeVisitorSnapshot(visitorId, value, true, payload?.revision);
      broadcastSnapshot();
    });

    socket.on('disconnect', () => {
      const remainingConnections = Math.max(0, (connectedVisitors.get(visitorId) ?? 1) - 1);
      if (remainingConnections > 0) {
        connectedVisitors.set(visitorId, remainingConnections);
      } else {
        connectedVisitors.delete(visitorId);
      }

      const visitor = visitors.get(visitorId);
      if (!visitor) return;
      visitor.expiresAt = remainingConnections > 0
        ? Number.POSITIVE_INFINITY
        : Date.now() + VISITOR_TTL_MS;
    });
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, visitor] of visitors.entries()) {
      if (!connectedVisitors.has(id) && visitor.expiresAt <= now) {
        visitors.delete(id);
        changed = true;
      }
    }
    if (changed) broadcastSnapshot();
  }, 30_000);
  cleanupTimer.unref();

  return { app, server, io, visitors, connectedVisitors };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createApplication();

  server.listen(port, '0.0.0.0', () => {
    console.log(`Phone Live is listening on port ${port}`);
  });
}

module.exports = {
  createApplication,
  sanitizeDialValue
};
