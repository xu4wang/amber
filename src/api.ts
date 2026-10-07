// Local API for agents. Listens on 127.0.0.1 only and requires the machine token.
// This surface can only submit drafts — it cannot claim,
// review or run anything, so a leaked machine token cannot get past the human steps.
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Flow, DraftInput } from './flow.ts';
import { AmberError } from './engine.ts';

export function machineToken(configDir: string): string {
  const p = join(configDir, 'machine-token');
  if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  return readFileSync(p, 'utf8').trim();
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function startApi(port: number, token: string, flow: Flow, jwks: () => object): void {
  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    // Public: services verifying Amber's execution identity tokens fetch the key set here.
    if (req.method === 'GET' && req.url === '/v1/keys') return reply(200, jwks());
    const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!same(auth, token)) return reply(401, { error: 'unauthorized' });
    if (req.method === 'POST' && req.url === '/v1/drafts') {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 256 * 1024) req.destroy(); });
      req.on('end', async () => {
        try {
          const input = JSON.parse(body) as DraftInput;
          const r = await flow.submitDraft(input);
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
