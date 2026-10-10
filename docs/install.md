# 安装与部署

Amber 是一个常驻服务，需要 macOS 和 Node.js 24 及以上版本。一个组织只部署一套，其他机器通过 HTTP 访问它。

> **这篇是部署 Amber 服务端的。** 如果组织里已经部署了 Amber，你只是想让自己的 agent 用上它，不需要看这篇，按 [amber 命令行与 skill](cli-and-skill.md) 在 agent 所在的机器上装客户端和 skill 即可。

## 1. 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | macOS。脚本沙盒依赖 `sandbox-exec` |
| Node.js | ≥ 24。直接运行 TypeScript（type stripping），存储用内置的 `node:sqlite` |
| Python | 用来运行应用脚本。默认是 Command Line Tools 自带的 `python3.9`，可以用环境变量 `AMBER_PYTHON` 换成别的路径 |
| 反向代理 | nginx 或其他均可，用来对外提供网站，并给接口加 IP 白名单 |
| 飞书应用 | 一个自建应用，配置方法见 [feishu-setup.md](feishu-setup.md) |

## 2. 获取代码

```sh
git clone https://github.com/xu4wang/amber.git ~/amber
cd ~/amber
npm ci               # 按 package-lock.json 安装，结果可复现；唯一的直接依赖是 @larksuiteoapi/node-sdk
git rev-parse HEAD   # 记下部署的是哪个提交
```

**连不上 GitHub 的机器**（比如只能访问 raw.githubusercontent.com）：在一台能访问的机器上打一个 git bundle 传过去，带完整历史，比打压缩包好核对：

```sh
# 能访问 GitHub 的机器上（本地 main 与 origin/main 一致时）
git bundle create amber.bundle main
shasum -a 256 amber.bundle; git rev-parse main main^{tree}
# 目标机器上
shasum -a 256 amber.bundle            # 对上面的哈希
git clone -b main amber.bundle ~/amber
cd ~/amber && git rev-parse HEAD HEAD^{tree}    # 对上面的 commit 和 tree
```

