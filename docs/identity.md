# 可信身份

Amber 的核心约定是：**执行人是谁，只能由飞书告诉 Amber**，不能由 agent、模型或请求方自己声明。下面分三部分说明：Amber 怎么确认执行人；脚本调用后端服务时，怎么把这个身份可靠地交给服务；服务方怎么验证。

> 想直接看能运行的代码：[可信身份：完整示例](identity-example.md)（Python 服务 + 应用脚本 + 配置，一步步走完）。

## 1. 身份从哪来

| 入口 | 执行人 | 身份来源 |
|---|---|---|
| 飞书里 @Amber 或私聊 Amber，在表单卡片上执行 | 发消息或点卡片的人 | 飞书事件里的 `sender` 或 `operator`（union_id） |
| agent 调用 `amber run`，需要身份的应用 | **点确认卡片的人** | 卡片回调事件里的 `operator` |
| agent 调用 `amber run`，不需要身份的应用 | 记为 `agent:<机器名>` | 不代表任何人，也不签发凭证 |
| 定时任务 | 定时任务的创建人 | 创建时点「创建定时任务」的人（卡片事件），或者网站上已登录的人 |
| 网站 | 已登录的人 | 网站登录（见下文），登录凭证只由 Amber 在本人私聊里发出 |
| 认领时试运行 | 认领人 | 认领卡的点击事件 |

几条刻意的限制：

- **agent 接口不带凭证、只按 IP 放行**，所以它永远不能代表某个人。`--user` 只决定谁能点卡片、私聊里看哪个人的应用，不会作为执行身份。
- 卡片指定了被请求人时，别人点击会被拒绝；群里的卡片只能在原来的群里点。
- 确认卡片只能处理一次，24 小时后过期。
- 应用的执行身份可以以后再加第四种来源：botmux MCP 网关在每次调用时签发的可信调用人。前提是 botmux 先修好「身份绑定在最后一次输入上」的问题。目前没有启用。

## 2. 网站登录

网站不用飞书 OAuth，也就不需要配置回调地址。

1. 用户在飞书私聊 Amber 发送「登录」；也可以在群里 @Amber 发「登录」，这时 Amber 把登录卡片**发到这个人和 Amber 的私聊里**，群里只回一句「已私聊发给你」。登录链接永远不会出现在群里。私聊发不出去时，作废这次的登录码并提示用户直接私聊。
2. Amber 生成一个 256 位的随机登录码，数据库里只存它的 sha256。回复一张卡片，按钮链接是 `<webBaseUrl>/login?t=<登录码>`。登录码和发消息的人（union_id）绑定，**5 分钟内有效、只能用一次**。
3. 浏览器打开链接后，Amber 发放会话 cookie：`HttpOnly`、`SameSite=Lax`，有效期 7 天，服务端同样只存哈希。随后把那张卡片改成「已登录」，用户能立刻发现是否有人冒用。
4. 私聊发「退出网站」，会让这个人在所有浏览器里的登录失效。

为什么不用「网页上显示一串码，到 Amber 那里输入」：这种方式会被钓鱼。攻击者可以把自己网页上的码发给别人，骗对方去确认，结果攻击者的浏览器就以对方的身份登录了。现在的做法是登录凭证只出现在本人的私聊里，剩下的风险只有「本人把卡片转发给别人」，所以设计成一次性加短有效期。

网站的写操作只接受 `application/json`，而且 `Origin` 必须是本站，用来防跨站请求。群应用只有确认登录人是群成员才能用；确认不了（比如缺权限）就一律拒绝。

## 3. 执行身份凭证

应用脚本要以执行人的身份调用后端服务（例如查数仓）时，Amber 会为**每次执行、每个声明的服务**签发一张短时效凭证。服务方只要信任 Amber 的公钥，不需要信任 Amber 的进程，更不需要信任脚本。

### 3.1 Amber 保证什么

| 保证 | 怎么做到 |
|---|---|
| 执行人可靠 | 只来自上面第 1 节的飞书事件或网站登录 |
| 代码经过审核 | 认领人先试运行，所有审核人同意后应用才生效。凭证里的 `rev` 是审核通过那一版定义的哈希，每次执行前都会重新计算核对 |
| 数据不外传 | 声明了服务的脚本，沙盒只放行这些服务的本机端口或 unix socket，外网和其他本机端口全部断开。声明服务和开放外网不能同时选，提交草稿时就会被拒绝 |
| 用途受限 | 一张凭证只对一个服务有效（`aud` 由 Amber 配置决定，脚本改不了）；5 分钟过期；带一次性编号 `jti`；每次签发都写审计 |

### 3.2 格式

