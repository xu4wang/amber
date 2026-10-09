---
name: amber
description: 使用 Amber 固化指令：查看和执行本会话可用的指令、创建/管理定时任务、把跑通的操作提交成新指令。用户提到 Amber、固化指令、「每天 X 点跑一下」、「把刚才这个存下来」时使用。
---

# Amber

Amber 保存经过审核的确定性指令（参数 + 一段脚本）。用户跟你说话，你用 `amber` 命令行替他调用 Amber，用户基本不用直接跟 Amber 打交道。

## 先记住一条

Amber 的接口**分不清你背后是谁**（只按机器 IP 放行）。所以凡是要以某个人的身份做的事，Amber 都会在飞书里发一张确认卡片，**谁点了就以谁的身份执行**。你要做的是：

1. 发起请求；
2. 告诉用户「请在卡片上点一下」；
3. 用 `amber wait <request>` 确认完成。**执行结果只显示在飞书卡片上，你拿不到**（这是以点卡片的人的身份查出来的数据）；告诉用户「结果在卡片上」，不要猜测或编造结果。

不要替用户点卡片，也不要让用户把卡片转给别人。

## 网站

用户想在网页上查看、执行指令或管理定时任务时：用 `amber info` 查到网站地址告诉他，让他在飞书私聊 Amber 发送「登录」，点卡片上的按钮。登录链接只发在他自己的私聊里，你不要代为转发。

## 会话参数

在 botmux 会话里，`amber` 会自动读取 `$BOTMUX_CHAT_ID`、`$BOTMUX_CHAT_TYPE` 和 `$BOTMUX_ROOT_MESSAGE_ID`（话题里的卡片会发进同一个话题）。另外：

- **总是带上 `--user <当前说话人的邮箱>`**（取自消息的 sender email）。这样只有他能点卡片；私聊里必须带。
- **总是带上 `--label <你的 bot 名>`**（或设置 `AMBER_LABEL`），用用户认识的名字。卡片上只显示这个名字，不显示机器，用户只需要知道是哪个 agent 帮他提交或发起的。

## 常用命令

```sh
amber list --user user@example.com                     # 这里能用的指令
amber show 天气 --user user@example.com                # 参数，以及 run 会直接执行还是要确认
amber run 天气 city=上海 --user user@example.com       # 执行
amber wait <request>                              # 等确认卡片的结果（默认最多 10 分钟）
amber schedule add 天气 --at "工作日 09:00" city=上海 --user user@example.com
amber schedule list
amber schedule pause <id>                         # 立即暂停
amber schedule resume <id> / delete <id>          # 要创建人在卡片上确认
amber retire 天气 --user user@example.com          # 下线指令：创建人或管理员在卡片上确认
amber global 天气 --user user@example.com          # 设为全局 / amber local 天气 取消全局：管理员在卡片上确认
```

退出码：0 完成，1 出错，2 用法错误，3 还在等人点卡片。

`amber run` 的两种结果：

- **直接执行**（指令不需要任何人的身份，也没开 confirm）：结果的 Markdown 直接打印出来，你整理后回复用户即可。执行身份记为「agent@机器」。
- **确认卡片**：打印 `request: <id>`。先告诉用户去点卡片，然后运行 `amber wait <id>`：它只告诉你完成、取消、过期还是失败，**不返回结果内容**，结果在卡片上（完整内容在网站）。不要编造结果；用户要就结果继续分析，请他把需要的数字告诉你。

## 下线指令、设为全局

用户说「下线指令 xxx」「把 xxx 设为全局 / 取消全局」时，直接替他调用，不要让他去找 Amber：

- `amber retire <指令> --user <邮箱>`：Amber 发确认卡，**指令创建人或管理员**点「确认下线」才生效。下线不需要审核、不能撤销，它的定时任务会暂停并通知创建人。
- `amber global <指令> --user <邮箱>` / `amber local <指令> --user <邮箱>`：只有**管理员**能确认。
- 带了 `--user` 而这个人没有权限时，Amber 当场拒绝、不发卡片，把原因告诉用户即可。
- 发出后同样用 `amber wait <request>` 确认是否完成。

用户想**登录网站**时，让他自己私聊 Amber 发「登录」，这一步不能代办（登录链接只发在他的私聊里）。

## 定时任务

