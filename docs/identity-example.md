# 可信身份：完整示例

本文用一个能运行的 Python 例子，走一遍「让固化指令以执行人的身份调用后端服务」的完整流程。例子的代码在仓库 [`examples/identity-service/`](../examples/identity-service/) 里。原理和凭证格式见 [可信身份](identity.md)。

## 1. 先分清两样东西

使用可信身份时，涉及的不是一个脚本，而是两样东西：

| | 服务 | 指令脚本 |
|---|---|---|
| 是什么 | 一个**常驻的后端程序**，例如 Data MCP 或者你们自己的查询服务 | 固化指令里的那段 Python |
| 谁写、谁运行 | 服务方写，由运维部署在 Amber 所在的机器上，一直运行 | agent 写，经认领和审核，每次执行时由 Amber 在沙盒里运行一次 |
| 拿着什么 | 数据库账号、权限规则等真正的访问能力 | 只有 Amber 为本次执行签发的一张凭证，5 分钟内有效，只能用一次 |
| 负责什么 | 验证凭证，按凭证里的执行人只返回他有权限的数据 | 带着凭证调用服务，把结果整理成 Markdown 输出 |

这样分工的好处：脚本永远碰不到数据库账号，也冒充不了别人。脚本能拿到什么数据，完全由服务按「真正点按钮的那个人」来判断。

一次执行的过程：

```text
执行人在飞书 / 网站点「执行」（身份来自飞书）
  → Amber 核对指令版本，为执行人签发凭证：sub = 执行人、aud = demo-profile
  → 在沙盒里运行指令脚本，通过标准输入把凭证和服务端口交给它
      沙盒只放行 demo-profile 的端口，外网和其他本机端口都连不上
  → 脚本调用服务：Authorization: Amber <凭证>
  → 服务验证签名、服务名、有效期和一次性编号，以 sub 判断权限，返回数据
  → 脚本输出 Markdown，Amber 把结果显示给执行人
```

## 2. 写服务

[`service.py`](../examples/identity-service/service.py) 是一个只有 Python 标准库加 `cryptography` 的 HTTP 服务。它提供 `GET /sales`，返回「调用人有权限的区域」的销售额。权限规则写在 [`data.json`](../examples/identity-service/data.json) 里：

```json
{
  "permissions": { "on_某人的union_id": ["华东", "华南"] },
  "sales": [ { "region": "华东", "month": "2026-09", "amount": 1410000 } ]
}
```

服务验证凭证的核心代码（完整代码见文件）：

```python
def verify(token):
    h, p, s = token.split(".")
    header, payload = json.loads(b64(h)), json.loads(b64(p))
    if header.get("alg") != "EdDSA":
        raise Rejected("算法不对")
    key = KEYS.get(header.get("kid"))            # Amber 公钥，来自 /v1/keys，按 kid 缓存
    key.verify(b64(s), f"{h}.{p}".encode())       # 签名不对会抛异常
    if payload["iss"] != "amber":                 raise Rejected("签发方不对")
    if payload["aud"] != AUDIENCE:                raise Rejected("这张凭证不是发给本服务的")
    if payload["exp"] < time.time() - 30:         raise Rejected("凭证已过期")
    if payload["jti"] in USED:                    raise Rejected("凭证已经用过")
    USED[payload["jti"]] = payload["exp"]
    return payload

# 处理请求时，只认凭证里的 sub，不认请求里自称的任何身份
user = verify(auth[len("Amber "):])["sub"]
rows = [r for r in data["sales"] if r["region"] in data["permissions"].get(user, [])]
```

部署和启动：

```sh
python3 -m venv ~/demo-service-venv
~/demo-service-venv/bin/pip install cryptography
cd examples/identity-service
DEMO_PORT=18790 DEMO_AUDIENCE=demo-profile ~/demo-service-venv/bin/python service.py
# 输出：demo service on 127.0.0.1:18790, audience=demo-profile, keys=[...]
```

注意：

