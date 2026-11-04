# 外网网关（amber-gateway）

Amber 部署在公司内网里，它的接口只对白名单里的机器开放（按 IP 认机器，见[安装与部署](install.md)）。公司网络外的调用方——比如豆包工作里的 skill、外网服务器上的 agent——连不到它。

**外网网关**是装在一台外网服务器上的小服务，对外提供和 Amber **完全相同的接口路径**（`/v1/...`）。调用方带上网关发的令牌把请求发给网关；Amber 从内网**主动连出去**，把排队的请求取回来，像处理自己接口收到的请求一样处理，再把答复送回网关，网关交给调用方。公司网络不需要开放任何入站端口。

```
外网调用方 ──HTTPS + 令牌──▶ 网关（外网服务器） ◀──HTTPS，Amber 签名── Amber（内网）
                                 排队 / 回答              取请求 / 送答复
```

和[链接模式的执行端](executor.md#linux-与链接模式amber-主动连过来)用的是同一套连接方式（Amber 签名的长轮询，可固定证书）。

## 信任模型

| 谁 | 信任谁 | 凭什么 |
|---|---|---|
| 网关 | 调用方 | 每个调用方（客户端）一个令牌，请求头 `Authorization: Bearer <令牌>`。网关只存令牌的哈希 |
| 网关 | Amber | `init` 时记下 Amber 的签名公钥；取请求、送答复的每个请求都要有 Amber 为这个网关名签的名，过期或重放的拒绝 |
| Amber | 网关 | 只连自己配置里的地址（可固定证书）。网关在每个请求上注明是哪个客户端，Amber 认这个名字 |
| Amber | 调用方 | **不直接信任**。每个客户端能做什么由 Amber 管理员在配置里写明（见下面「Amber 这边的配置」），默认什么都不能代表 |

要点：

- **令牌不会到 Amber**。网关只把 `content-type` 头和请求正文转给 Amber，`Authorization`、Cookie、代理头都不转。
- **网关能看到经过它的请求和答复正文**（比如直接执行的应用的输出、应用列表）。所以网关所在的机器、以及做 HTTPS 终结的那一层（nginx、caddy，或者 CDN）**必须是可信的**。中间有 CDN 时它也能看到明文，可以让 Amber 用 `connectTo` + `tlsFingerprint` 绕开 CDN 直连网关。`amber read` 的结果是加密给调用方自己的一次性密钥的，网关看不到内容。
- 拿到网关签名公钥以外的东西都不能冒充 Amber：别人取不走排队的请求，也不能伪造答复。
- 拿到一个客户端令牌的人，能做的不超过这个客户端在 Amber 配置里被允许的范围；发现泄漏就 `token rm`，立即失效。
- 在 Amber 看来，经网关来的请求来自机器 `gw:<网关名>:<客户端名>`。审计日志、`/v1/info` 里都是这个名字；查请求状态、取 `amber read` 结果时，只能查到这个客户端自己发起的。

## 安装（Linux）

要求：Node 22 或更新版本，不需要安装依赖；一个外网能访问的 HTTPS 地址。网关不需要能访问 Amber。

```bash
# 1. 专门的系统用户；代码只要 client/amber-gateway 这个目录
useradd --system --create-home --shell /sbin/nologin amber-gw
mkdir -p /opt/amber-gateway && cp -r ~/amber/client/amber-gateway/* /opt/amber-gateway/
G="sudo -u amber-gw -H node /opt/amber-gateway/amber-gateway.mjs"

# 2. 初始化。Amber 的签名公钥：向 Amber 管理员要 <Amber 地址>/v1/keys 返回的 JSON，存成文件
#    --name 是这个网关在 Amber 配置 apiLinks 里的名字；--rate 是每个客户端每分钟最多几个请求（默认 60）
$G init --name doubao-gw --amber-key /tmp/amber-keys.json --listen 127.0.0.1:7360

# 3. 给每个调用方发一个令牌（只显示一次）
$G token add doubao-skill

# 4. 查看状态
$G status
```

配置在 `~/.config/amber-gateway/`（目录 700，`config.json` 600），审计日志是同一目录的 `audit.jsonl`。Amber 换了签名密钥时，网关会拒绝它的所有请求；确认是 Amber 自己换的之后，重新运行 `init … --repin`。

**常驻运行（systemd）**，`/etc/systemd/system/amber-gateway.service`：

```ini
[Unit]
Description=Amber gateway
After=network-online.target
Wants=network-online.target

[Service]
User=amber-gw
Environment=HOME=/home/amber-gw
ExecStart=/usr/bin/node /opt/amber-gateway/amber-gateway.mjs serve
Restart=always
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now amber-gateway
journalctl -u amber-gateway -f        # 日志：Amber 连上、出错
```

`serve` 默认只监听 `127.0.0.1:7360` 的明文 HTTP，可以用 `--host`、`--port` 改；**一定要在前面放 nginx 或 caddy 做 HTTPS**。

**nginx**：`/v1/` 给调用方，`/amber-link/` 给 Amber，`/healthz` 给监控。读超时要比最长的请求长（`amber wait` 会挂起最多 65 秒）：

```nginx
location ~ ^/(v1|amber-link)/ {
    proxy_pass http://127.0.0.1:7360;
    proxy_http_version 1.1;
    proxy_read_timeout 90s;
    proxy_buffering off;
    client_max_body_size 20m;
}
location = /healthz { proxy_pass http://127.0.0.1:7360; }
```

**caddy**（自动申请证书）：

```
amber-gw.example.com {
    reverse_proxy 127.0.0.1:7360 {
        transport http {
            read_timeout 90s
        }
    }
}
```

`<地址>/healthz` 返回 `{"ok": true, "service": "amber-gateway", "name": "…", "amberConnected": true}`：Amber 最近 60 秒内来取过请求就是 `true`。不含任何密钥或调用信息，可以给监控用。

## 令牌管理

```bash
$G token add <客户端名> [--rate <每分钟次数>]   # 新令牌，只显示一次；--rate 单独给这个客户端设上限
$G token list                                   # 客户端名和创建时间，不显示令牌
$G token rm <客户端名>                          # 立即失效，服务不用重启
```

- 客户端名：小写字母、数字、连字符，最长 32 个字符。它也是 Amber 配置里 `clients` 的键，两边要一致。
- 网关只保存令牌的 SHA-256，令牌丢了不能找回，只能 `rm` 再 `add`。
- 换令牌：`token rm` 再 `token add`，把新令牌交给调用方。

## Amber 这边的配置

管理员在 Amber 的 `config.json` 里加上，然后重启 Amber：

```json
"apiLinks": [
  {
    "name": "doubao-gw",
    "url": "https://amber-gw.example.com",
    "clients": {
      "doubao-skill": {
        "users": ["zhangsan@example.com"],
        "chats": ["oc_1234567890abcdef"]
      },
      "ops-bot": {
        "paths": ["/v1/info", "/v1/commands/list", "/v1/runs", "/v1/schedules/list"],
        "chats": ["oc_abcdef1234567890"]
      }
    }
  }
]
```

- `name` 必须和网关 `init --name` 一致：网关只接受 Amber 为这个名字签的请求。
- `url`、`connectTo`、`tlsFingerprint`、`parallel` 和 [`executorLinks`](executor.md#linux-与链接模式amber-主动连过来) 的含义相同。
- `clients`：网关上的每个客户端，在这里写明它能做什么。**没写在这里的客户端，网关就算认它的令牌，Amber 也一律拒绝。** 每个客户端三项，都可以不写：

| 设置 | 含义 | 不写时 |
|---|---|---|
| `paths` | 允许调用的接口路径，`:id` 表示任意一段（如 `/v1/schedules/:id/pause`） | 只能查看和执行：`/v1/info`、`/v1/keys`、`/v1/requests/:id`、`/v1/commands/list`、`/v1/commands/show`、`/v1/runs`、`/v1/reads`、`/v1/reads/fetch`。提交、下线应用，定时任务，触发器都要明确写上 |
| `users` | 允许在请求里代表的人（邮箱，不分大小写），即 `--user` / 草稿的 `claimer` | **不能代表任何人** |
| `chats` | 允许在请求里指定的会话（`chatId`，群或私聊的 `oc_…`） | **不能指定任何会话** |

**不管怎么配都不开放**：`/v1/secrets/*`（读取应用密钥）、`/v1/executor/*`（执行端有自己的链接模式）、`/v1/pages`（发布页面）。网关和 Amber 两边都会拒绝。

**为什么 `users`、`chats` 默认是「没有」**：内网机器可以在请求里写任何人、任何群，因为它们本来就在白名单里，而且 Amber 从不以 agent 自称的人的身份执行（要身份的操作都要那个人在飞书卡片上点）。但外网调用方如果能随便写一个群，就能列出那个群的应用、直接执行其中不需要身份的应用并拿到输出、往那个群里发确认卡片。所以外网调用方只能在管理员写明的会话里、以写明的人的名义发请求。几乎所有接口都要指定会话，所以一个客户端至少要配 `chats` 才有用；在群里使用可以不写 `users`（不指定人）；在私聊里使用（`chatType: p2p`，Amber 要求指明是谁）则要同时写上这个人和那个私聊会话的 `chatId`。

请求状态（`/v1/requests/:id`）和 `amber read` 的结果只对发起它的客户端可见：别的机器、别的客户端发起的请求，查起来和不存在一样（请求号会出现在群里的卡片上，知道请求号不代表是自己的）。

Amber 连上网关后日志里有 `api link doubao-gw connected`；断开时记录原因。每个经网关的请求在 Amber 的审计日志里记一条 `gateway.request`（网关、客户端、方法、路径、状态码，不含正文），网站审计页的分类是「外网网关」。

## 调用方怎么用

### amber 命令行

和内网一样的命令，只是地址换成网关、再加上令牌：

```bash
amber config set-url https://amber-gw.example.com
amber config set-token amg_xxxxxxxx…      # 或者环境变量 AMBER_TOKEN
amber info                                  # 本机名称显示为 gw:doubao-gw:doubao-skill
amber list --chat oc_1234567890abcdef --chat-type group
```

令牌只通过 `https` 发送（本机测试可以用 `http://127.0.0.1`）：地址是明文 http 时命令行直接报错，不会把令牌发出去。配置文件权限是 600。内网使用不需要令牌，不受影响。

### 直接调接口（比如豆包 skill）

请求格式和 Amber 的接口完全一样（见 [agent 接入](cli-and-skill.md)），加一个请求头：

```bash
TOKEN=amg_xxxxxxxx…
GW=https://amber-gw.example.com

# 这个会话里能用的应用
curl -sS "$GW/v1/commands/list" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"chatId": "oc_1234567890abcdef", "chatType": "group"}'

# 执行一个应用：不需要身份的直接返回结果；需要身份的会在群里发确认卡片，返回 requestId
curl -sS "$GW/v1/runs" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"chatId": "oc_1234567890abcdef", "chatType": "group", "user": "zhangsan@example.com", "command": "天气", "args": {"city": "上海"}}'

# 等确认卡片的结果（最多挂起 50 秒）
curl -sS "$GW/v1/requests/<requestId>?wait=30" -H "Authorization: Bearer $TOKEN"
```

`GET /v1/keys`（Amber 的签名公钥，服务方验证执行身份凭证用）不需要令牌，由网关直接用 `init` 时记下的公钥回答。

### 错误

| 状态码 | 原因 |
|---|---|
| 401 | 没带令牌、令牌不对或已删除 |
| 403 | Amber 不允许这个客户端这样做（接口、人、会话不在配置里，或者是不开放的接口），`message` 里说明了缺什么 |
| 404 | 不是 Amber 的接口 |
| 413 | 请求正文超过 1MB（Amber 自己对一般接口的上限是 256KB） |
| 429 | 超过这个客户端每分钟的请求数，稍后再试 |
| 503 | 网关排队的请求太多 |
| 504 | Amber 没有连上网关，或者没在时限内答复（一般 60 秒；`?wait=` 的请求是等待时间加 15 秒） |

## 审计

网关的 `audit.jsonl` 每个外部请求一行：

```json
{"time": "2026-11-04T08:00:00.000Z", "client": "doubao-skill", "method": "GET", "path": "/v1/requests/…?wait=30", "status": 200, "ms": 31012}
```

只记时间、客户端（令牌不对时是 `null`）、方法、路径（查询参数只保留名字，`wait` 保留值）、状态码和耗时。**从不记录请求正文、令牌或答复内容。** 文件只追加不轮转，需要时用 logrotate 等外部工具处理。

## 限制与已知缺口

- **不开放**：读取密钥、执行端、发布页面（见上）。
- **卡片上的 agent 名字**：调用方可以像内网 agent 一样用 `label` 给自己起名，确认卡片上显示这个名字，卡片不会标出请求来自外网。审计日志里的机器名 `gw:…` 是可信的，名字不是。
- **一个网关对应一个 Amber**。每个网关可以有多个客户端；多个网关就在 `apiLinks` 里写多项。
- 限流计数、排队的请求都在网关内存里：网关重启后限流重新计数，正在等待的请求会失败（调用方重试即可，Amber 那边已经开始执行的照常完成）。
- 令牌错误的请求不限流（令牌是 256 位随机数，猜不到）；需要的话在 nginx 前面加限流。
- 改 `apiLinks` 要重启 Amber。网关这边：删令牌、改单个客户端的上限（`config.json` 里 `clients.<名字>.rate`）立即生效；`init --rate` 改的默认上限要重启网关才生效。
- 网关状态目前只在日志里（`api link … connected / down`）和网关的 `/healthz`，管理员页面上还没有显示。
