---
name: amber
description: 使用 Amber 固化应用：查看和执行本会话可用的应用、创建/管理定时任务、把跑通的操作提交成新应用；读取用户本人的飞书数据（私聊、群消息、邮件、文档、妙记、飞书任务）。用户提到 Amber、固化应用、「每天 X 点跑一下」、「把刚才这个存下来」时使用；用户要你看或统计他自己的邮件、私聊、群消息、文档、妙记、飞书任务时（你只有机器人身份，读不到）也先用它，不要直接用 lark-cli。
---

# Amber

Amber 保存经过审核的确定性应用（参数 + 一段脚本）。用户跟你说话，你用 `amber` 命令行替他调用 Amber，用户基本不用直接跟 Amber 打交道。

## 先记住一条

Amber 的接口**分不清你背后是谁**（只按机器 IP 放行）。所以凡是要以某个人的身份做的事，Amber 都会在飞书里发一张确认卡片，**谁点了就以谁的身份执行**。你要做的是：

1. 发起请求；
2. 告诉用户「请在卡片上点一下」；
3. 用 `amber wait <request>` 确认完成。**执行结果只显示在飞书卡片上，你拿不到**（这是以点卡片的人的身份查出来的数据）；告诉用户「结果在卡片上」，不要猜测或编造结果。

不要替用户点卡片，也不要让用户把卡片转给别人。

## 网站

用户想在网页上查看、执行应用或管理定时任务时：用 `amber info` 查到网站地址告诉他，让他在飞书私聊 Amber 发送「登录」，点卡片上的按钮。登录链接只发在他自己的私聊里，你不要代为转发。

## 会话参数

在 botmux 会话里，`amber` 会自动读取 `$BOTMUX_CHAT_ID`、`$BOTMUX_CHAT_TYPE` 和 `$BOTMUX_ROOT_MESSAGE_ID`（话题里的卡片会发进同一个话题）。另外：

- **总是带上 `--user <当前说话人的邮箱>`**（取自消息的 sender email）。这样只有他能点卡片；私聊里必须带。**应用只有创建人自己能看见、能执行**（全局应用除外），`amber list` 列出的是这个人自己的应用和全局应用；不带 `--user` 时只看得到全局应用。别人建的应用他用不了：创建人可以在网站上把应用申请上架到 Amber Store（审核一次），别人在网站上安装自己的一份（不审批，配置项和密钥各填各的）。agent 不能上架或安装，告诉用户去网站操作。也可以让创建人在网站上把群应用「复制给群成员」（对方在飞书上接收，不审批；在执行端环境里运行的应用也能这样分享）。
- **总是带上 `--label <你的 bot 名>`**（或设置 `AMBER_LABEL`），用用户认识的名字。卡片上只显示这个名字，不显示机器，用户只需要知道是哪个 agent 帮他提交或发起的。

## 常用命令

```sh
amber list --user user@example.com                     # 这里能用的应用
amber show 天气 --user user@example.com                # 参数，以及 run 会直接执行还是要确认
amber run 天气 city=上海 --user user@example.com       # 执行
amber wait <request>                              # 等确认卡片的结果（默认最多 10 分钟）
amber schedule add 天气 --at "工作日 09:00" city=上海 --user user@example.com
amber schedule list
amber schedule pause <id>                         # 立即暂停
amber schedule resume <id> / delete <id>          # 要创建人在卡片上确认
amber retire 天气 --user user@example.com          # 下线应用：创建人或管理员在卡片上确认
amber global 天气 --user user@example.com          # 设为全局 / amber local 天气 取消全局：管理员在卡片上确认
```

退出码：0 完成，1 出错，2 用法错误，3 还在等人点卡片。

`amber run` 的两种结果：

- **直接执行**（应用不需要任何人的身份，也没开 confirm）：结果的 Markdown 直接打印出来，你整理后回复用户即可。执行身份记为「agent@机器」。
- **确认卡片**：打印 `request: <id>`。先告诉用户去点卡片，然后运行 `amber wait <id>`：它只告诉你完成、取消、过期还是失败，**不返回结果内容**，结果在卡片上（完整内容在网站）。不要编造结果；用户要就结果继续分析，请他把需要的数字告诉你。

## 下线应用、设为全局

用户说「下线应用 xxx」「把 xxx 设为全局 / 取消全局」时，直接替他调用，不要让他去找 Amber：

