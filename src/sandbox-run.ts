// Runs one Python script in a sandbox (D49): sandbox-exec with a compiled profile on macOS, bubblewrap with
// compiled arguments on Linux (D58). Used by Amber for local runs and, generated into client/amber-executor,
// by executors (D50). Node built-ins only.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createServer, connect, type Server } from 'node:net';
import { startEgressProxy, proxyEnv } from './egress-proxy.ts';

/** On Linux the script has its own network namespace (only loopback). This forwarder starts first inside the sandbox,
 *  listens on the allowed local ports there and passes each connection to a Unix socket in the run dir, which Amber /
 *  the executor bridges to the same port outside (the egress proxy, relay ports). Then it runs the script. */
const LINUX_FORWARDER = `import json, os, socket, subprocess, sys, threading
base = os.path.dirname(os.path.abspath(__file__))
ports = json.loads(sys.argv[1])
cmd = sys.argv[3:]
def pump(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    finally:
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
def serve(srv, port):
    while True:
        c, _ = srv.accept()
        u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            u.connect(os.path.join(base, "%d.sock" % port))
        except OSError:
            c.close()
            continue
        threading.Thread(target=pump, args=(c, u), daemon=True).start()
        threading.Thread(target=pump, args=(u, c), daemon=True).start()
for p in ports:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", p))
    s.listen(64)
    threading.Thread(target=serve, args=(s, p), daemon=True).start()
sys.exit(subprocess.call(cmd))
`;

/** Unix sockets in `dir`, one per port, each passing connections to 127.0.0.1:port on this machine. */
async function bridgePorts(dir: string, ports: number[]): Promise<Server[]> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return Promise.all(ports.map(port => new Promise<Server>((resolve, reject) => {
    const srv = createServer(c => {
      const up = connect({ host: '127.0.0.1', port });
      c.pipe(up).pipe(c);
      const end = () => { c.destroy(); up.destroy(); };
      c.on('error', end); up.on('error', end); c.on('close', end); up.on('close', end);
    });
    srv.on('error', reject);
    srv.listen(join(dir, `${port}.sock`), () => resolve(srv));
  })));
}

const BWRAP = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'];

export const MAX_OUTPUT_BYTES = 256 * 1024;
/** Last three non-empty lines, joined, capped so one long line (a JSON table) cannot flood the error. */
const tail = (s: string) => { const t = s.trim().split('\n').filter(l => l.trim()).slice(-3).join(' / '); return t.length > 500 ? '…' + t.slice(-500) : t; };
export interface SandboxResult { ok: boolean; content: string; error?: string }

/** `profileFor` gets the run's private dir (also cwd, HOME and TMPDIR); inputs go in on stdin as JSON. */
/** `home`: HOME for the script (default: the run dir). Only reachable as far as the profile allows. With a real home,
 *  Python also loads the user's own site-packages (`-E` instead of `-I`), as it does in that user's sessions.
 *  `egress`: the environment's network allow list. When set, a local proxy lets the script reach those hosts only;
 *  `profileFor` gets the proxy's port among the local ports to allow, and the script gets HTTPS_PROXY. */
/** `bwrapFor` (Linux, D58): bubblewrap arguments for the run dir instead of a Seatbelt profile; `localPorts` are then
 *  bridged into the script's own network namespace (LINUX_FORWARDER). `bwrapNetwork`: the script has the host network
 *  (an app with network: true), so there is nothing to bridge. */
export async function runSandboxed(o: { code: string; python: string; profileFor?: (runDir: string, localPorts: number[]) => string; bwrapFor?: (runDir: string) => string[]; bwrapNetwork?: boolean; localPorts?: number[]; input: unknown; timeoutMs?: number; env?: Record<string, string>; home?: string; egress?: string[] }): Promise<SandboxResult> {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'amber-run-')));
  let proxy: { port: number; close(): void } | undefined;
  let bridges: Server[] = [];
  try {
    const file = join(work, 'main.py');
    writeFileSync(file, o.code);
    if (o.egress?.length) proxy = await startEgressProxy(o.egress);
    const ports = [...(o.localPorts ?? []), ...(proxy ? [proxy.port] : [])];
    const py = [o.python, o.home ? '-E' : '-I', file];
    let cmd: string, args: string[];
    if (o.bwrapFor) {
      cmd = BWRAP.find(p => existsSync(p)) ?? 'bwrap';
      let inner = py;
      if (!o.bwrapNetwork && ports.length) {
        const net = join(work, '.amber-net');
        bridges = await bridgePorts(net, ports);
        writeFileSync(join(net, 'fwd.py'), LINUX_FORWARDER);
        inner = [o.python, '-I', join(net, 'fwd.py'), JSON.stringify(ports), '--', ...py];
      }
      args = [...o.bwrapFor(work), '--chdir', work, '--', ...inner];
    } else {
      if (!o.profileFor) throw new Error('没有沙箱配置');
      cmd = '/usr/bin/sandbox-exec';
      args = ['-p', o.profileFor(work, ports), ...py];
    }
    // Nothing user-supplied is ever placed on a command line.
    const env: Record<string, string> = { PATH: `/opt/homebrew/bin:/usr/local/bin:${homedir()}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, ...o.env, ...(proxy ? proxyEnv(proxy.port) : {}), TMPDIR: work, HOME: o.home ?? work, LANG: o.bwrapFor ? 'C.UTF-8' : 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8' };
    return await new Promise<SandboxResult>(resolve => {
      const child = spawn(cmd, args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = Buffer.alloc(0);
      let err = '';
      let big = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 30000);
      child.stdout.on('data', (b: Buffer) => { out = Buffer.concat([out, b]); if (out.length > MAX_OUTPUT_BYTES) { big = true; child.kill('SIGKILL'); } });
      child.stderr.on('data', (b: Buffer) => { if (err.length < 4000) err += b.toString(); });
      child.on('error', e => { clearTimeout(timer); resolve({ ok: false, content: '', error: `启动失败：${e.message}` }); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (big) return resolve({ ok: false, content: '', error: '输出超过 256KB' });
        if (signal) return resolve({ ok: false, content: '', error: '运行超时或被终止' });
        if (code !== 0) {
          // A script may report its failure on either stream; show the tail of both, stderr first.
          const why = [err, out.toString('utf8')].map(tail).filter(Boolean).join(' / ');
          return resolve({ ok: false, content: '', error: `脚本退出码 ${code}${why ? `：${why}` : ''}` });
        }
        resolve({ ok: true, content: out.toString('utf8') });
      });
      child.stdin.on('error', () => { /* script exited without reading stdin */ });
      child.stdin.end(JSON.stringify(o.input));
    });
  } finally {
    proxy?.close();
    for (const b of bridges) b.close();
    rmSync(work, { recursive: true, force: true });
  }
}
