// @ts-check
// Rabbit Hole Node entry. Serves the Client, the page API, a live event stream and the MCP endpoint.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { handleMcp } from './mcp.mjs';
import { RabbitHole } from './service.mjs';
import { ByobError } from './vendor/table-core.mjs';

const JS = 'text/javascript; charset=utf-8';
const CLIENT_FILES = { '/app.js': ['app.js', JS], '/i18n.js': ['i18n.js', JS], '/seats.js': ['seats.js', JS], '/style.css': ['style.css', 'text/css; charset=utf-8'] };

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new ByobError('E_SCHEMA', 'body too large')); request.destroy(); return; }
      chunks.push(c);
    });
    request.on('end', () => {
      if (!size) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ByobError('E_SCHEMA', 'invalid JSON')); }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** @param {import('./miniapp-api.js').MiniAppContext} context */
export async function start(context) {
  const service = new RabbitHole({ dataDir: context.dataDir, logger: context.logger, agent: context.agent });
  const streams = new Set();
  const clientDir = join(context.pluginRoot, 'miniapp/client');
  service.on('event', (event) => {
    const frame = 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
    for (const res of streams) res.write(frame);
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://miniapp.local');
      const path = url.pathname;
      if (path === '/mcp/rabbit-hole') { service.activate(); await handleMcp(service, request, response, readJson); return; }
      if (path.startsWith('/api/')) {
        service.activate();
        const table = path.match(/^\/api\/tables\/([^/]+)(\/.*)?$/);
        if (path === '/api/events' && request.method === 'GET') {
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          response.write('retry: 3000\n\n');
          streams.add(response);
          request.on('close', () => streams.delete(response));
          return;
        }
        if (path === '/api/tables' && request.method === 'GET') { sendJson(response, 200, { meetings: service.listMeetings() }); return; }
        if (path === '/api/tables' && request.method === 'POST') {
          const body = await readJson(request);
          sendJson(response, 201, { id: service.openMeeting({ ...body, managed: true }, { source: 'page' }) });
          return;
        }
        if (path === '/api/models' && request.method === 'GET') {
          try {
            const r = await context.agent.models();
            sendJson(response, 200, { models: r.models.map((m) => ({ providerId: m.providerId, modelId: m.modelId, displayName: m.displayName })), default: r.default ?? null });
          } catch { sendJson(response, 200, { models: [], default: null }); }
          return;
        }
        if (table) {
          const id = decodeURIComponent(table[1]);
          const rest = table[2] ?? '';
          if (!rest && request.method === 'GET') { sendJson(response, 200, service.snapshot(id)); return; }
          if (rest === '/close' && request.method === 'POST') { service.closeMeeting(id, (await readJson(request)).reason); sendJson(response, 200, service.snapshot(id)); return; }
          const sign = rest.match(/^\/tasks\/([^/]+)\/decision$/);
          if (sign && request.method === 'POST') {
            const body = await readJson(request);
            sendJson(response, 200, service.decide(id, decodeURIComponent(sign[1]), body.decision, body.reason));
            return;
          }
        }
        throw new ByobError('E_NOT_FOUND', 'unknown route');
      }
      if (request.method !== 'GET') throw new ByobError('E_NOT_FOUND', 'unknown route');
      const asset = CLIENT_FILES[path];
      if (asset) {
        response.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' });
        response.end(await readFile(join(clientDir, asset[0])));
        return;
      }
      // The Client handles its own views, so every other page route returns the same document.
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(await readFile(join(clientDir, 'index.html')));
    } catch (err) {
      if (response.headersSent) { response.destroy(); return; }
      if (err instanceof ByobError) { sendJson(response, err.status, { error: { code: err.code, message: err.message.replace(/^E_\w+: /, '') } }); return; }
      context.logger.error?.('hole.request.failed');
      sendJson(response, 500, { error: { code: 'E_INTERNAL', message: 'internal error' } });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(context.listen.port, context.listen.host, () => { server.off('error', reject); resolve(undefined); });
  });
  context.logger.info('hole.listening');

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    context.signal.removeEventListener('abort', onAbort);
    service.dispose();
    for (const res of streams) res.end();
    streams.clear();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  };
  const onAbort = () => { void dispose(); };
  context.signal.addEventListener('abort', onAbort, { once: true });
  if (context.signal.aborted) await dispose();
  return { dispose };
}