- `amber retire <应用> --user <邮箱>`：Amber 发确认卡，**应用创建人或管理员**点「确认下线」才生效。下线不需要审核、不能撤销，它的定时任务会暂停并通知创建人。
- `amber global <应用> --user <邮箱>` / `amber local <应用> --user <邮箱>`：只有**管理员**能确认。
- 带了 `--user` 而这个人没有权限时，Amber 当场拒绝、不发卡片，把原因告诉用户即可。
- 发出后同样用 `amber wait <request>` 确认是否完成。

用户想**登录网站**时，让他自己私聊 Amber 发「登录」，这一步不能代办（登录链接只发在他的私聊里）。

## 定时任务

- 只有审核时打开了 `schedulable` 的应用能定时；不行时 `amber schedule add` 会直接告诉你。
- 时间写法：`每天 09:00`、`工作日 09:00`、`每周一 09:00`、`每小时`、`每 2 小时`、`每 2 小时 15 分`、`每 5 分钟`（分钟间隔只能是 5、10、15、20、30，最短 5 分钟）。不加 `--tz` 时用 Amber 服务器配置的默认时区；需要别的时区就加 `--tz <IANA 时区名>`，比如用户在曼谷用 `--tz Asia/Bangkok`。确认卡片上会写明时区，用户能核对。
- 用户点「创建定时任务」后才生效，之后每次都以他的身份自动执行，结果发到原来的群、话题或私聊。
- **脚本没有输出时不发消息**。监控类需求（「有异常就提醒我」）就写成：正常时什么都不打印，异常时才输出。
- 运行失败只私聊通知创建人；连续失败 3 次自动暂停。应用下线或换了新版本，定时任务也会自动暂停。

## 把跑通的操作提交成新应用

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
  请求体只能是 `{"sql": "…", "datasource": "tchouse-c"}`（`datasource` 可省略，多带任何字段返回 422）。端口取输入里的 `tcpPort`，不要写死，也不要用 `unixSocket`（在执行端上只提供 `tcpPort`）；请求不要走代理。在执行端上运行（写了 `env`）的应用也可以这样调用，写法完全一样。
  返回 200 时看 `status`：`success` 才算成功，数据在 `rows`（以列名为键的对象数组）、`columns`、`row_count`、`truncated`；
  `validation_error` 等失败也是 200，原因在 `error_code` 或 `issues[].code`。401 = 凭证无效，409 = 凭证已用过，429 = 定时执行限流。
  试运行最多返回 20 行，`truncated` 为 true 时要在输出里说明。完整说明见文档「可信身份」的「已接入的服务：data-mcp」一节。
- **输出**：往标准输出打印 Markdown。可以用普通 Markdown 和表格，以及：
  - ` ```vega-lite `：图表（柱状图、折线图、饼图（mark: arc，theta=数值、color=类别）会转成飞书原生图表；其他图只在网站上显示）
  - ` ```table `：数据表，`{"columns":[{"name","label","type":"text|number"}],"rows":[…],"total":N}`
  - `@名字`：要把结果交给本群的另一个机器人或某个人时，在正文里写 `@` 加对方在群里的名字（和群成员列表里的显示名完全一样），例如 `有更新，@同步机器人 请拉最新代码`；名字后面要空一格或接标点（`@张三请看` 不会 @）。正式运行时 Amber 会把它换成真正的 @，对方会被唤起或收到提醒。只在群里生效；试运行只显示文字；`@所有人`、群里有同名的、不在群里的都不会 @；一次最多 @ 5 个。被唤起的机器人看到的发送者是 Amber，所以要把交代的事写清楚。表格和图表里的 @ 不生效。
