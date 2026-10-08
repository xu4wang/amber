# 安装与部署

Amber 是一个常驻服务，需要 macOS 和 Node.js 24 及以上版本。一个组织只部署一套，其他机器通过 HTTP 访问它。

## 1. 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | macOS。脚本沙盒依赖 `sandbox-exec` |
| Node.js | ≥ 24。直接运行 TypeScript（type stripping），存储用内置的 `node:sqlite` |
| Python | 用来运行指令脚本。默认是 Command Line Tools 自带的 `python3.9`，可以用环境变量 `AMBER_PYTHON` 换成别的路径 |
| 反向代理 | nginx 或其他均可，用来对外提供网站，并给接口加 IP 白名单 |
| 飞书应用 | 一个自建应用，配置方法见 [feishu-setup.md](feishu-setup.md) |

## 2. 获取代码

```sh
git clone https://github.com/xu4wang/amber.git ~/amber
cd ~/amber
npm install          # 唯一的依赖是 @larksuiteoapi/node-sdk
```

## 3. 配置

所有配置放在 `~/.config/amber/`，可以用 `AMBER_CONFIG_DIR` 改到别的目录。仓库里不包含任何凭证。

```sh
mkdir -p ~/.config/amber && chmod 700 ~/.config/amber
```

### 3.1 `lark-app.env`：飞书应用凭证（权限设为 0600）

```sh
AMBER_LARK_APP_ID=cli_xxxxxxxxxxxx
AMBER_LARK_APP_SECRET=xxxxxxxxxxxxxxxx
```

### 3.2 `config.json`

```json
{
  "admins": ["admin@example.com"],
  "reviewers": ["admin@example.com", "reviewer@example.com"],
  "machines": {
    "127.0.0.1": "local",
    "192.168.1.10": "dev-a",
    "192.168.1.11": "dev-b"
  },
  "approval": {
    "code": "审批定义的 approval_code",
    "reviewNodeId": "审核节点的 node_id",
    "formFieldId": "表单里多行文本控件的 id"
  },
  "wiki": {
    "spaceId": "知识库空间 id",
    "parentNodeToken": "放审核文档的父节点 token",
    "baseUrl": "https://<你的租户>.feishu.cn/wiki/"
  },
  "services": {
    "data-mcp": { "audience": "data-mcp", "tcpPort": 8765 }
  },
  "webBaseUrl": "http://amber.example.com",
  "timezones": [
    { "tz": "Asia/Shanghai", "label": "北京时间" },
    { "tz": "Asia/Bangkok", "label": "曼谷时间" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `admins` | 管理员，填邮箱或 union_id。管理员可以把指令设为全局或改回本地 |
| `reviewers` | 审核人邮箱。**所有人都同意**指令才生效。只要有一个邮箱查不到，Amber 就拒绝发起审核，不会悄悄少一个人 |
| `machines` | 允许访问接口的机器，格式是 IP → 机器名。机器名只记在审计日志里，不给用户看：用户只知道是自己的 agent 提交或发起的（卡片上显示 agent 的 `--label`） |
| `approval` | 飞书审批配置，取值方法见 [feishu-setup.md](feishu-setup.md#4-审批定义)。不配就退回到用卡片按钮审核 |
| `wiki` | 放审核文档的知识库位置。要和 `approval` 一起配置 |
| `services` | 脚本可以调用的本机服务，Amber 会为它们签发执行身份凭证，见 [identity.md](identity.md) |
| `webBaseUrl` | **必填**。网站的外部地址，用来生成登录链接、做跨站请求检查，并通过 `/v1/info` 告诉 agent（不填只会是 localhost，登录链接在别的电脑上打不开） |
| `timezones` | 可选。定时任务可选的时区（IANA 名称加显示名），**第一个是默认时区**；网站下拉框、卡片上的时间说明都用它。不配就只用 Amber 服务器所在的时区，显示为「服务器时间」 |
| `dataDir` | 可选，数据目录，默认是 `~/.config/amber/data` |

### 3.3 签名密钥

第一次启动时，Amber 会自动生成 `~/.config/amber/signing-key.pem`（Ed25519，权限 0600），用来签发执行身份凭证。请把它和数据库一起备份；丢了以后，服务方需要重新获取公钥。

## 4. 启动

先在前台跑一次，确认配置没问题：

```sh
cd ~/amber && node --no-warnings src/main.ts
```

日志里依次出现 `long connection started`、`scheduler started`、`api listening on 127.0.0.1:7341`、`web listening on 127.0.0.1:7342`，就说明启动成功。

| 端口 | 用途 | 绑定地址 |
|---|---|---|
| 7341（`AMBER_API_PORT`） | 给 agent 用的接口 `/v1/…`，另有公钥 `/v1/keys` | 127.0.0.1 |
| 7342（`AMBER_WEB_PORT`） | 网站 | 127.0.0.1 |

两个端口都只监听本机，对外由反向代理转发。

### 常驻运行（launchd）

`~/Library/LaunchAgents/com.example.amber.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.amber</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>--no-warnings</string>
    <string>src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/amber</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>/Users/you</string>
    <!-- 如果机器上网要走代理，在这里加 http_proxy / https_proxy -->
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/you/.config/amber/data/amber.log</string>
  <key>StandardErrorPath</key><string>/Users/you/.config/amber/data/amber.log</string>