JWS Compact（即 JWT），算法 EdDSA（Ed25519）。

```text
header  { "alg": "EdDSA", "typ": "JWT", "kid": "<公钥指纹>" }
payload {
  "iss": "amber",
  "aud": "data-mcp",          服务名，取自 Amber 配置 services.<名称>.audience
  "sub": "on_…",              执行人的飞书 union_id
  "cmd": "9bba8b5d",          应用 id
  "rev": "075b025f…",         应用定义哈希（审核通过的那一版）
  "run": "85df3e7f",          本次执行 id
  "chat": "oc_…",             应用所属的群或私聊
  "channel": "bot",           bot / web / agent / schedule；试运行时加 .trial，例如 bot.trial；页面应用里的调用是 web
  "call_index": 1,            这是本次执行的第几张凭证（从 1 开始）
  "call_count": 2,            本次执行对这个服务一共签了几张，等于脚本声明的 calls
  "iat": 1791389686, "exp": 1791389986,
  "jti": "uuid"
}
```

### 3.3 配置服务

在 Amber 的 `config.json` 里登记服务：

```json
"services": {
  "data-mcp": { "audience": "data-mcp", "tcpPort": 8765 }
}
```

> 例子里的 data-mcp 是企业内部的数仓应用，Amber 把它作为可信服务访问，见下面「已接入的服务：data-mcp」。

`tcpPort` 也可以换成 `"unixSocket": "/path/to/service.sock"`。应用脚本声明 `"services": {"data-mcp": {"calls": 2}}` 后（`calls` = 每次执行最多调用几次，1–20 的整数，随代码一起审核、计入版本哈希），运行时会从标准输入收到：

```json
{"services": {"data-mcp": {"tokens": ["eyJhbGciOiJFZERTQSIs…", "eyJhbGciOiJFZERTQSIs…"], "tcpPort": 8765}}}
```

`tokens` 按 `call_index` 排好序。脚本每次请求用一张，例如 `Authorization: Amber <token>`，具体怎么带由服务方决定。每张都有独立的 `jti`，服务方应当**每张只接受一次**；用完就没有了，Amber 不会在运行中补签。旧写法 `"services": ["data-mcp"]` 提交时会被拒绝。

### 3.4 服务方怎么验证

1. **取公钥**：由 Amber 的部署方在 Amber 所在机器上运行 `node src/cli.ts keys`。它直接从已有的签名私钥文件推出公钥（JWKS 输出到标准输出，`kid` 输出到标准错误），**不经过任何端口、只读**：私钥不存在或权限对同组、其他用户开放时直接报错，不会生成新密钥。部署方把 JWKS 和 `kid` 通过部署记录交给服务方；服务方核对 `kid` 一致后，先写临时文件再 `mv` 原子替换，把公钥**整份写进服务自己的配置**。
   - 不要用 `curl 127.0.0.1:7341/v1/keys` 建立信任：Amber 停掉时，本机任何进程都能占用 7341 端口冒充 Amber，那时固定下来的就是假钥匙。`/v1/keys` 只适合事后对照。
   - 运行时也不要访问 7341。遇到配置里没有的 `kid` 直接拒绝。
   - 局限：在 Amber 私钥改由专用系统用户持有之前，同一系统用户下的任何进程都能读私钥，凭证只能证明「来自这台机器上的这个用户」，不能证明来自 Amber 进程。
2. **验签**：用 `kid` 对应的 Ed25519 公钥验证签名。
3. **检查声明**：`iss == "amber"`，`aud ==` 本服务名，`exp` 没过期（建议允许 30 秒时钟误差）。
4. **防重放**：持久化记录用过的 `jti`（保留到 `exp` 之后），重复的拒绝；只放内存在服务重启后会失效。`call_index`、`call_count` 以签名里的为准，请求体里的同名字段一律忽略。
5. **以 `sub`（union_id）作为调用人**，走和其他入口完全相同的权限判断；请求体里自称的任何身份字段一律忽略。
6. **审计**：记录 `caller_source = "amber"`，以及 `cmd`、`rev`、`run`、`channel`。

服务方还可以自己决定一些策略，比如拒绝试运行（`channel` 以 `.trial` 结尾）、对 `schedule` 来源单独限流、限制能查的库表。这些都在服务方实现，Amber 不需要改动。

Node.js（只用内置模块）：

```js
import { createPublicKey, verify } from 'node:crypto';

const jwks = await (await fetch('http://127.0.0.1:7341/v1/keys')).json();
const keys = Object.fromEntries(jwks.keys.map(k => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));

function verifyAmber(token, audience) {
  const [h, p, s] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  const key = keys[header.kid];
  if (header.alg !== 'EdDSA' || !key) throw new Error('unknown key');
  if (!verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw new Error('bad signature');
  const now = Date.now() / 1000;
  if (payload.iss !== 'amber' || payload.aud !== audience || payload.exp < now - 30) throw new Error('bad claims');
  return payload;   // payload.sub 就是执行人的 union_id
}
```