- 只有审核时打开了 `schedulable` 的指令能定时；不行时 `amber schedule add` 会直接告诉你。
- 时间写法：`每天 09:00`、`工作日 09:00`、`每周一 09:00`、`每小时`、`每 2 小时`、`每 2 小时 15 分`、`每 5 分钟`（分钟间隔只能是 5、10、15、20、30，最短 5 分钟）。不加 `--tz` 时用 Amber 服务器配置的默认时区；需要别的时区就加 `--tz <IANA 时区名>`，比如用户在曼谷用 `--tz Asia/Bangkok`。确认卡片上会写明时区，用户能核对。
- 用户点「创建定时任务」后才生效，之后每次都以他的身份自动执行，结果发到原来的群、话题或私聊。
- **脚本没有输出时不发消息**。监控类需求（「有异常就提醒我」）就写成：正常时什么都不打印，异常时才输出。
- 运行失败只私聊通知创建人；连续失败 3 次自动暂停。指令下线或换了新版本，定时任务也会自动暂停。

## 把跑通的操作提交成新指令

当用户说「把刚才这个存进 Amber，叫 xxx」时：

### 1. 写脚本

- **输入**：从标准输入读一个 JSON：
  ```json
  {"params": {"city": "北京"}, "caller": {"unionId": "on_…", "chatId": "oc_…", "channel": "bot|agent|schedule", "city": "北京"}, "runId": "…",
   "services": {"data-mcp": {"tokens": ["…", "…"], "tcpPort": 8765}},
   "secrets": {"API_TOKEN": "…"}}
  ```
  `services` 只有声明了服务时才有。草稿里写 `"services": {"data-mcp": {"calls": 2}}`（每次执行最多调用几次，1–20），运行时就拿到 2 张凭证，**每次请求用一张、不能重复用**。参数一律从这里取，不要从命令行或环境变量读。`secrets` 只有声明了密钥时才有，见下面「需要 token、密码时」。
- **调用 data-mcp 查数**：一次查询只要一张凭证（服务端在一次请求里先校验再执行），声明 `{"calls": 1}` 即可。
  `POST http://127.0.0.1:<tcpPort>/amber/query`，头 `Authorization: Amber <token>`、`Content-Type: application/json`，
  请求体只能是 `{"sql": "…", "datasource": "tchouse-c"}`（`datasource` 可省略，多带任何字段返回 422）。端口取输入里的 `tcpPort`，不要写死；请求不要走代理。
  返回 200 时看 `status`：`success` 才算成功，数据在 `rows`（以列名为键的对象数组）、`columns`、`row_count`、`truncated`；
  `validation_error` 等失败也是 200，原因在 `error_code` 或 `issues[].code`。401 = 凭证无效，409 = 凭证已用过，429 = 定时执行限流。
  试运行最多返回 20 行，`truncated` 为 true 时要在输出里说明。完整说明见文档「可信身份」的「已接入的服务：data-mcp」一节。
- **输出**：往标准输出打印 Markdown。可以用普通 Markdown 和表格，以及：
  - ` ```vega-lite `：图表（柱状图、折线图、饼图（mark: arc，theta=数值、color=类别）会转成飞书原生图表；其他图只在网站上显示）
  - ` ```table `：数据表，`{"columns":[{"name","label","type":"text|number"}],"rows":[…],"total":N}`
- **运行环境**（沙盒）：当前目录是本次运行的临时目录（也是 `HOME`、`TMPDIR`，结束后删除）；系统目录和常见语言工具链（Homebrew、nvm、pyenv 等）可读，外部命令能用；`$HOME` 下的其他文件默认不可见；默认不联网（需要时设 `"network": true`）；默认用系统 Python 3.9（只有标准库）；默认 30 秒超时（`timeoutMs` 最多 120000）；输出最多 256KB；代码最多 64KB。
- **要访问本机文件时**（比如机器人建的台账）：在 `script` 里声明 `"sandbox": {"readOnly": ["/绝对路径/台账"], "readWrite": ["/绝对路径/导出"], "deny": [...]}`（也可以写 `~/…`）。只声明真正需要的路径，能只读就不要读写；代码里用绝对路径访问（不要用相对路径，当前目录是临时目录）。~/.ssh、各类凭证、Amber 自己的配置目录声明了也打不开，提交时会被拒绝。
- **数据在另一台机器上时**（Amber 不在那台机器上）：那台机器要装好并批准一个执行端（docs/executor.md）。在 `script` 里写 `"env": "执行端名/环境名"`，沙箱路径用 `{WORKDIR}/子目录` 表示那个环境的目录，代码里用 `os.environ["WORKDIR"]` 拼绝对路径。不知道有哪些执行端和环境时，问用户（管理员私聊 Amber 发「执行端」可以看到）。
- **需要第三方包时**：在 `script` 里写 `"interpreter": "/opt/homebrew/bin/python3"` 或某个虚拟环境里的 python（绝对路径），这个解释器自己装好的包都能用；虚拟环境放在 `$HOME` 下时，要把它的目录加进 `sandbox.readOnly`。
- 把用户刚才实际跑通的逻辑原样搬进脚本，先在本机用一份示例输入跑一遍。

