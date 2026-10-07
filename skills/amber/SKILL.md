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
3. 用 `amber wait <request>` 等结果，再接着回答用户。

不要替用户点卡片，也不要让用户把卡片转给别人。

## 网站

用户想在网页上看自己能用的指令和定时任务：让他打开 http://amber.dev-beta.ksherpay.com ，在飞书私聊 Amber 发送「登录」，点卡片上的按钮。登录链接只发在他自己的私聊里，你不要代为转发。

## 会话参数

在 botmux 会话里，`amber` 会自动读取 `$BOTMUX_CHAT_ID`、`$BOTMUX_CHAT_TYPE` 和 `$BOTMUX_ROOT_MESSAGE_ID`（话题里的卡片会发进同一个话题）。另外：

- **总是带上 `--user <当前说话人的邮箱>`**（取自消息的 sender email）。这样只有他能点卡片；私聊里必须带。
- **总是带上 `--label <你的 bot 名>`**（或设置 `AMBER_LABEL`），用用户认识的名字。卡片上只显示这个名字，不显示机器，用户只需要知道是哪个 agent 帮他提交或发起的。

## 常用命令

```sh
amber list --user u@ksher.com                     # 这里能用的指令
amber show 天气 --user u@ksher.com                # 参数，以及 run 会直接执行还是要确认
amber run 天气 city=上海 --user u@ksher.com       # 执行
amber wait <request>                              # 等确认卡片的结果（默认最多 10 分钟）
amber result <run>                                # 某次运行的输出
amber schedule add 天气 --at "工作日 09:00" city=上海 --user u@ksher.com
amber schedule list
amber schedule pause <id>                         # 立即暂停
amber schedule resume <id> / delete <id>          # 要创建人在卡片上确认
```

退出码：0 完成，1 出错，2 用法错误，3 还在等人点卡片。

`amber run` 的两种结果：

- **直接执行**（指令不需要任何人的身份，也没开 confirm）：结果的 Markdown 直接打印出来，你整理后回复用户即可。执行身份记为「agent@机器」。
- **确认卡片**：打印 `request: <id>`。先告诉用户去点卡片，然后运行 `amber wait <id>`；输出就是执行结果。用户点了「取消」或者 24 小时没人点，wait 会说明情况。

## 定时任务

- 只有审核时打开了 `schedulable` 的指令能定时；不行时 `amber schedule add` 会直接告诉你。
- 时间写法：`每天 09:00`、`工作日 09:00`、`每周一 09:00`、`每小时`、`每 2 小时`、`每 2 小时 15 分`。默认北京时间，泰国用 `--tz Asia/Bangkok`。
- 用户点「创建定时任务」后才生效，之后每次都以他的身份自动执行，结果发到原来的群、话题或私聊。
- **脚本没有输出时不发消息**。监控类需求（「有异常就提醒我」）就写成：正常时什么都不打印，异常时才输出。
- 运行失败只私聊通知创建人；连续失败 3 次自动暂停。指令下线或换了新版本，定时任务也会自动暂停。

## 把跑通的操作提交成新指令

当用户说「把刚才这个存进 Amber，叫 xxx」时：

### 1. 写脚本

- **输入**：从标准输入读一个 JSON：
  ```json
  {"params": {"city": "北京"}, "caller": {"unionId": "on_…", "chatId": "oc_…", "channel": "bot|agent|schedule", "city": "北京"}, "runId": "…",
   "services": {"data-mcp": {"token": "…", "tcpPort": 8765}}}
  ```
  `services` 只有声明了服务时才有。参数一律从这里取，不要从命令行或环境变量读。
- **输出**：往标准输出打印 Markdown。可以用普通 Markdown 和表格，以及：
  - ` ```vega-lite `：图表（柱状图、折线图会转成飞书原生图表）
  - ` ```table `：数据表，`{"columns":[{"name","label","type":"text|number"}],"rows":[…],"total":N}`
- **运行环境**（沙盒）：读不到 `$HOME` 下的文件；只能写当前目录；默认不联网（需要时设 `"network": true`）；只能用 Python 标准库；默认 30 秒超时（`timeoutMs` 最多 120000）；输出最多 256KB；代码最多 64KB。
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
- 参数类型：`string`（可加 `maxLength`、`pattern`）或 `integer`（可加 `min`、`max`）；`"defaultFrom": "caller.city"` 表示不填时用执行人的办公城市。
- `options.confirm`：执行前必须确认（会改数据、有风险时打开）。
- `options.schedulable`：允许定时执行。
- `script.kind` 用 `script`。`privileged`（不进沙盒）只有管理员能批准，非必要不用。

### 3. 提交

```sh
amber submit draft.json --label <你的 bot 名>
```

之后由人完成：认领人在认领卡上试运行、提交审核；审核人在飞书审批里同意后生效。你不能认领或审核。

## 安装

`amber` 是一个只依赖 Python 3 标准库的脚本，装在 `~/.local/bin/amber`；有的机器 PATH 里没有 `~/.local/bin`，找不到命令时用完整路径 `~/.local/bin/amber`。服务地址默认 `http://amber.dev-beta.ksherpay.com`，可用 `AMBER_URL` 覆盖；只有机队机器的 IP 能访问。
