// API for agents. Listens on 127.0.0.1 only. Fleet machines reach it through nginx, which only
// allows the fleet's IP addresses and passes the client address in X-Amber-Client-IP (D31).
// There are no credentials, so nothing here acts as a person (D33): lookups and identity-free
// commands are answered directly; everything else becomes a confirmation card a person clicks.
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Flow, DraftInput } from './flow.ts';
import type { AgentGate, AgentContext } from './agent.ts';
import { AmberError } from './engine.ts';

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 256 * 1024) { reject(new AmberError('too_large', '请求太大')); req.destroy(); } });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new AmberError('bad_json', '请求不是合法的 JSON')); }
    });
    req.on('error', reject);
  });
}

export function startApi(port: number, machines: Record<string, string>, flow: Flow, agent: AgentGate, jwks: () => object): void {
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://amber');
    const path = url.pathname;
    // Public: services verifying Amber's execution identity tokens fetch the key set here.
    if (req.method === 'GET' && path === '/v1/keys') return reply(200, jwks());
    // Behind nginx: the client address comes from X-Amber-Client-IP. Direct loopback calls are this machine.
    const fwd = String(req.headers['x-amber-client-ip'] ?? '').trim();
    const machine = fwd ? machines[fwd] : (machines['127.0.0.1'] ?? 'local');
    if (!machine) return reply(403, { ok: false, error: 'forbidden', message: `IP ${fwd} 不在白名单里` });
    try {
      let m: RegExpExecArray | null;
      if (req.method === 'GET' && (m = /^\/v1\/requests\/([A-Za-z0-9-]{1,40})$/.exec(path))) {
        return reply(200, { ok: true, ...(await agent.requestStatus(m[1], Number(url.searchParams.get('wait') ?? 0))) });
      }
      if (req.method === 'GET' && (m = /^\/v1\/runs\/([A-Za-z0-9-]{1,40})$/.exec(path))) {
        return reply(200, { ok: true, ...agent.runResult(m[1]) });
      }
      if (req.method !== 'POST') return reply(404, { ok: false, error: 'not_found' });
      const body = await readBody(req);
      if (path === '/v1/drafts') {
        const input = body as DraftInput;
        // The machine is known from the address; the agent may only add a label after it.
        const label = typeof input.submittedBy === 'string' && input.submittedBy.trim() ? `${input.submittedBy.trim().slice(0, 40)} @ ${machine}` : machine;
        return reply(200, { ok: true, ...(await flow.submitDraft({ ...input, submittedBy: label })) });
      }
      const ctx = await agent.context(body as AgentContext, machine);
      if (path === '/v1/commands/list') return reply(200, { ok: true, commands: agent.list(ctx) });
      if (path === '/v1/commands/show') return reply(200, { ok: true, command: agent.show(ctx, String(body.command ?? '')) });
      if (path === '/v1/runs') return reply(200, { ok: true, ...(await agent.run(ctx, String(body.command ?? ''), body.args ?? {})) });
      if (path === '/v1/schedules/list') return reply(200, { ok: true, schedules: agent.schedules(ctx) });
      if (path === '/v1/schedules') return reply(200, { ok: true, ...(await agent.scheduleAdd(ctx, String(body.command ?? ''), body.args ?? {}, String(body.at ?? ''), body.tz)) });
      if ((m = /^\/v1\/schedules\/([A-Za-z0-9-]{1,40})\/(pause|resume|delete)$/.exec(path))) {
        if (m[2] === 'pause') return reply(200, { ok: true, ...agent.schedulePause(ctx, m[1]) });
        return reply(200, { ok: true, ...(await agent.scheduleChange(ctx, m[1], m[2] === 'resume' ? 'schedule_resume' : 'schedule_delete')) });
      }
      return reply(404, { ok: false, error: 'not_found' });
    } catch (e) {
      if (e instanceof AmberError) return reply(e.code === 'not_found' ? 404 : 400, { ok: false, error: e.code, message: e.message });
      console.log(new Date().toISOString(), 'api error', path, (e as Error).message);
      return reply(500, { ok: false, error: 'internal', message: (e as Error).message });
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(new Date().toISOString(), `api listening on 127.0.0.1:${port}`));
}
