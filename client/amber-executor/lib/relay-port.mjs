// GENERATED from src/relay-port.ts by scripts/build-executor.mjs — do not edit.
// The script's end of a service call (D52): one 127.0.0.1 port per declared service, the only address its
// sandbox may reach. A request must present one of the job's tokens it has not used yet, so other processes
// on the machine cannot use the port or spend the job's calls; it is then handed to `send`, which takes it to
// Amber's relay — an executor signs it and posts it to /v1/executor/relay, Amber's own machine calls the relay
// directly. Either way the script's code is the same: services[name].tcpPort is this port.
// Used by Amber for runs on its own machine and, generated into client/amber-executor, by executors.
import { createServer } from 'node:http';

export const RELAY_MAX_REQUEST = 512 * 1024;
                                                                                                                              
                                                                                 
                                                                                                                                

const json = (error        , message        ) => Buffer.from(JSON.stringify({ error, message }));

/** `send` answers a request that passed the token check; when it throws, the script gets 403 with its message. */
export async function startRelayPorts(services                                                  , send                                          )                      {
  const names = Object.keys(services ?? {});
  if (!names.length) return { ports: [], close() {} };
  const servers                               = [], out                                                        = {};
  const close = () => { for (const s of servers) { s.close(); s.closeAllConnections?.(); } };
  try {
    for (const name of names) {
      const tokens = services [name]?.tokens ?? [];
      const unused = new Set(tokens);
      const srv = createServer((req, res) => {
        const chunks           = [];
        let n = 0, big = false;
        const reply = (status        , type        , body        ) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': type }); res.end(body); } };
        req.on('data', (c        ) => { n += c.length; if (n > RELAY_MAX_REQUEST) { big = true; chunks.length = 0; } else if (!big) chunks.push(c); });
        req.on('end', async () => {
          if (big) return reply(413, 'application/json', json('too_large', `请求超过 ${RELAY_MAX_REQUEST / 1024}KB`));
          const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
          const tok = [...unused].find(t => auth === `Amber ${t}`);
          if (!tok) return reply(403, 'application/json', json('relay_refused', '请求没有带这次任务未用过的凭证'));
          unused.delete(tok);
          const headers                         = {};
          for (const k of ['authorization', 'content-type', 'accept']) if (typeof req.headers[k] === 'string') headers[k] = req.headers[k]          ;
          try {
            const r = await send({ service: name, method: String(req.method), path: String(req.url), headers, body: Buffer.concat(chunks) });
            reply(r.status, r.contentType || 'application/octet-stream', r.body);
          } catch (e) {
            reply(403, 'application/json', json('relay_refused', (e         ).message));
          }
        });
      });
      // Bounded: a few connections, and requests that do not finish in time are dropped.
      srv.maxConnections = 8;
      srv.headersTimeout = 10_000;
      srv.requestTimeout = 30_000;
      servers.push(srv);
      await new Promise      ((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve()); });
      out[name] = { tokens, tcpPort: (srv.address()                                  ).port };
    }
  } catch (e) { close(); throw e; }
  return { ports: Object.values(out).map(s => s.tcpPort), services: out, close };
}
