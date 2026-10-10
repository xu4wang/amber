// GENERATED from src/egress-proxy.ts by scripts/build-executor.mjs — do not edit.
// The only way out of the sandbox to the network for scripts that may not connect directly: a local HTTPS
// proxy (CONNECT) that lets through only the hosts on the environment's allow list (allowHosts). Used by Amber
// for local runs and, generated into client/amber-executor, by executors. Node built-ins only.
import { createServer,             } from 'node:http';
import { connect,             } from 'node:net';

/** At most this many entries per list. */
export const MAX_ALLOW_HOSTS = 50;
const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9](:\d{1,5})?$/;

/** "example.com", "*.example.com" (any subdomain, not the bare domain), optionally ":port" (default 443).
 *  Lower-case host names only: no IP addresses, no bare "*". Throws with the reason. */
export function validateHosts(x         , where = 'allowHosts')           {
  if (!Array.isArray(x)) throw new Error(`${where} 要是域名数组，例如 ["*.feishu.cn"]`);
  if (x.length > MAX_ALLOW_HOSTS) throw new Error(`${where} 最多 ${MAX_ALLOW_HOSTS} 项`);
  const out           = [];
  for (const v of x) {
    const s = String(v).trim().toLowerCase();
    const port = s.includes(':') ? Number(s.split(':')[1]) : 443;
    if (!HOST.test(s) || !(port >= 1 && port <= 65535)) throw new Error(`${where} 里的「${String(v)}」不对：要写域名或 *.域名，可以带 :端口`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Whether host:port is on the list. "*.a.com" matches "x.a.com" and "x.y.a.com", not "a.com". */
export function hostAllowed(host        , port        , list          )          {
  const h = host.toLowerCase().replace(/\.$/, '');
  return list.some(entry => {
    const [name, p] = entry.split(':');
    if ((p ? Number(p) : 443) !== port) return false;
    return name.startsWith('*.') ? h.endsWith(name.slice(1)) && h.length > name.length - 1 : h === name;
  });
}

const IDLE_MS = 120_000;
/** Open tunnels per run, and how long reaching an allowed host may take: a script cannot pile up sockets. */
export const MAX_TUNNELS = 32;
const CONNECT_MS = 15_000;

/** Starts the proxy on 127.0.0.1 (a free port). Only CONNECT to allowed host:port; anything else gets 403. */
export function startEgressProxy(list          , o                          = {})                                           {
  const sockets = new Set        ();
  let tunnels = 0;
  const server         = createServer((_req, res) => { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); res.end('只支持 HTTPS（CONNECT）'); });
  server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.on('connect', (req, client        , head        ) => {
    const m = /^([^:\s]+):(\d{1,5})$/.exec(req.url ?? '');
    const host = m?.[1] ?? '', port = Number(m?.[2]);
    if (!m || !hostAllowed(host, port, list)) {
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain; charset=utf-8\r\n\r\n${host || req.url} 不在这个环境的网络白名单里\r\n`);
      return;
    }
    if (tunnels >= (o.maxTunnels ?? MAX_TUNNELS)) { client.end(`HTTP/1.1 503 Service Unavailable\r\n\r\n同时打开的连接太多（最多 ${o.maxTunnels ?? MAX_TUNNELS} 个）\r\n`); return; }
    tunnels++;
    let counted = true;
    const done = () => { if (counted) { counted = false; tunnels--; } };
    let connected = false;
    const upstream = connect(port, host, () => {
      connected = true;
      upstream.setTimeout(IDLE_MS);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => { sockets.delete(upstream); done(); client.destroy(); });
    client.on('close', () => upstream.destroy());
    // Before the tunnel is up the client still speaks HTTP to us; after that only bytes for the host flow.
    const fail = () => { if (!connected && !client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); else client.destroy(); upstream.destroy(); };
    upstream.on('error', fail);
    client.on('error', () => upstream.destroy());
    upstream.setTimeout(CONNECT_MS);   // until connected; then idle time (above)
    upstream.on('timeout', () => { fail(); });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address()                    ).port;
      resolve({ port, close: () => { for (const s of sockets) s.destroy(); server.close(); } });
    });
  });
}

/** Environment variables that send HTTP clients (curl, Python, Go, Node with a proxy agent, lark-cli) through the proxy. */
export function proxyEnv(port        )                         {
  const url = `http://127.0.0.1:${port}`;
  return { HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url, ALL_PROXY: url, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
}