Python（需要 `cryptography`）：

```python
import base64, json, time, urllib.request
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

def b64(s): return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

jwks = json.load(urllib.request.urlopen("http://127.0.0.1:7341/v1/keys"))
KEYS = {k["kid"]: Ed25519PublicKey.from_public_bytes(b64(k["x"])) for k in jwks["keys"]}

def verify_amber(token, audience):
    h, p, s = token.split(".")
    header, payload = json.loads(b64(h)), json.loads(b64(p))
    key = KEYS.get(header.get("kid"))
    if header.get("alg") != "EdDSA" or key is None:
        raise ValueError("unknown key")
    key.verify(b64(s), f"{h}.{p}".encode())          # 签名不对会抛 InvalidSignature
    if payload["iss"] != "amber" or payload["aud"] != audience or payload["exp"] < time.time() - 30:
        raise ValueError("bad claims")
    return payload                                    # payload["sub"] 就是执行人的 union_id
```

### 3.5 密钥

私钥在 `~/.config/amber/signing-key.pem`（0600），首次启动时自动生成。轮换时让 `/v1/keys` 同时发布新旧两把公钥，用 `kid` 区分；等旧凭证全部过期后再撤掉旧的。目前只有一把固定密钥，轮换功能还没实现。

### 3.6 已接入的服务：data-mcp

data-mcp 是企业内部的数仓应用（只读查数），Amber 把它作为可信服务、按上面的规则接入。它的 Amber 入口是一个单独的进程，只监听 `127.0.0.1`，默认端口 8766，部署时以 `config.json` 里 `services.data-mcp` 登记的端口为准，脚本一律读输入里的 `tcpPort`。

**请求**：只有一个接口，一次请求里先校验 SQL、再执行，所以每次查询只消耗一张凭证，应用声明 `"services": {"data-mcp": {"calls": 1}}` 即可；要查几次就声明几次。

```
POST /amber/query
Authorization: Amber <token>
Content-Type: application/json

{"sql": "SELECT …", "datasource": "tchouse-c"}
```

- 请求体只接受 `sql` 和 `datasource` 两个字段（`datasource` 默认 `tchouse-c`），多带任何字段返回 422。执行人身份只取自凭证的 `sub`，请求体里没有、也不接受身份字段。
- 每张凭证只能用一次。

**响应**：

| HTTP 状态 | 含义 |
|---|---|
| 200 | 请求被处理。是否成功看 body 里的 `status` |
| 401 | 凭证缺失、验签失败或已过期，`detail` 是错误码，例如 `missing_amber_authorization` |
| 409 | 凭证已经用过 |
| 422 | 请求体字段不对 |
| 429 | 定时执行（`channel` 为 `schedule`）超过限流，默认每分钟 10 次 |

200 的 body 是 data-mcp 平常的查询结果，另加一个 `amber_audit_id`：

| 字段 | 说明 |
|---|---|
| `status` | `success` / `validation_error` / `not_found` / `error`，只有 `success` 才算成功 |
| `columns` | `[{"name", "type", …}]` |
| `rows` | 对象数组，以列名为键 |
| `row_count`、`truncated` | 行数，以及是否被截断 |
| `quality_warnings` | 数据质量提示 |
| `error_code`、`error_name`、`retryable` | 失败时的原因；校验没过时原因也可能在 `issues[].code` |
| `query_id` | 本次查询的 id，排查时用 |

**服务方策略**：试运行（`channel` 以 `.trial` 结尾）最多返回 20 行；定时执行单独限流。

最小的 Python 脚本：

```python
import json, sys, urllib.request, urllib.error

inp = json.load(sys.stdin)
svc = inp["services"]["data-mcp"]
req = urllib.request.Request(
    f"http://127.0.0.1:{svc['tcpPort']}/amber/query",
    data=json.dumps({"sql": "SELECT 1 AS x"}).encode(),
    headers={"Authorization": "Amber " + svc["tokens"][0], "Content-Type": "application/json"},
)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 不走代理
try:
    r = json.load(opener.open(req, timeout=80))
except urllib.error.HTTPError as e:
    sys.exit("服务拒绝：" + e.read().decode("utf-8", "replace")[:300])
if r.get("status") != "success":
    sys.exit("查询失败：" + str(r.get("error_code") or r.get("issues") or r.get("status"))[:300])
print(r["rows"])
```
