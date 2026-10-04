import { createServer } from 'node:http';
import { migrationsCurrent } from './db/database.js';

export function createHealthServer({ port, version, readiness }) {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.method !== 'GET') { response.statusCode = 405; return response.end('{"error":"method_not_allowed"}'); }
    if (request.url === '/healthz') { response.statusCode = 200; return response.end('{"status":"alive"}'); }
    if (request.url === '/version') { response.statusCode = 200; return response.end(JSON.stringify({ version })); }
    if (request.url === '/readyz') {
      try {
        const state = readiness();
        const ready = Boolean(state.started && state.db && migrationsCurrent(state.db) && state.telegramReady);
        response.statusCode = ready ? 200 : 503;
        return response.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
      } catch { response.statusCode = 503; return response.end('{"status":"not_ready"}'); }
    }
    response.statusCode = 404;
    response.end('{"error":"not_found"}');
  });
  server.listen(port, '0.0.0.0');
  return server;
}