</dict>
</plist>
```

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.amber.plist   # 加载并启动
launchctl kickstart -k gui/$(id -u)/com.example.amber                              # 重启（更新代码后）
launchctl bootout gui/$(id -u)/com.example.amber                                   # 停止并卸载
```

## 5. 反向代理（nginx）

```nginx
server {
    listen 80;
    server_name amber.example.com;
    client_max_body_size 512k;

    # 给 agent 用的接口：只放行 config.json 里 machines 列出的 IP
    location /v1/ {
        allow 127.0.0.1;
        allow 192.168.1.10;
        allow 192.168.1.11;
        deny all;
        proxy_pass http://127.0.0.1:7341;
        proxy_set_header X-Amber-Client-IP $remote_addr;   # Amber 根据它识别是哪台机器
        proxy_set_header Host $host;
        proxy_read_timeout 150s;                            # 脚本最长可以跑 120 秒
    }

    # 网站
    location / {
        proxy_pass http://127.0.0.1:7342;
        proxy_set_header X-Amber-Client-IP $remote_addr;
        proxy_set_header Host $host;
        proxy_read_timeout 150s;
    }

    # 前端库可以由 nginx 直接提供（Amber 自己也能提供，这里只是少走一层）
    location ~ ^/vendor/([a-z.-]+\.js)$ {
        alias /Users/you/amber/web/vendor/$1;
        types { text/javascript js; }
        add_header Cache-Control "max-age=86400" always;
    }
}
```

注意：

- nginx 的 `allow` 列表和 `config.json` 的 `machines` 要保持一致。Amber 只认 `X-Amber-Client-IP`，对不上的 IP 一律返回 403。
- **确认 nginx 的 `proxy_temp` 目录可写。** 不可写时，响应稍大、客户端又慢的情况下会被截断，日志里出现 `proxy_temp … Permission denied`。表现是网页上图表报 `Cannot read properties of undefined (reading 'isString')`，原因是 vega.min.js 只下载了一部分。修复办法：修正那个目录的属主，或者在上面两个 `location` 里加 `proxy_max_temp_file_size 0;`。
- `/v1/keys`（公钥）不需要放行给外部，服务方在本机读取即可。
- 网站登录用的是 cookie。如果站点要开放到内网以外，**必须先上 HTTPS**。

## 6. 让 agent 用起来

在每台跑 agent 的机器上安装 `amber` 命令行和 skill，见 [cli-and-skill.md](cli-and-skill.md#安装)。装好后在每台机器上运行一次 `amber config set-url http://<你们的 Amber 地址>`，再用 `amber info` 检查。

## 7. 运维

| 事项 | 做法 |
|---|---|
| 日志 | `~/.config/amber/data/amber.log` |
| 数据 | `~/.config/amber/data/amber.db`（SQLite）：指令、运行记录、审计、请求、定时任务、网站登录 |
| 备份 | 备份 `amber.db` 和 `signing-key.pem`。表结构升级时 Amber 会自动迁移，升级前建议手动复制一份数据库 |
| 更新代码 | `git pull`，然后 `launchctl kickstart -k …`。定时任务只在 Amber 运行时触发，停机期间错过的不会补跑 |
| 运维命令 | `node src/cli.ts list`（列出全部指令）、`node src/cli.ts retire <id>`（下线指令）。每次操作都写审计 |
| 回归测试 | `npm test`：起一个隔离的 Amber（临时数据库 + 假飞书），覆盖认领、审核、新版本、下线、agent 三档、定时任务、网站、可信身份和沙盒，几秒跑完，不碰真实飞书和线上数据。改代码后先跑它 |
| 冒烟测试 | `npm run smoke`：在 Amber 所在机器上检查真实部署（接口、网站、前端库完整性）。在 `~/.config/amber/smoke.json` 写 `{"testChat": "oc_…"}`（一个拉了 Amber 的测试群）后，还会把每种卡片真实发到飞书验证格式，发完立即撤回 |
| 审计 | 数据库 `audit` 表，记录提交、认领、审核、执行、签发凭证、定时任务、登录等所有动作 |