- **运行环境**（沙盒）：当前目录是本次运行的临时目录（也是 `HOME`、`TMPDIR`，结束后删除）；系统目录和常见语言工具链（Homebrew、nvm、pyenv 等）可读，外部命令能用；`$HOME` 下的其他文件默认不可见；不能直连网络，但能经代理访问执行位置的网络白名单（管理员设的「所有环境」名单，默认就是飞书域名，再加环境里的 `allowHosts`），代理地址已经在 `HTTPS_PROXY` 里，lark-cli、curl、Python 自动使用，**调 lark-cli 不用设 network**；要直连任何地址才设 `"network": true`（它和 services 二选一）；默认用系统 Python 3.9（只有标准库）；不写 `timeoutMs` 时用管理员设的默认时限（初始 60 秒）；跑得久的写 `timeoutMs`（毫秒，比实际多留一点余量），最多到管理员设的最长时限（初始 10 分钟），超过会被拒绝；输出最多 256KB；代码最多 64KB。
- **要访问数据时**（比如机器人建的台账）：脚本**不写任何路径声明**，在 `script` 里写 `"env": "执行端名/环境名"`，选一个已批准的**运行环境**，能访问的就是那个环境的权限。从 botmux 机器人导出的环境，和那个机器人在自己沙箱里能访问的一样，lark-cli 用的也是它的身份；用一个目录生成的环境，就是 `{WORKDIR}` 那个目录。代码里用 `os.environ["WORKDIR"]` 或绝对路径访问（当前目录是临时目录）。**选哪个环境**：先运行 `amber envs --mine`，找来源是你自己（`botmux:<你的 appId>`）的环境，用第一列的「执行端名/环境名」；`amber envs` 列出全部已批准的环境。找不到属于你的环境，就告诉用户需要管理员先为你登记一个，不要猜名字。不写 `env` 的应用在 Amber 本机跑，看不到任何业务数据。
- **需要第三方包时**：在 `script` 里写 `"interpreter": "/opt/homebrew/bin/python3"` 或某个虚拟环境里的 python（绝对路径），这个解释器自己装好的包都能用；在执行端上跑时，一般用运行环境里配好的 Python，不用自己写。
- 把用户刚才实际跑通的逻辑原样搬进脚本，先在本机用一份示例输入跑一遍。

### 2. 写草稿文件

```json
{
  "chatId": "oc_…", "chatType": "group",
  "name": "注册商户数", "description": "统计近 N 天每天新注册的商户数",
  "params": [{"name": "days", "label": "天数", "type": "integer", "default": "7", "min": 1, "max": 90}],
  "script": {"kind": "script", "lang": "python", "network": false, "timeoutMs": 60000, "code": "…"},
  "options": {"confirm": false, "schedulable": true}
}
```

- 私聊时 `chatType` 写 `p2p`，并加 `"claimer": "用户邮箱"`（认领卡发到他和 Amber 的私聊）。群应用要求 Amber 在群里。
- **示例应用**：Amber 仓库 `samples/` 里有天气、密钥保管箱、群聊日报、PR变动提醒（定时盯 GitHub PR、有动静 @ 机器人）、我的飞书数据（`app.json` + `app.py`）。用户要装时运行 `amber submit <仓库>/samples/<名字>/app.json --user <他的邮箱>`（不写会话就用当前会话，代码从 `codeFile` 读）；写新应用时也可以参考它们的写法。
- 同名的上一版还停在认领卡上（没提交审核）时：私聊草稿再提交一次就会替换它，旧认领卡显示「已被新版本替换」；群里的草稿或已在审核中的版本不会被替换，提交会被拒绝（`name_taken`），请用户在旧认领卡上丢弃或等审核结束。
- 群里提交时**要带上** `"claimer"`（让你固化的那个人的邮箱或 union_id）：认领卡会 @ 他提醒他来认领。同一个群里可能有几个人各有一个同名应用，Amber 按认领人判断这是谁的那个的新版本；不带 claimer 又有多个同名应用时会被拒绝。新应用谁都可以认领，新版本只有原创建人能认领。
- 想让认领卡出现在当前话题里，加 `"originMessageId": "<话题里的消息 id>", "inThread": true`；不加就发在群主时间线上。
- 参数类型：`string`（可加 `maxLength`、`pattern`）或 `integer`（可加 `min`、`max`）；`"defaultFrom": "caller.city"` 表示不填时用执行人的办公城市。
- **配置项**：每次执行都一样、不该由执行人填的值（要检查的仓库、通知哪个机器人等），在参数上加 `"scope": "config"`。值由创建人或管理员在网站上设置一次，脚本照常从 `params` 里取；执行人、表单、`amber run` 都传不进来。试运行时在认领卡的试运行表单里填（只用于这次试运行）；生效后提醒用户去网站上这个应用页面底部的「配置项」设置，没设置时执行会被拒绝。不要把值写死在代码里，也不要用配置项放 token、密码（用密钥）。配置项不能用 `defaultFrom`。`amber show` 会列出配置项、当前值和还没设置的项（`configMissing`）。
- `options.confirm`：执行前必须确认（会改数据、有风险时打开）。
- `options.schedulable`：允许定时执行。**不写时默认为 true**；不适合定时的（比如有副作用、或结果每次都需要人看着执行的）请显式写 `false`。
- `script.kind` 只能用 `script`（所有应用都在沙箱里运行）。不要写 `sandbox` 字段（会被拒绝），访问数据靠 `env`，见上面「要访问数据时」。
- **需要 token、密码时**：在 `script` 里写 `"secrets": ["API_TOKEN"]`（只写名字：大写字母、数字、下划线，最多 10 个），脚本从输入的 `secrets` 里取值。**不要向用户要密钥的值，也不要把值写进代码或草稿**；告诉用户：认领卡上点「设置密钥」（或私聊 Amber 发「设置密钥 应用名」），在私聊卡片上填写，然后再试运行。不要打印密钥（打印出来也会被遮成 `***`）。应用只有认领人（创建人）自己能执行，密钥也只有他在用；全局应用的密钥由所有执行人共用。需要密钥的应用总是要人点确认卡才能执行，`amber show` 会列出还没设置的密钥。只用来存放、可能只填一部分的（比如保管箱），加 `"secretsOptional": true`。
- **要把用户存的密码放到本机时**（比如他说「把我保管箱里的 gitlab 令牌放到你的 secrets 目录」）：先 `amber show <应用> --user <他的邮箱>` 看配置项里的说明找到是哪个密钥名，再 `amber secret get <应用> <密钥名> --user <他的邮箱> --out <文件路径>`。Amber 会私聊他发确认卡，他点「允许」后值直接写进文件（600），命令只打印路径和字节数。**不要 cat、不要把文件内容发到会话里**；命令最多等 300 秒，可以放后台跑。不要在聊天里向用户要密码。