打包时要用本地分支名（`main`），不要用 `origin/main`：后者打出来的分支名是 `refs/remotes/origin/main`，`git clone -b main` 会找不到。如果目标机器能访问 raw.githubusercontent.com，再按同一个 commit 下载一个源码文件比对哈希，就能独立证明 bundle 和 GitHub 上的一致。

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
    "data-mcp": { "audience": "data-mcp", "tcpPort": 8765, "executor": true }
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
| `admins` | 管理员，填邮箱或 union_id。管理员可以把应用设为全局或改回本地、查看和下线任何应用、把创建人已离群的应用重新分配、管理任何定时任务（暂停、恢复、删除）、管理 Amber Store；**不能**执行别人的应用，也**不能**跳过审核。和审核人的区别见[管理员手册](admin.md) |
| `reviewers` | 审核人，填邮箱或 union_id。**所有人都同意**应用才生效（飞书会签审批）。只要有一个人查不到，Amber 就拒绝发起审核，不会悄悄少一个人 |
| `machines` | 允许访问接口的机器，格式是 IP → 机器名。机器名只记在审计日志里，不给用户看：用户只知道是自己的 agent 提交或发起的（卡片上显示 agent 的 `--label`） |
| `approval` | 飞书审批配置，取值方法见 [feishu-setup.md](feishu-setup.md#4-审批定义)。不配就退回到用卡片按钮审核 |
| `wiki` | 放审核文档的知识库位置。要和 `approval` 一起配置 |
| `services` | 脚本可以调用的本机服务，Amber 会为它们签发执行身份凭证，见 [identity.md](identity.md)。`"executor": true` 表示允许在执行端上运行的应用调用它：请求由执行端转给 Amber，Amber 核对后转给这个服务（见 [执行端](executor.md#调用-amber-上登记的服务)）；默认不允许 |
| `webBaseUrl` | **必填**。网站的外部地址，用来生成登录链接、做跨站请求检查，并通过 `/v1/info` 告诉 agent（不填只会是 localhost，登录链接在别的电脑上打不开） |
| `timezones` | 可选。定时任务可选的时区（IANA 名称加显示名），**第一个是默认时区**；网站下拉框、卡片上的时间说明都用它。不配就只用 Amber 服务器所在的时区，显示为「服务器时间」 |
| `dataDir` | 可选，数据目录，默认是 `~/.config/amber/data` |

### 3.3 签名密钥

第一次启动时，Amber 会自动生成 `~/.config/amber/signing-key.pem`（Ed25519，权限 0600），用来签发执行身份凭证。请把它和数据库一起备份；丢了以后，服务方需要重新获取公钥。

同时还会生成 `~/.config/amber/secrets-key`（权限 0600），用来加密应用密钥（数据库里只存密文）。**它和数据库要分开保管、一起备份**：丢了它，已保存的密钥都解不开，只能重新填写；它和数据库一起泄露，密钥就能被解开。

## 4. 启动

先在前台跑一次，确认配置没问题：

```sh
cd ~/amber && node --no-warnings src/main.ts
```

**进程起来不等于功能可用。** 以下几条都满足，才算启动成功：

| 检查 | 期望 |
|---|---|
| 启动标志 | 日志里依次出现 `long connection started`、`scheduler started`、`api listening on 127.0.0.1:7341`、`web listening on 127.0.0.1:7342` |
| 管理员解析 | `admins resolved N of M entries`，N 等于 M，M 是 `config.json` 里 `admins` 的条数 |
| 审核人解析 | `reviewers resolved N open_ids K`，N 和 K 都等于 `config.json` 里 `reviewers` 的条数，**并且至少为 1**。`0 open_ids 0` 不算通过：说明没配审核人，提交审核会报 `no_reviewers` |
| 不能出现 | `REVIEW DISABLED`（有审核人的邮箱查不到）、`admin email not resolved`（某个管理员邮箱查不到人）、`admin email lookup failed`（整批查询失败，通常是缺权限）、错误码 `99991672`（应用缺权限） |

四个启动标志都出现、但有下面这几行时，进程是活的，**审核和管理员功能却是关着的**，原因通常是缺 `contact:user.id:readonly` 权限或者没重新发布，见 [feishu-setup.md](feishu-setup.md#7-检查清单)。

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

装完后自检：

```sh
command -v node                                        # plist 里的 node 路径要和这里一致，版本 ≥ 24
plutil -lint ~/Library/LaunchAgents/com.example.amber.plist
launchctl print gui/$(id -u)/com.example.amber | grep -E 'state|pid|last exit'   # state = running
lsof -nP -iTCP:7341 -iTCP:7342 -sTCP:LISTEN            # 两个端口都在监听
```

## 5. 反向代理（nginx）

```nginx
server {
    listen 80;
    server_name amber.example.com;
    client_max_body_size 1m;

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
| 数据 | `~/.config/amber/data/amber.db`（SQLite）：应用、运行记录、审计、请求、定时任务、网站登录 |
| 备份 | 备份 `amber.db`、`signing-key.pem` 和 `secrets-key`（后者建议和数据库分开存放）。表结构升级时 Amber 会自动迁移，升级前建议手动复制一份数据库 |
| 更新代码 | `git pull`，然后 `launchctl kickstart -k …`。定时任务只在 Amber 运行时触发，停机期间错过的不会补跑 |
| 运维命令 | `node src/cli.ts list`（列出全部应用）、`node src/cli.ts retire <id>`（下线应用）。每次操作都写审计。`node src/cli.ts keys` 从现有私钥文件导出公钥给服务方固定用：只读，私钥不存在或权限对同组、其他用户开放时直接报错、不会生成新密钥，也不写审计，导出由部署记录连同 kid 一起留档 |
| 回归测试 | `npm test`：起一个隔离的 Amber（临时数据库 + 假飞书），覆盖认领、审核、新版本、下线、agent 三档、定时任务、网站、可信身份和沙盒，几秒跑完，不碰真实飞书和线上数据。改代码后先跑它 |
| 冒烟测试 | `npm run smoke`：在 Amber 所在机器上检查真实部署（接口、网站、前端库完整性）。在 `~/.config/amber/smoke.json` 写 `{"testChat": "oc_…"}`（一个拉了 Amber 的测试群）后，还会把每种卡片真实发到飞书验证格式，发完立即撤回 |
| 执行端 | 数据在别的机器上时，在那台机器装执行端，见 [executor.md](executor.md)。管理员私聊 Amber 发「执行端」查看状态 |
| 审计 | 数据库 `audit` 表，记录提交、认领、审核、执行、签发凭证、定时任务、登录等所有动作 |

## 8. 本机隔离测试部署（最小方案）

只想在自己机器上试用 Amber、不和别人共用时，可以按下面的最小方案部署。它和正式部署的区别是：**接口只给本机用、不需要 nginx、不接飞书审批和知识库**，审核改用卡片上的「通过 / 驳回」按钮。

1. **新建一个飞书应用**，不要复用已有 Amber 的应用（原因见 [feishu-setup.md](feishu-setup.md#1-创建应用) 的警告）。开启机器人能力，权限只需要第 2 节表里除「审批」「知识库」「文档」以外的几项，拿到 App ID 和 Secret，然后**先创建版本并发布一次**（权限要发布后才生效，否则第 5 步查不到管理员和审核人的邮箱）。**事件和回调这一步先不配**：保存长连接设置时飞书要求 Amber 已经在线，要等第 5 步启动以后再配，配完再发布一次。
2. 确认环境：`node -v` ≥ 24；7341、7342 两个端口没有被占用（`lsof -nP -iTCP:7341 -iTCP:7342 -sTCP:LISTEN` 没有输出）。
3. 按第 2 节拉代码、执行 `npm ci`。
4. 写配置，目录权限 700，两个文件权限 600：
   - `lark-app.env`：填新应用的 App ID 和 Secret；
   - `config.json`：
     ```json
     {
       "admins": ["你的邮箱"],
       "reviewers": ["你的邮箱"],
       "machines": { "127.0.0.1": "<本机名>" },
       "webBaseUrl": "http://127.0.0.1:7342"
     }
     ```
     `machines` 只放 `127.0.0.1`：只有本机的 agent 能调用接口，外部访问不到。
5. 前台启动，按第 4 节的表逐项确认（长连接这时已经在线）。
6. **保持 Amber 运行**，回到飞书开放平台按 [feishu-setup.md](feishu-setup.md#3-事件与回调) 第 3 节配事件和回调，确认「已订阅的回调」里有 `card.action.trigger`，然后创建版本并发布。发布生效后重启一次 Amber，再按第 4 节的表复核一遍日志。
7. 按第 4 节改成 launchd 常驻并做自检。
8. 本机的客户端指向这套：`amber config set-url http://127.0.0.1:7341`，`amber info` 显示的本机名应和 `machines` 里填的一致。
9. 冒烟：把新应用拉进一个测试群，**同时拉进要用它的 agent**，@它发「帮助」；再让 agent 提交一个没有副作用的草稿（比如只打印一行文字），走一遍认领 → 试运行 → 审核。
10. 重试前先在旧认领卡上点「丢弃」，避免留下多份草稿；测试应用不用了就下线（让 agent 执行 `amber retire <应用>`，再点确认卡）。

这套和组织里的正式 Amber 是**完全独立**的：应用、审核、定时任务、运行记录都不互通。