### 2. 写草稿文件

```json
{
  "chatId": "oc_…", "chatType": "group",
  "name": "注册商户数", "description": "统计近 N 天每天新注册的商户数",
  "params": [{"name": "days", "label": "天数", "type": "integer", "default": "7", "min": 1, "max": 90}],
  "script": {"kind": "script", "lang": "python", "network": false, "timeoutMs": 30000, "code": "…"},
  "options": {"confirm": false, "schedulable": true}
}
```

- 私聊时 `chatType` 写 `p2p`，并加 `"claimer": "用户邮箱"`（认领卡发到他和 Amber 的私聊）。群指令要求 Amber 在群里。
- 群里提交时也建议带上 `"claimer"`（让你固化的那个人的邮箱或 union_id）：认领卡会 @ 他，提醒他来认领；这只是提醒，群里其他人照样能认领。
- 想让认领卡出现在当前话题里，加 `"originMessageId": "<话题里的消息 id>", "inThread": true`；不加就发在群主时间线上。
- 参数类型：`string`（可加 `maxLength`、`pattern`）或 `integer`（可加 `min`、`max`）；`"defaultFrom": "caller.city"` 表示不填时用执行人的办公城市。
- `options.confirm`：执行前必须确认（会改数据、有风险时打开）。
- `options.schedulable`：允许定时执行。**不写时默认为 true**；不适合定时的（比如有副作用、或结果每次都需要人看着执行的）请显式写 `false`。
- `script.kind` 只能用 `script`（所有指令都在沙箱里运行；`privileged` 已移除，提交会被拒绝）。要读写文件就声明 `sandbox`，见上面「要访问本机文件时」。
- **需要 token、密码时**：在 `script` 里写 `"secrets": ["API_TOKEN"]`（只写名字：大写字母、数字、下划线，最多 10 个），脚本从输入的 `secrets` 里取值。**不要向用户要密钥的值，也不要把值写进代码或草稿**；告诉用户：认领卡上点「设置密钥」（或私聊 Amber 发「设置密钥 指令名」），在私聊卡片上填写，然后再试运行。不要打印密钥（打印出来也会被遮成 `***`）。群指令的密钥由所有执行人共用；只给一个人用的凭证，指令要提交到私聊（`p2p`）。需要密钥的指令总是要人点确认卡才能执行，`amber show` 会列出还没设置的密钥。

### 修改已有指令

用户要改一条已有的指令时，用**同一个名字、同一个会话**提交草稿，Amber 会把它当作新版本：认领卡上会显示和当前版本的差异，审核通过后自动替换。新版本只能由原创建人或管理员认领。同一条指令一次只能有一个版本在认领或审核中。

### 3. 提交

```sh
amber submit draft.json --label <你的 bot 名>
```

之后由人完成：认领人在认领卡上试运行、提交审核；审核人在飞书审批里同意后生效。你不能认领或审核。

## 安装

`amber` 是一个只依赖 Python 3 标准库的脚本，一般装在 `~/.local/bin/amber`；PATH 里找不到时用完整路径。

服务地址每个安装环境自己配置，skill 里不写死：`amber info` 能显示当前机器连的是哪个 Amber。如果提示「还没配置 Amber 服务地址」，**不要自己猜地址**，告诉用户需要部署 Amber 的人提供地址，再运行 `amber config set-url <地址>`（或设置环境变量 `AMBER_URL`）。
