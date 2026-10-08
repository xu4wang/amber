# 飞书应用配置

Amber 需要一个**自建应用**，通过它来收消息、发卡片、查用户、发起审批、写知识库文档。

所有事件都走**长连接**，飞书不用回调你的服务器，所以 Amber 部署在内网也没问题。网站登录也不走飞书 OAuth，用的是私聊 Amber 拿一次性链接（见 [identity.md](identity.md#网站登录)），因此**不需要配置任何回调地址或重定向地址**。

## 1. 创建应用

1. 在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，名称例如「Amber」，图标可以用 `web/logo.svg`。
2. 「添加应用能力」里开启**机器人**。
3. 在「凭证与基础信息」里拿到 App ID 和 App Secret，写进 `~/.config/amber/lark-app.env`（见 [install.md](install.md#31-lark-appenv飞书应用凭证权限设为-0600)）。**Secret 不要发到聊天里**，如果泄露了就在这里重置。

## 2. 权限

在「权限管理」里开通下表中的权限。下面列的都是范围最小的选项；如果飞书报错里提示了几个可选权限，任选其一即可。

| 功能 | 权限 | 用途 |
|---|---|---|
| 收消息 | `im:message.p2p_msg:readonly` | 接收私聊消息 |
| | `im:message.group_at_msg:readonly` | 接收群里 @Amber 的消息 |
| 发消息 | `im:message:send_as_bot` | 以机器人身份发送、回复卡片 |
| | `im:message:update` | 原地更新卡片（执行结果、审批状态） |
| 群信息 | `im:chat:read`（或 `im:chat.group_info:readonly`） | 判断是群还是私聊，读取群名 |
| | `im:chat.members:read` | 判断某人是否在群里：定时任务创建人退群后自动暂停；网站只显示本人所在群的指令 |
| 通讯录 | `contact:user.id:readonly` | 通过邮箱查用户（管理员、审核人、私聊草稿的认领人、`--user`） |
| | `contact:user.base:readonly` | 读取姓名（卡片、网站显示用） |
| | `contact:user.employee:readonly` | 读取办公城市（参数可以默认取「执行人的办公城市」） |
| 审批 | `approval:instance` | 发起审批、查询审批状态 |
| | `approval:definition` | 读取审批定义 |
| 知识库 | `wiki:node:create` | 在知识库里新建审核文档 |
| | `wiki:space:retrieve` | 读取知识库空间 |
| 文档 | `docx:document.block:convert` | 把 Markdown 转成文档内容 |
| | `docx:document:write_only` | 写入文档内容（代码、试运行结果、审批记录） |

缺权限的影响：

- 没有 `im:chat.members:read`：网站上看不到群指令，也不能执行群指令（Amber 宁可拒绝也不放行）；定时任务不再检查创建人是否还在群里。
- 没有审批和知识库的权限：退回到用卡片上的「通过 / 驳回」按钮审核。

## 3. 事件与回调

在「事件与回调」里：

1. 订阅方式选**使用长连接接收**（事件和回调两处都要选）。
2. 添加事件 `im.message.receive_v1`（接收消息）。
3. 添加回调 `card.action.trigger`（卡片回传交互）。
4. 可选：添加审批事件「审批实例状态变更」。实测长连接收不到这个事件，所以 Amber 每 60 秒主动查一次待审批的实例；配不配这项都不影响结果。

## 4. 审批定义

在飞书「审批管理后台」新建一个审批，名称例如「Amber 指令上线」：

- **表单**：放一个「多行文本」控件，Amber 会在里面写入指令摘要和文档链接。
- **流程**：一个审批节点，审批人选**发起人自选**，多人审批方式选**会签**（所有人同意才通过）。审批人由 Amber 发起审批时按 `reviewers` 名单指定。
- 「可见范围 / 发起人」要包含认领指令的人：审批以认领人的名义发起。

建好后，从审批定义的链接里拿到 `approval_code`，再用接口查出节点 id 和控件 id：

```sh
set -a; . ~/.config/amber/lark-app.env; set +a
T=$(curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$AMBER_LARK_APP_ID\",\"app_secret\":\"$AMBER_LARK_APP_SECRET\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["tenant_access_token"])')
curl -s "https://open.feishu.cn/open-apis/approval/v4/approvals/<approval_code>" -H "Authorization: Bearer $T" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin)["data"];print("nodes:",[(n["name"],n["node_id"]) for n in d["node_list"]]);print("form:",[(f["name"],f["id"],f["type"]) for f in json.loads(d["form"])])'
```

把结果填进 `config.json` 的 `approval`：

- `reviewNodeId`：审批节点的 `node_id`。不要填「提交」和「结束」节点。
- `formFieldId`：多行文本控件（`textarea`）的 `id`。

审批结果以接口查询为准：Amber 会重新读取审批实例，确认**每一位审核人都同意**、指令定义的哈希也没有变化，才让指令生效。（特权脚本已停用。）

## 5. 知识库

1. 新建一个知识空间，例如「Amber 指令库」，在里面建一个父页面，审核文档都放在它下面。
2. 把 **Amber 应用添加为知识空间成员，权限为可编辑**。
3. 把空间开放给需要看代码的人（审核人至少要能看）。
4. 填写 `config.json` 的 `wiki`：
   - `parentNodeToken`：父页面链接 `…/wiki/<token>` 里的 token；
   - `spaceId`：用 `GET /open-apis/wiki/v2/spaces/get_node?token=<父页面 token>` 查，返回结果里的 `space_id`；
   - `baseUrl`：你们租户的知识库链接前缀，例如 `https://xxx.feishu.cn/wiki/`。

每提交一次审核，Amber 就新建一篇文档「Amber 指令：<名称>（<版本哈希前 8 位>）」，内容包括说明、参数、完整代码和试运行输出，审批结果出来后会追加到文档末尾。

## 6. 发布

1. 「版本管理与发布」→ 创建版本。**可用范围**要包含所有会用 Amber 的人：不在范围内的人收不到私聊，也点不了卡片。
2. 提交发布。如果企业要求管理员审核，要等审核通过。

**每次新增权限或事件之后，都要重新创建版本并发布才会生效。**这是最常见的「明明加了权限还报错」的原因。

## 7. 检查清单

| 检查 | 期望 |
|---|---|
| 私聊 Amber 发「帮助」 | 回复指令列表卡片 |
| 把 Amber 拉进群，@Amber 发「帮助」 | 回复本群的指令列表 |
| 私聊 Amber 发「登录」 | 回复带「打开 Amber 网站」按钮的卡片 |
| 提交一份草稿，认领、试运行、提交审核 | 知识库里出现文档，飞书审批里出现待办 |
| 日志里有 `member check unavailable` | 说明缺 `im:chat.members:read`，或者 Amber 不在那个群里 |
| 日志里有 `admin email not resolved` 或 `reviewers resolved 0` | 邮箱查不到人：检查 `contact:user.id:readonly` 权限和可用范围 |
