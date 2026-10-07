# 给 agent 的说明：把一次操作封存成 Amber 指令

当用户说「把刚才这个存进 Amber，叫 xxx」时，按下面的步骤做。

## 1. 写脚本

一条指令 = **参数 + 一段 Python 脚本**。脚本的约定：

- **输入**：从标准输入读一个 JSON：
  ```json
  {
    "params": {"city": "北京"},
    "caller": {"unionId": "on_…", "chatId": "oc_…", "channel": "bot", "city": "北京"},
    "runId": "…",
    "services": {"data-mcp": {"token": "…", "tcpPort": 8765}}
  }
  ```
  `services` 只在声明了服务时才有。参数一律从这里取，**不要从命令行参数或环境变量读**。
- **输出**：往标准输出打印 Markdown。可以用：
  - 普通 Markdown 和 Markdown 表格
  - ` ```vega-lite ` 代码块：图表（飞书会把柱状图、折线图转成原生图表）
  - ` ```table ` 代码块：数据表，格式 `{"columns":[{"name","label","type":"text|number"}],"rows":[…],"total":N}`
- **运行环境**（沙盒脚本）：
  - 读不到用户目录（`$HOME`）下的任何文件；只能写当前目录（每次运行一个临时目录，跑完即删）
  - 默认不能联网；需要访问外网时设 `"network": true`
  - 只能用 Python 标准库
  - 默认 30 秒超时（`timeoutMs` 最多 120000），输出最多 256KB，代码最多 64KB
- 把用户刚才实际跑通的逻辑原样搬进脚本，**不要临时改写**；先在本机用一份示例输入跑一遍再提交。

## 2. 写草稿文件

```json
{
  "chatId": "oc_…",
  "chatType": "group",
  "name": "注册商户数",
  "description": "统计近 N 天每天新注册的商户数",
  "params": [
    {"name": "days", "label": "天数", "type": "integer", "default": "7", "min": 1, "max": 90}
  ],
  "script": {"kind": "script", "lang": "python", "network": false, "timeoutMs": 30000, "code": "…"},
  "options": {"confirm": false, "schedulable": false},
  "submittedBy": "Beta"
}
```

- `chatId`：指令属于哪个会话。botmux 会话里用环境变量 `BOTMUX_CHAT_ID`。
- `chatType`：`group`（群）或 `p2p`（私聊）。私聊时还要写 `"claimer": "用户邮箱"`，认领卡会发到他和 Amber 的私聊。
- 群指令要求 Amber 机器人在这个群里，否则提交会被拒绝。
- 参数类型：`string`（可加 `maxLength`、`pattern`）或 `integer`（可加 `min`、`max`）；`"defaultFrom": "caller.city"` 表示不填时用执行人的办公城市。
- `options.confirm`：执行前需要在表单上确认（会改数据、有风险的操作建议打开）。
- `options.schedulable`：允许定时执行。
- `script.kind` 一般用 `script`。`privileged`（不进沙盒）只有管理员能批准，非必要不要用。

## 3. 提交

```sh
amber-submit draft.json --label "你的 bot 名"
```

提交来源由 Amber 按机器的 IP 自动识别，`--label` 只是附加说明。成功后返回草稿 id，Amber 会发出认领卡。

## 4. 之后的事由人完成

认领人在认领卡上试运行、提交审核；审核人在飞书审批里同意后指令生效。agent 不能认领、审核或执行指令。
