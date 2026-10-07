// API for agents. Listens on 127.0.0.1 only. Fleet machines reach it through nginx, which only
// allows the fleet's IP addresses and passes the client address in X-Amber-Client-IP (D31).
// There are no credentials: this surface can only submit drafts — it cannot claim, review or run
// anything — so access by IP is enough. The submitting machine is derived from the address.
import { createServer } from 'node:http';
import type { Flow, DraftInput } from './flow.ts';
import { AmberError } from './engine.ts';

export function startApi(port: number, machines: Record<string, string>, flow: Flow, jwks: () => object): void {
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    // Public: services verifying Amber's execution identity tokens fetch the key set here.
    if (req.method === 'GET' && req.url === '/v1/keys') return reply(200, jwks());
    // Behind nginx: the client address comes from X-Amber-Client-IP. Direct loopback calls are this machine.
    const fwd = String(req.headers['x-amber-client-ip'] ?? '').trim();
    const machine = fwd ? machines[fwd] : (machines['127.0.0.1'] ?? 'local');
    if (!machine) return reply(403, { error: 'forbidden', message: `IP ${fwd} 不在白名单里` });
    if (req.method === 'POST' && req.url === '/v1/drafts') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 256 * 1024) req.destroy(); });
      req.on('end', async () => {
        try {
          const input = JSON.parse(body) as DraftInput;
          // The machine is known from the address; the agent may only add a label after it.
          const label = typeof input.submittedBy === 'string' && input.submittedBy.trim() ? `${input.submittedBy.trim().slice(0, 40)} @ ${machine}` : machine;
          const r = await flow.submitDraft({ ...input, submittedBy: label });
          reply(200, { ok: true, ...r });
        } catch (e) {
          reply(400, { ok: false, error: e instanceof AmberError ? e.code : 'bad_request', message: (e as Error).message });
        }
      });
      return;
    }
    reply(404, { error: 'not_found' });
  });
  server.listen(port, '127.0.0.1', () => console.log(new Date().toISOString(), `api listening on 127.0.0.1:${port}`));
}
