# 脚本约定

应用的脚本一般由 agent 写。这一页说明脚本和 Amber 之间的约定：输入从哪来、输出怎么写、在什么环境里跑。agent 用的版本在 [skills/amber/SKILL.md](../skills/amber/SKILL.md#把跑通的操作提交成新应用)，内容一致。

## 输入

脚本从**标准输入**读一个 JSON：

```json
{
  "params": {"city": "北京", "repo": "group/project"},
  "caller": {"unionId": "on_…", "chatId": "oc_…", "channel": "bot|web|agent|schedule|page", "city": "北京"},
  "runId": "…",
  "services": {"data-mcp": {"tokens": ["…", "…"], "tcpPort": 53127}},
  "secrets": {"API_TOKEN": "…"},
  "larkUser": {"accessToken": "u-…", "appId": "cli_…", "expiresAt": 1791400000000, "env": {"LARKSUITE_CLI_USER_ACCESS_TOKEN": "u-…", "LARKSUITE_CLI_APP_ID": "cli_…"}, "cli": "/…/lark-cli"}
}
```

| 字段 | 说明 |
|---|---|
| `params` | 参数和配置项的值都在这里，脚本不用区分。不要从命令行或环境变量读参数 |
| `caller` | 执行人：`channel` 是入口（`bot` 飞书、`web` 网站、`agent`、`schedule` 定时任务、`page` [页面应用](pages.md)），`city` 是执行人的办公城市（有的话） |
| `runId` | 本次运行的 id |
| `services` | 只有声明了服务时才有，见下面「调用数据服务」 |
| `secrets` | 只有声明了密钥时才有，见下面「密钥」 |
| `larkUser` | 只有声明了 `"larkUser": true` 时才有，见下面「以执行人的飞书身份运行」 |

## 输出

往**标准输出**打印 Markdown，最多 256KB。除了普通 Markdown 和表格，还支持：

- **图表**：` ```vega-lite ` 代码块。柱状图、折线图、饼图（`mark: arc`，theta 为数值、color 为类别）会转成飞书原生图表；其他图只在网站上显示。
- **数据表**：` ```table ` 代码块，内容是 `{"columns":[{"name","label","type":"text|number"}],"rows":[…],"total":N}`。卡片里每张表最多 100 行，完整内容在网站上看。
- **给页面的数据**：` ```json ` 代码块。飞书卡片和网站上不显示，[页面应用](pages.md)调用这个应用时，拿到的 `json` 就是它解析后的内容。适合页面要的结构比表格复杂的时候，只给飞书用的应用不需要
- **@ 人或机器人**：正文里写 `@` 加对方在群里的显示名，名字后面空一格或接标点，比如 `有更新，@同步机器人 请拉最新代码`。规则见[主要场景](scenarios.md#5-把结果交给群里的机器人或同事)。

**没有输出就不发消息**。监控类的应用正常时什么都不打印，异常时才输出。

## 运行环境（沙箱）

每次执行都在沙箱里：

| 项目 | 默认 |
|---|---|
| 当前目录 | 本次运行的临时目录，也是 `HOME` 和 `TMPDIR`，结束后删除 |
| 可读 | 系统目录和常见语言工具链（Homebrew、nvm、pyenv 等），外部命令能用；`$HOME` 下的其他文件不可见 |
| 网络 | 不能直连。经代理可以访问网络白名单：管理员设置的「所有环境」名单（初始是飞书），加上执行端环境的 `allowHosts` 或 Amber 本机的额外名单，脚本拿到的 `HTTPS_PROXY` 已经设好，lark-cli、curl、Python 都会自动用。要直连任何地址才写 `"network": true`，审核时会重点看 |
| Python | 系统 Python 3.9，只有标准库 |
| 时限 | 不写 `timeoutMs` 时用管理员设的默认时限（初始 60 秒）；可以写 `timeoutMs`（毫秒），最多到管理员设的最长时限（初始 10 分钟），超过的提交时就会被拒绝 |
| 大小 | 代码最多 64KB，输出最多 256KB |

### 用第三方包

在 `script` 里写 `"interpreter": "/opt/homebrew/bin/python3"`，或某个虚拟环境里的 python（绝对路径），这个解释器装好的包都能用。在执行端上运行时，一般用运行环境里配好的 Python，不用写。

### 访问数据（运行环境）

脚本不写任何路径声明，而是在 `script` 里写 `"env": "执行端名/环境名"`，选一个已批准的运行环境，能访问的就是那个环境的权限。代码里用 `os.environ["WORKDIR"]` 或绝对路径访问（当前目录仍是临时目录）。

- 从 botmux 机器人导出的环境，和那个机器人在自己沙箱里能访问的一样，lark-cli 用的也是它的飞书身份。
- agent 用 `amber envs --mine` 找属于自己的环境（来源是 `botmux:<自己的 appId>`）；`amber envs` 列出全部已批准的环境。
- 不写 `env` 的应用在 Amber 本机运行，看不到任何业务数据。
- 写了 `env` 的应用不能上架、不能设为全局。

详见[执行端与运行环境](executor.md)和[运行环境定义格式](environment-format.md)。

## 调用数据服务（data-mcp）

> data-mcp 是企业内部的数仓应用，Amber 把它作为可信服务访问：每次调用都带执行人的身份凭证，数仓按执行人的权限返回数据（服务方的做法见[可信身份](identity.md#36-已接入的服务data-mcp)）。

在 `script` 里声明 `"services": {"data-mcp": {"calls": 1}}`（每次执行最多调用几次，1–20）。运行时输入里会有这么多张凭证，**每次请求用一张，不能重复用**。一次查询只要一张。

```text
POST http://127.0.0.1:<tcpPort>/amber/query
Authorization: Amber <token>
Content-Type: application/json

{"sql": "…", "datasource": "tchouse-c"}
```

- `tokens` 里是调用票据：每次请求放一张在 `Authorization` 头里，Amber 转发时换成当场签发的凭证。
- 端口取输入里的 `tcpPort`，不要写死：它是这次运行专用的转发端口，每次都不一样，服务自己的端口脚本连不上。请求不要走代理。在执行端上运行的应用写法完全一样。
- 请求体只能有 `sql` 和 `datasource`（可省略），多带任何字段返回 422。
- 返回 200 时看 `status`：`success` 才算成功，数据在 `rows`（以列名为键的对象数组）、`columns`、`row_count`、`truncated`；`validation_error` 等失败也是 200，原因在 `error_code` 或 `issues[].code`。
- 401 是凭证无效，409 是凭证已用过，429 是定时执行限流。
- 试运行时每次查询最多返回 20 行（认领卡上会提示），试运行的数字可能不全；正式执行时上限是 1000 行。SQL 没写 `LIMIT` 时，服务会自动加 `LIMIT 200`。
- `truncated` 为 true 时在输出里说明。**注意**：目前被服务自己加的 `LIMIT`（试运行的 20、默认的 200）截断时，`truncated` 不会是 true（data-mcp 的已知问题，已反馈）。需要完整结果时，SQL 里自己写 `LIMIT`（不超过 1000），返回行数等于这个数就当作可能被截断处理。
- 声明了数据服务的应用不能直连网络（不能写 `network: true`）；经代理访问白名单地址不受影响。

服务方怎么验证凭证见[可信身份](identity.md#36-已接入的服务data-mcp)。

## 交给大模型处理（llm）

要总结、改写、分类一段文字时，声明 `"services": {"llm": {"calls": 3}}`（每次执行最多几次，1–20）。脚本把文字和要求交给 Amber，Amber 以自己的身份运行大模型，把结果文字还给脚本。脚本拿不到大模型的凭证，也连不到大模型的服务器。

```text
POST http://127.0.0.1:<tcpPort>/complete
Authorization: Amber <token>
Content-Type: application/json

{"prompt": "要处理的文字和要求", "system": "可选：角色和输出格式", "model": "可选：sonnet / haiku / opus", "persist": false}
```

- 返回 200 时结果在 `text`，另有 `model`、`elapsedMs`、`persist`，保存了会话时还有 `sessionId`。失败时看 `error` 和 `message`：
  - 400：参数不对，或模型不在允许的列表里
  - 413：太长
  - 502：大模型出错
  - 504：超时，默认 4 分钟
  - 403：调用次数已用完，或凭证不对
- 和调用数据服务一样：`tcpPort` 和 `tokens` 从输入的 `services.llm` 里取，每次请求用一张票据；请求不要走代理。
- 一次最多约 15 万字。内容多时分批处理，比如每个群先总结一段，再把各段汇总，最后一步要单独留出一次调用。
- 大模型**没有任何工具**：读不了文件、上不了网、执行不了命令，只是把文字变成文字。
- **会话记录**：默认不保存。传 `"persist": true` 时和平常使用 Claude 一样保存会话记录（在 Amber 服务器上，管理员给大模型服务配的 Claude 目录里），返回的 `sessionId` 可以用来查找。审计会标出哪些调用保存了会话。处理别人的消息、敏感数据时不要保存。
- 交给它的文字会发给大模型服务商。审核文档会标明这一点。
- 管理员在 Amber 配置里开启这个服务（`llm`），没开启时声明 llm 会提交失败。
- 在执行端上运行的应用也能用，需要执行端是新版本；旧版执行端转发时只等 75 秒。

## 密钥

在 `script` 里写 `"secrets": ["API_TOKEN"]`，只写名字（大写字母、数字、下划线，最多 10 个），脚本从输入的 `secrets` 里取值。值由创建人在私聊卡片或网站上填写，不进代码、不进草稿，agent 也拿不到（除非创建人每次在确认卡上允许 `amber secret get` 读取，见[agent 接入](cli-and-skill.md#读取密钥)）。不要打印密钥，打印出来也会被遮成 `***`。用到密钥的应用总要人点确认卡才能执行。

默认所有声明的密钥都设置了才能执行。像「密钥保管箱」这种只是用来存放、可能只填一部分的应用，再写 `"secretsOptional": true`：一个都没填也能执行，脚本只拿到已经设置的那些。

## 以执行人的飞书身份运行

在 `script` 里写 `"larkUser": true`，脚本每次执行都会从输入的 `larkUser` 里拿到**执行人本人**的飞书用户令牌（`user_access_token`），有效期覆盖整次运行。用它调用什么由脚本自己决定，Amber 不限制动作。最常见的用法是把 `env` 合进环境变量，再用 `cli`（这台机器上 lark-cli 的完整路径，沙箱的 PATH 里不一定有它）调 lark-cli：

```python
import json, os, subprocess, sys
inp = json.load(sys.stdin)
env = {**os.environ, **inp["larkUser"]["env"]}
r = subprocess.run([inp["larkUser"]["cli"], "minutes", "+search", "--query", "前采", "--as", "user"], env=env, capture_output=True, text=True, timeout=120)
print(r.stdout)
```

- 执行人要先授权一次：私聊 Amber 发「授权飞书」，或在网站上打开这个应用、点「授权飞书」，用自己的飞书账号点确认。没授权或授权失效时，执行会被拒绝，并提示去授权。
- 执行人就是这次运行的人（见[可信身份](identity.md)第 1 节），定时任务以创建人的身份执行。agent 入口不代表任何人，不能执行这类应用。
- Amber 的飞书应用后来新开通的权限，要等执行人重新授权才对他生效。这种情况下照常执行，输入的 `larkUser.missingScopes` 会列出他的授权里还缺的权限（没有缺就不出现这个字段），Amber 也会私聊提醒他重新授权（每天最多一次）。调用失败时请在输出里写明「请重新授权飞书」，比如样例「我的飞书数据」。
- 网络只能到飞书（`*.feishu.cn` 等），不能和 `"network": true` 一起用。目前只能在 Amber 本机运行，不能和 `env` 一起用。
- 令牌不要打印，打印出来也会被遮成 `***`。不要把它写进文件或发到别处：审核时会逐条看脚本以执行人的身份做了什么。
- 想让 agent 拿到结果接着处理（比如读用户的邮件再总结），在 `script` 里再写 `"toAgent": true`：agent 用 `amber read` 发起，执行人在私聊卡片上允许后以他的身份执行，输出加密交给那个 agent。这类应用要只读，见[读取个人数据](cli-and-skill.md#读取个人数据)。

## 草稿格式

```json
{
  "chatId": "oc_…", "chatType": "group", "claimer": "user@example.com",
  "name": "注册商户数", "description": "统计近 N 天每天新注册的商户数",
  "params": [
    {"name": "days", "label": "天数", "type": "integer", "default": "7", "min": 1, "max": 90},
    {"name": "repo", "label": "仓库", "type": "string", "scope": "config"}
  ],
  "script": {"kind": "script", "lang": "python", "network": false, "timeoutMs": 60000, "code": "…"},
  "options": {"confirm": false, "schedulable": true}
}
```

| 字段 | 说明 |
|---|---|
| `chatType` | `group` 或 `p2p`；私聊必须带 `claimer`，群里也建议带（同名应用靠它判断是谁的新版本） |
| `originMessageId`、`inThread` | 想让认领卡出现在当前话题里时加 |
| 参数类型 | `string`（可加 `maxLength`、`pattern`）或 `integer`（可加 `min`、`max`）；`"defaultFrom": "caller.city"` 表示不填时用执行人的办公城市 |
| `"scope": "config"` | 配置项：值由创建人在网站上设置，执行人传不进来；不能用 `defaultFrom`，不要放机密 |
| `script.kind` | 只能是 `script`；不要写 `sandbox` 字段（会被拒绝） |
| `script.env`、`script.interpreter`、`script.secrets`、`script.network`、`script.services`、`script.larkUser`、`script.toAgent` | 见上文 |
| `options.confirm` | 执行前必须确认，会改数据、有风险时打开 |
| `options.schedulable` | 允许定时执行，不写时默认 `true` |

用同一个名字、在同一个群（或私聊）提交，就是已有应用的新版本。同名的上一版还停在认领卡上、没提交审核时，私聊草稿重新提交会替换它（只限同一个认领人）；群里的草稿和审核中的版本不会被替换，要先丢弃或等审核结束。提交用 `amber submit draft.json --label <bot 名>`，见[agent 接入](cli-and-skill.md)。
