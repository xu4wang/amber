# 示例应用

仓库的 [`samples/`](https://github.com/xu4wang/amber/tree/main/samples) 目录里有四个完整的示例应用，都是线上实际在用的版本。可以直接装来用，也可以当作让 agent 写新应用时的参考：

| 示例 | 目录 | 演示了什么 |
|---|---|---|
| 天气 | `samples/weather/` | 参数、默认用执行人的办公城市、访问外网、输出图表 |
| 密钥保管箱 | `samples/secret-vault/` | 密钥（可以只填一部分）、配置项、agent 经你确认后读取密钥 |
| 群聊日报 | `samples/chat-digest/` | 以执行人本人的飞书身份运行、内置大模型服务、定时任务 |
| 我的飞书数据 | `samples/my-lark-data/` | 结果交给 agent（`amber read`）：agent 经你确认后读你的消息、邮件、文档 |

每个目录里有两个文件：

- `app.json`：应用定义（名称、说明、参数、选项，以及脚本要用的能力），和[草稿格式](script.md#草稿格式)一样，只是没有写提交到哪个会话，代码放在 `"codeFile": "app.py"` 指向的文件里。
- `app.py`：脚本本身，可以直接阅读。

## 怎么装

**方式一：从 Amber Store 安装**（管理员上架过的话）。在网站左侧「Amber Store」里找到它，点「安装」，选装在私聊里还是某个群里。不用审批，装好就是你自己的一份，配置项和密钥各填各的。

**方式二：让你的 agent 提交**。在和 agent 的对话里说：

> 把 Amber 仓库里的 samples/weather 提交成我的应用。

agent 在装了 `amber` 命令行的机器上运行（仓库在 `~/amber`）：

```text
amber submit ~/amber/samples/weather/app.json --user 你的邮箱
```

`app.json` 里没写会话，命令行用当前对话（群或私聊），认领人是 `--user`。之后和其他新应用一样：在认领卡上试运行、提交审核，审核通过后就能用。想换个名字或改参数，让 agent 先复制一份目录再改。

## 天气

`samples/weather/`：查一个城市的当前天气，加上未来 24 小时的气温折线图。

- **参数**：城市（不填就用你的办公城市，再没有就用曼谷）。
- **能力**：访问外网（调用 open-meteo 的公开接口，不需要 key）。审核时会看到「可访问外网」。
- **用法**：私聊或在群里 @Amber 发 `天气 上海`；网站上选「天气」填城市执行。结果里的折线图在飞书卡片上显示成原生图表。
- **可以学到**：`"defaultFrom": "caller.city"` 让参数默认用执行人的城市；` ```vega-lite ` 代码块输出图表；脚本只用 Python 标准库。

## 密钥保管箱

`samples/secret-vault/`：存最多 10 个密码（`KEY1`–`KEY10`），需要时让自己的 agent 取到它所在机器的文件里。值不经过聊天。

- **装在哪**：建议装在**私聊**里，只有你自己能看见、能用。
- **设置**：
  1. 在网站这个应用页面的「密钥」里填要存的值（或者私聊 Amber 发 `设置密钥 密钥保管箱`）。可以只填其中几个，其余留空。
  2. 在页面底部「配置项」的「说明」里写明每个 KEY 是什么，比如 `KEY1=gitlab 令牌，KEY2=数据库只读账号`。
- **执行**：只显示说明和每个 KEY 是「已填」还是「未填」，**从不显示值**。
- **让 agent 取用**：对你的 agent 说「把我保管箱里的 gitlab 令牌放到你的 secrets/gitlab_token」。agent 先用 `amber show` 读说明找到是 `KEY1`，再运行：

  ```text
  amber secret get 密钥保管箱 KEY1 --user 你的邮箱 --out ./secrets/gitlab_token
  ```

  Amber 私聊你发一张确认卡（哪台机器、哪个 agent、读哪个 KEY），你点「允许」后，值加密交给那个命令行，写进文件（权限 600），命令只打印路径和字节数。每次都要你确认；只有你（这一份的创建人）能允许。细节见[agent 接入](cli-and-skill.md#读取密钥)。
- **可以学到**：`"secrets"` 加 `"secretsOptional": true`（可以只填一部分）；配置项写说明。

## 群聊日报

`samples/chat-digest/`：把你所在的群（跳过外部群和设了免打扰的群）过去 N 小时的消息交给大模型总结成日报，写进**你自己云空间**里的一份飞书文档，并关闭链接分享（只有你能看）。结果卡只给统计和文档链接。

- **前提**（管理员）：
  - Amber 开启了[大模型服务](admin.md#大模型服务)；
  - Amber 的飞书应用开通了这些用户身份权限：`im:chat:read`、`im:message:readonly`、`im:message.group_msg:get_as_user`、`docx:document`、`docx:document:create`、`docs:permission.setting:write_only`；要总结私聊，再加 `im:message.p2p_msg:get_as_user`（见[飞书应用配置](feishu-setup.md)）；
  - 运行限制里的最长时限不少于 10 分钟（初始就是 10 分钟）。
- **你自己**：授权飞书一次（私聊 Amber 发 `授权飞书`，或在网站上这个应用的页面点「授权飞书」），见[以你本人的飞书身份运行](lark-identity.md)。
- **参数**：回看小时数（默认 24）；包含私聊（`是` / `否`，默认否；选「是」时只算和真人的、对方说过话的私聊）。
- **用法**：手动执行一次大约 1–3 分钟；更常见的是在网站「定时」页建一个每天的定时任务，比如 `工作日 09:00`，以你的身份自动跑，结果私聊发你。每个人建自己的，互不影响。
- **隐私**：消息会发给大模型服务商（不保存会话）；文档只在你自己的云空间、关闭了链接分享。
- **可以学到**：`"larkUser": true` 以执行人身份调用 lark-cli；`"services": {"llm": {"calls": 7}}` 调用大模型，内容多时分批、再汇总；整理后不到 12 万字一次处理；拉取失败时在结果里给出原因。

## 我的飞书数据

`samples/my-lark-data/`：让你自己的 agent 以**你本人的飞书身份**、只读地取你的飞书数据，拿回去接着处理。比如对 agent 说「看看我这周和张三的私聊里答应了什么」「把合同那封邮件的要点整理一下」。

- **装法**：管理员可以把它设为全局应用（每个人读的都是自己的数据，互不影响）；也可以装在你自己的私聊里。
- **前提**（管理员）：Amber 的飞书应用开通了这些用户身份权限：`im:chat:read`、`im:message:readonly`、`im:message.group_msg:get_as_user`、`im:message.p2p_msg:get_as_user`、`search:message`（搜消息）、`mail:user_mailbox.message:readonly`、`mail:user_mailbox.message.subject:read`、`mail:user_mailbox.message.address:read`、`mail:user_mailbox.message.body:read`（邮件）、`docx:document:readonly`（文档）、`minutes:minutes.search:read`、`minutes:minutes:readonly`、`minutes:minutes.artifacts:read`、`minutes:minutes.transcript:export`（妙记）。新开通权限后，已授权过的人要重新发一次「授权飞书」。
- **你自己**：授权飞书一次（私聊 Amber 发 `授权飞书`）。
- **参数**：
  - 操作：`搜消息`、`会话记录`、`找会话`、`搜邮件`、`读邮件`、`读文档`、`搜妙记`、`读妙记`。
  - 内容：搜消息、搜邮件时写关键词；会话记录写群的 `oc_…` 或私聊对方的 `ou_…`（先用「找会话」查）；读邮件写邮件 id（先用「搜邮件」查）；读文档写文档链接；搜妙记写关键词（可不填，列出时间范围内你拥有或参与的妙记）；读妙记写妙记链接（先用「搜妙记」查），返回 AI 总结、待办、章节和逐字稿。
  - 回看小时数（搜消息、会话记录、搜妙记，默认 24，最多 720）；最多条数（默认 30，最多 100）。
- **用法**：agent 在和你的私聊里运行，比如 `amber read 我的飞书数据 op=搜邮件 q=合同 --user 你的邮箱`。Amber 私聊你发确认卡，你选「允许本次」或「允许一段时间」（这个 agent 会话在选定时长内不再询问）。结果加密交给 agent，见[读取个人数据](cli-and-skill.md#读取个人数据)。在飞书或网站上执行也可以，结果只显示给你自己。
- **只读**：只调用搜索、列表、读取类的命令，不发消息、不改文档、不动邮件。输出最多约 6 万字，超出截断并注明；单条消息、邮件摘要过长时截断。
- **可以学到**：`"toAgent": true` 把结果交给 agent；一个应用用「操作」参数提供几种只读查询；对 lark-cli 输出做容错解析。