- **要读用户自己的飞书数据时**（私聊、群消息、邮件、文档、妙记、飞书任务，比如他说「看看我和张三的私聊里答应了什么」「把昨天那场会的妙记总结一下」「统计一下我的飞书任务」）：你只有机器人身份，读不到，**不要用 lark-cli 硬试**。在和他的**私聊**里用声明了 toAgent 的应用，比如「我的飞书数据」：`amber read 我的飞书数据 op=搜消息 q=<关键词> --user <他的邮箱>`（`op` 还有 `会话记录`、`找会话`、`搜邮件`、`读邮件`、`读文档`、`搜妙记`、`读妙记`、`我的任务`、`搜任务`，先 `amber show` 看参数）。飞书任务用 `op=我的任务`：返回与他相关（负责/关注/创建）的全部任务的统计（完成状态、逾期/7 天内到期/无截止、角色、创建月份、任务清单）和明细，`q=已完成` 或 `q=全部` 换明细范围，也可以写标题关键词；不要为此另做应用或让他导出截图。先告诉他「请在 Amber 私聊里点允许」；他也可以选「允许一段时间」，之后同一会话里再读就不用点。结果打印在标准输出，命令最多等 600 秒。**先用具体的关键词和较短的回看小时数**（`hours=`），别一上来用宽泛的词搜 30 天、100 条：结果太长你一次看不全。返回里出现「还有 N 条没显示」就换更具体的词或缩小范围再查，不要当作已经看全了。读文档、读妙记这种长内容加 `--out <文件>` 写进文件再分段读。读到的内容只用于回答他这次的问题：**不要写进记忆、文件或别的会话，不要转发给别人**。群里不能用（会被拒绝）。
- 草稿里写 `"toAgent": true`（和 `"larkUser": true` 一起）就是这类应用：结果可以交给 agent。只在用户要你读他自己的数据时用，并且只读。

### 修改已有应用

用户要改一个已有的应用时，用**同一个名字、同一个会话**提交草稿，Amber 会把它当作新版本：认领卡上会显示和当前版本的差异，审核通过后自动替换。新版本只能由原创建人认领。同一个应用一次只能有一个版本在认领或审核中。

### 3. 提交

```sh
amber submit draft.json --label <你的 bot 名>
```

之后由人完成：认领人在认领卡上试运行、提交审核；审核人在飞书审批里同意后生效。你不能认领或审核。

## 触发器：某件事发生时被叫醒

需要在 Amber 里发生某件事时接着做事（比如有应用提交审核就预审、执行失败就排查），不要定时去查，建一个触发器，让 Amber 在当前群或话题里 @你：

```bash
amber trigger add --on app.review_started --to here --mention <你在群里的名字> --user <邮箱>
```

