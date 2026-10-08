#!/usr/bin/env python3
"""示例：一个信任 Amber 执行身份凭证的后端服务。

它是一个常驻的 HTTP 服务，只监听本机。每个请求都必须带上 Amber 签发的凭证：
    Authorization: Amber <token>
服务验证凭证后，以凭证里的 sub（执行人的飞书 union_id）作为调用人，只返回这个人有权限看的数据。

依赖：pip install cryptography（服务本身不在 Amber 沙盒里运行，可以用第三方库）
运行：python3 service.py
环境变量：
    DEMO_PORT        监听端口，默认 18790
    DEMO_AUDIENCE    本服务的名字，必须和 Amber config.json 里 services.<名字>.audience 一致，默认 demo-profile
    AMBER_KEYS_FILE  Amber 公钥文件（JWKS），默认同目录下的 amber-keys.json。部署时由 Amber 部署方导出：
                     (cd ~/amber && node src/cli.ts keys) > amber-keys.json.tmp && mv amber-keys.json.tmp amber-keys.json
                     它直接从私钥文件推出，不经端口；不要用 curl 7341 建立信任，也不要在运行时访问 7341
                     （Amber 停掉时本机任何进程都能占用这个端口冒充 Amber）。
    DEMO_DATA        权限数据文件，默认同目录下的 data.json
"""
import base64, json, os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

PORT = int(os.environ.get("DEMO_PORT", "18790"))
AUDIENCE = os.environ.get("DEMO_AUDIENCE", "demo-profile")
KEYS_FILE = os.environ.get("AMBER_KEYS_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "amber-keys.json"))
DATA = os.environ.get("DEMO_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json"))
CLOCK_SKEW = 30


def b64(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def load_keys():
    """Amber 的公钥，启动时从固定文件读入。不认识的 kid 一律拒绝；换密钥时由部署方更新文件并重启。"""
    with open(KEYS_FILE, encoding="utf-8") as f:
        jwks = json.load(f)
    return {k["kid"]: Ed25519PublicKey.from_public_bytes(b64(k["x"]))
            for k in jwks["keys"] if k.get("kty") == "OKP" and k.get("crv") == "Ed25519"}


KEYS = load_keys()
USED = {}  # jti -> exp，防重放：同一张凭证只能用一次（示例放内存；正式服务要持久化，否则重启后可重放）
USED_LOCK = threading.Lock()


class Rejected(Exception):
    pass


def verify(token):
    """验证凭证，返回 payload。任何一项不通过都拒绝。"""
    try:
        h, p, s = token.split(".")
        header, payload = json.loads(b64(h)), json.loads(b64(p))
    except Exception:
        raise Rejected("凭证格式不对")
    if header.get("alg") != "EdDSA":
        raise Rejected("算法不对")
    key = KEYS.get(header.get("kid"))
    if key is None:
        raise Rejected("不认识的密钥")
    try:
        key.verify(b64(s), f"{h}.{p}".encode())
    except InvalidSignature:
        raise Rejected("签名不对")
    now = time.time()
    if payload.get("iss") != "amber":
        raise Rejected("签发方不对")
    if payload.get("aud") != AUDIENCE:
        raise Rejected("这张凭证不是发给本服务的")
    if payload.get("exp", 0) < now - CLOCK_SKEW:
        raise Rejected("凭证已过期")
    if payload.get("iat", 0) > now + CLOCK_SKEW:
        raise Rejected("凭证时间不对")
    jti = payload.get("jti")
    with USED_LOCK:
        for k in [k for k, e in USED.items() if e < now - CLOCK_SKEW]:
            del USED[k]
        if not jti or jti in USED:
            raise Rejected("凭证已经用过")
        USED[jti] = payload["exp"]
    return payload


def load_data():
    with open(DATA, encoding="utf-8") as f:
        return json.load(f)


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        auth = self.headers.get("authorization", "")
        if not auth.startswith("Amber "):
            return self.reply(401, {"error": "缺少 Amber 凭证"})
        try:
            claims = verify(auth[len("Amber "):].strip())
        except Rejected as e:
            return self.reply(401, {"error": str(e)})
        user = claims["sub"]  # 调用人：只认凭证里的 sub，不认请求里自称的任何身份
        data = load_data()
        regions = data["permissions"].get(user, [])
        if self.path == "/sales":
            rows = [r for r in data["sales"] if r["region"] in regions]
            # 审计：谁、通过哪条指令的哪个版本、哪次执行、什么渠道
            print(f"{time.strftime('%F %T')} caller_source=amber sub={user} cmd={claims['cmd']} rev={claims['rev'][:12]} "
                  f"run={claims['run']} call={claims.get('call_index')}/{claims.get('call_count')} channel={claims['channel']} rows={len(rows)}", flush=True)
            return self.reply(200, {"user": user, "regions": regions, "rows": rows})
        return self.reply(404, {"error": "not found"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"demo service on 127.0.0.1:{PORT}, audience={AUDIENCE}, keys={list(KEYS)}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