- 服务**只监听 127.0.0.1**，和 Amber 在同一台机器上。
- 端口要选一个没被占用的。先用 `lsof -nP -iTCP:<端口> -sTCP:LISTEN` 检查。如果端口上其实是别的程序，凭证就会被发给那个程序。
- 正式使用时，用 launchd 之类的工具让服务常驻，写法参照 [安装与部署](install.md#常驻运行launchd) 里 Amber 自己的 plist。
- 服务启动时就会去拉 Amber 的公钥，所以要先启动 Amber。

## 3. 在 Amber 里登记服务

在 Amber 的 `~/.config/amber/config.json` 里加上：

```json
"services": {
  "demo-profile": { "audience": "demo-profile", "tcpPort": 18790 }
}
```

- 键名 `demo-profile` 是指令脚本里声明服务时用的名字。
- `audience` 会写进凭证的 `aud`，必须和服务端的 `DEMO_AUDIENCE` 一致。
- `tcpPort` 是服务监听的端口。也可以改用 `"unixSocket": "/path/to/service.sock"`。

改完重启 Amber（`launchctl kickstart -k gui/$(id -u)/<你的 Amber label>`）。登记服务是**部署方**的操作：agent 和指令都改不了这里，只能使用已经登记的服务。

## 4. 写指令脚本

[`command_script.py`](../examples/identity-service/command_script.py)：

```python
import json, sys, urllib.request

inp = json.load(sys.stdin)
svc = inp["services"]["demo-profile"]          # Amber 为本次执行签发的凭证和服务地址
req = urllib.request.Request(
    f"http://127.0.0.1:{svc['tcpPort']}/sales",
    headers={"Authorization": "Amber " + svc["token"]},
)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 本机服务，不走代理
try:
    with opener.open(req, timeout=10) as r:
        data = json.load(r)
except urllib.error.HTTPError as e:
    # 写到标准错误并以非 0 退出：Amber 把它当作执行失败，并把这句话显示给执行人
    sys.exit("服务拒绝了请求：" + json.loads(e.read().decode("utf-8")).get("error", str(e.code)))

rows = data["rows"]
if not rows:
    print("你没有任何区域的数据权限。")
    sys.exit(0)
print(f"**你能看到的区域**：{'、'.join(data['regions'])}\n")
print("```table")
print(json.dumps({"columns": [
    {"name": "region", "label": "区域", "type": "text"},
    {"name": "month", "label": "月份", "type": "text"},
    {"name": "amount", "label": "销售额", "type": "number"}], "rows": rows}, ensure_ascii=False))
print("```")
```

要点：

- 端口和凭证都从标准输入里的 `services` 读，**不要写死**。
- 只用标准库，因为沙盒里没有第三方库。
- 访问本机服务时要绕过代理（`ProxyHandler({})`）。

## 5. 提交、认领、审核

草稿 [`draft.json`](../examples/identity-service/draft.json) 的关键部分：

```json
{
  "name": "我的销售额",
  "description": "以执行人本人的身份，查询他有权限看的区域销售额（可信身份示例）",
  "params": [],
  "script": {
    "kind": "script", "lang": "python",
    "network": false,
    "services": ["demo-profile"],
    "timeoutMs": 15000,
    "code": "……command_script.py 的内容……"
  },
  "options": { "confirm": false, "schedulable": true }
}
```

- `services` 声明要用哪些已登记的服务。声明了服务就**不能**再设 `network: true`，提交时会被拒绝，这样查到的数据无法外传。
- 实际使用时，由 agent 填好 `chatId`、`chatType`、`claimer`，再运行 `amber submit draft.json --label <bot 名>`。

之后的流程和普通指令一样：

1. 认领人点「**试运行**」，Amber 以认领人的身份签发凭证，`channel` 是 `bot.trial`，服务据此知道这是试运行。服务方也可以选择拒绝试运行。
2. 认领人点「**提交审核**」。审核人在知识库文档里能看到这段代码，也能看到它声明了 `demo-profile`。
3. 所有审核人同意后，指令生效。

## 6. 执行

| 从哪里执行 | 凭证里的执行人 `sub` | `channel` |
|---|---|---|
| 飞书里点表单的「执行」 | 点按钮的人 | `bot` |
| 网站上点「执行」 | 登录的人 | `web` |
| 对 agent 说「跑一下我的销售额」 | 声明了服务的指令要用到某个人的身份，所以 agent **不能直接执行**，Amber 会发确认卡片，凭证签给**点卡片的人** | `agent` |
| 定时任务 | 定时任务的创建人 | `schedule` |

服务每处理一次请求都会打一行审计日志：

```text
2026-10-07 23:21:42 caller_source=amber sub=on_xxx cmd=… rev=… run=… channel=web rows=4
```

同一条指令，不同的人执行，看到的是各自有权限的区域。没有权限的人会看到「你没有任何区域的数据权限」。

## 7. 常见问题

| 现象 | 原因 |
|---|---|
| 执行失败：「服务拒绝了请求：这张凭证不是发给本服务的」 | Amber 配置里的 `audience` 和服务的 `DEMO_AUDIENCE` 不一致 |
| 执行失败：「服务拒绝了请求：凭证已经用过」 | 脚本用同一张凭证请求了两次。每次执行只签一张，每张只能用一次；需要多次请求时，服务方可以改成「同一次执行（`run`）内允许多次」 |
| 执行失败：「不认识的密钥」 | 服务启动时 Amber 还没起来，或者 Amber 换了签名密钥。重启服务即可，它会重新拉取公钥 |
| 执行失败：连接被拒绝或超时 | 服务没在运行，或者端口和 Amber 配置不一致。沙盒只放行配置里登记的那个端口 |
| agent 说要发确认卡片，不能直接执行 | 这是设计如此：凡是声明了服务的指令，都必须由本人点一下，见 [可信身份](identity.md#1-身份从哪来) |

本文的例子在 Amber 所在的机器上实测过：
- 有权限的人只拿到自己那两个区域的 4 行数据；
- 没有权限的人拿到 0 行；
- 同一张凭证第二次使用、发给别的服务的凭证，都被服务拒绝；
- 沙盒里的脚本连不上外网，也连不上没登记的本机端口。