- 事件：`app.review_started` `app.approved` `app.rejected` `app.retired` `run.failed` `run.output` `schedule.paused` `executor.offline` `executor.online` `page.published` `page.apps_changed`；`--app <应用>` 只看当前会话里的这个应用
- `--to me`（默认）私聊这个人；`--to here` 发到当前群，在话题里运行就是当前话题
- 这个人要在卡片上点「确认」；不是审核人或管理员时，应用事件必须用 `--app` 指定他自己的应用
- 收到的通知最后一行是 `amber-event <事件> event=… command=… spec=…`，按这些编号去查；通知里没有执行结果
- `amber trigger list` 查看，`amber trigger pause <编号>` 暂停；恢复和删除让用户在网站「我的触发器」里做

## 交给大模型处理（llm）

应用要总结、改写、分类文字时，不要让脚本自己调大模型（没有凭证、也连不上），在 `script` 里声明 `"services": {"llm": {"calls": N}}`，运行时：

```python
s = inp["services"]["llm"]; tok = s["tokens"].pop(0)
req = urllib.request.Request(f"http://127.0.0.1:{s['tcpPort']}/complete", data=json.dumps({"prompt": 文字, "system": 要求}).encode(),
                             headers={"Authorization": "Amber " + tok, "Content-Type": "application/json"}, method="POST")
text = json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=300))["text"]
```

- 每次调用用一张票据，calls 最多 20；一次最多约 15 万字，内容多就分批（先分段总结、再汇总），记得给最后的汇总留一次
- `model` 可选 `sonnet`（默认）/ `haiku` / `opus`；单次默认 4 分钟超时，`timeoutMs` 要给足（几次调用加起来）
- 大模型没有工具，只返回文字；交给它的文字会发给大模型服务商，别把密钥、令牌放进 prompt
- 会话记录默认不保存；要保存（便于事后查看）就在请求里加 `"persist": true`，返回 `sessionId`。处理别人的消息或敏感数据时不要保存

## 做页面应用

用户要一个能交互的网页（查数、看图表、读台账、写飞书）时，做成 Amber 页面应用，不要放 demo 网站：

1. 写一个目录：`index.html` 加样式、脚本、图片，样式自己定。页面里用 `<script src="/sdk/amber-page.js"></script>` 加载 Amber 接口
2. 数据一律通过已审核的 Amber 应用拿：`const r = await Amber.run('应用名', {参数: '值'})`，返回 `{markdown, blocks, json}`；`await Amber.render(元素, r)` 画成和卡片一样的显示；打开飞书链接用 `Amber.open(url)`；`Amber.me()` 拿访问者名字。需要的应用还没有，就按上面「提交成新应用」写一个（给页面用的数据，表格用 ```table，复杂结构多输出一个 ```json 块）
3. 目录里放 `amber.json`：`{"apps": ["应用名", ...]}`，写明页面会调用哪些应用（只能是这个人自己在这个会话里的应用，或全局应用）
4. 发布：`amber page publish ./目录 --name <小写字母数字和->` 加 `--user <邮箱>`。第一次发布、或者 amber.json 里的应用变了，用户要在飞书卡片上点「确认发布」；只改页面内容就直接生效，告诉用户刷新页面。确认卡片上会附页面首屏截图（截图时不会调用应用），所以让首屏不用操作就能看出这个页面是做什么的
5. 限制：页面不能联网、不能从 CDN 加载库（要用的库放进目录，或用 Amber 提供的 `/vendor/vega*.min.js`、`/vendor/marked.min.js`、`/vendor/purify.min.js`），最多 200 个文件、10MB。谁能打开由用户在网站上设置（默认只有他自己）

## 安装

`amber` 是一个只依赖 Python 3 标准库的脚本，一般装在 `~/.local/bin/amber`；PATH 里找不到时用完整路径。

服务地址每个安装环境自己配置，skill 里不写死：`amber info` 能显示当前机器连的是哪个 Amber。如果提示「读不到配置文件（权限被拒）」，说明地址已经配好、只是你在沙盒里读不到：按提示设置 `AMBER_URL`，或请用户在沙盒外运行一次 `amber config set-url`，**不用找人要地址**。如果提示「还没配置 Amber 服务地址」，**不要自己猜地址**，告诉用户需要部署 Amber 的人提供地址，再运行 `amber config set-url <地址>`（或设置环境变量 `AMBER_URL`）。
