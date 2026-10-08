# amber 命令行与 skill

日常使用时，人只跟自己的 agent（botmux、Claude Code、cc-connect 等）说话，agent 通过 `amber` 命令行调用 Amber。`amber` 是一个单文件脚本（[`client/amber`](../client/amber)），只依赖 Python 3 标准库。

> **这篇装的是客户端**，每台跑 agent 的机器都要装，不需要部署服务端。Amber 服务端一个组织只部署一套，见 [安装与部署](install.md)。

## 安装

在每台跑 agent 的机器上执行：

```sh
mkdir -p ~/.local/bin
curl -fsSL https://raw.githubusercontent.com/xu4wang/amber/main/client/amber -o ~/.local/bin/amber
chmod 755 ~/.local/bin/amber
```

**要确认装的是哪一版**（比如多台机器要保持一致）：把上面地址里的 `main` 换成具体的 commit，按 commit 下载，再算哈希：

```sh
C=<commit>
curl -fsSL https://raw.githubusercontent.com/xu4wang/amber/$C/client/amber -o /tmp/amber.new
shasum -a 256 /tmp/amber.new     # 和在仓库里对同一个 commit 算出的结果比对：git show $C:client/amber | shasum -a 256
```

升级时也照这个办法：先下载到临时文件、核对哈希，再覆盖。

如果机器上网要走代理，也可以从 Amber 所在的机器用 scp 拷过去。有的机器 `~/.local/bin` 不在 PATH 里，这时用完整路径调用。

**skill**：把 [`skills/amber/SKILL.md`](../skills/amber/SKILL.md) 放到 agent 的 skills 目录下：

| agent | 位置 |
|---|---|
| Claude Code（默认配置） | `~/.claude/skills/amber/SKILL.md` |
| Codex（默认配置） | `~/.codex/skills/amber/SKILL.md` |
| botmux 里每个 bot 自己的 Claude 配置 | `~/.botmux/bots/<appId>/claude/skills/amber/SKILL.md` |
| botmux 里每个 bot 自己的 Codex 配置 | `~/.botmux/bots/<appId>/codex/skills/amber/SKILL.md` |

**先确认 bot 实际用的是哪个配置目录，再决定装到哪里。** botmux 里每个 bot 可能是 Claude 也可能是 Codex（看 `~/.botmux/bots.json` 里该 bot 的 `cliId`），也可能没有自己的配置目录、直接用全局配置。判断办法：`~/.botmux/bots/<appId>/claude` 或 `…/codex` 存在并且有配置文件（Codex 是 `config.toml` 或 `auth.json`），才说明这个 bot 用它自己的目录；否则装到全局目录就行，**不要凭空新建一个 bot 专属目录**，建了也不会被加载。

skill 在 agent 开新会话时加载，已经在跑的会话看不到。

**服务地址**：命令行和 skill 里都不写死地址，每台机器装好后配置一次：

```sh
amber config set-url http://amber.example.com    # 写入 ~/.config/amber-client.json
amber info                                        # 检查：显示服务地址、网站地址、本机在 Amber 里的名字
```

也可以用环境变量 `AMBER_URL`，它的优先级高于配置文件。只有 Amber 配置里 `machines` 列出的 IP 能访问。网站地址由服务端的 `webBaseUrl` 决定，agent 通过 `amber info` 获取，不需要另外配置。

## 命令

```text
amber list                                   这个会话里能用的指令
amber show <指令>                            参数，以及 run 会直接执行还是要确认
amber run <指令> [参数名=值 ...]             执行（或者发确认卡片）
amber wait <请求编号> [--timeout 秒]         等确认卡片的结果（默认最多 600 秒）
amber schedule add <指令> --at "每天 09:00" [--tz <时区>] [参数名=值 ...]
amber schedule list
amber schedule pause <编号>                  立即暂停
amber schedule resume <编号>                 恢复，需要创建人在卡片上确认
amber schedule delete <编号>                 删除，需要创建人在卡片上确认
amber submit draft.json                      提交新指令草稿（同名即新版本）
amber retire <指令>                          下线指令，需要创建人或管理员在卡片上确认
amber global <指令>                          设为全局，需要管理员在卡片上确认
amber local <指令>                           取消全局，需要管理员在卡片上确认
amber info                                   本机连的 Amber 服务、网站地址
amber config set-url <地址>                  设置本机的 Amber 服务地址
```

通用选项：

| 选项 | 默认值 | 说明 |
|---|---|---|
| `--chat oc_…` | `$BOTMUX_CHAT_ID` | 当前会话（群或私聊） |
| `--chat-type group\|p2p` | `$BOTMUX_CHAT_TYPE` | 会话类型 |
| `--user 邮箱` | 无 | agent 正在为谁工作。**只有这个人能点确认卡片**；私聊里必须填 |
| `--reply-to om_…` | 话题里取 `$BOTMUX_ROOT_MESSAGE_ID` | 确认卡片发进这个话题 |
| `--label 名字` | `$AMBER_LABEL` | agent 的名字（用户认识的那个，比如 bot 名），显示在认领卡和确认卡上；不填显示「你的 agent」。机器名只记审计，不显示 |
| `--json` | 关 | 输出原始 JSON |

退出码：`0` 完成，`1` 出错，`2` 用法错误，`3` 还在等人点卡片。

## 三档行为

接口按 IP 放行，**分不清 agent 背后是哪个人**，所以接口本身从不代表任何人执行。按指令的情况分三档：

| 档位 | 什么时候 | 怎么执行 | 身份 |
|---|---|---|---|
| ① 查询 | `list`、`show`、`schedule list`、`wait` | 直接返回 | 不涉及 |
| ② 直接执行 | 指令不调用任何服务，也没开「执行前确认」 | `amber run` 当场执行，Markdown 直接打印出来 | 记为 `agent:<机器名>`，不签发任何凭证 |
| ③ 确认卡片 | 指令要调用服务（需要某人的身份）、开了「执行前确认」，或者要创建、恢复、删除定时任务 | Amber 在原来的群或话题里发一张预填好的确认卡片；私聊则发到那个人和 Amber 的私聊。**执行结果只显示在这张卡片上（完整内容在网站），不返回给 agent**：`amber wait` 只告诉你完成、取消还是失败 | **点卡片的人**，身份取自飞书的卡片事件 |

第 ③ 档的典型流程：

```sh
$ amber run 注册商户数 days=30 --user zhang@example.com
已在飞书发出确认卡片，等 zhang@example.com 点「执行」。用 amber wait <request> 查看是否完成；结果只显示在飞书卡片上，不返回给 agent。
request: 4f0c…（完整随机编号）
# agent 先告诉用户：「请在卡片上点一下」
$ amber wait 4f0c…
已执行（以点确认的人的身份）。结果只显示在飞书的确认卡片上（完整内容在 Amber 网站），不会返回给 agent。
```

为什么不把结果给 agent：这类指令是**以点卡片的人的身份**查数据的，结果属于这个人。确认卡片和请求编号对群里所有人可见，结果如果能通过接口取回，知道编号的人就能读到别人的数据。所以结果只留在飞书卡片和网站（网站只给本人看自己的运行记录）。 运行编号和请求编号都是完整的随机串；按运行编号读结果的接口 `/v1/runs/` 已关闭（返回 410）。

确认卡片 24 小时内有效，只能处理一次，重复点击无效。点「取消」或过期时，`wait` 会说明原因。每个会话 10 分钟内最多发 10 张确认卡片，防止 agent 刷屏。

## 定时任务

- 只有审核时打开了 `schedulable` 的指令可以定时。草稿里不写 `schedulable` 时默认打开（会显示在认领卡和审核文档上）。
- 时间写法：`每天 09:00`、`工作日 09:00`、`每周一 09:00`、`每小时`、`每 2 小时`、`每 2 小时 15 分`、`每 5 分钟`（分钟间隔只能是 5、10、15、20、30，最短 5 分钟），英文写法 `daily 9:00` / `weekdays 9:00` / `weekly mon 9:00` / `every 2h` / `every 15m` 也可以。不加 `--tz` 时用 Amber 服务器配置的默认时区（见安装文档里的 `timezones`），需要时用 `--tz` 指定其他 IANA 时区。
- 人在卡片上点了「创建定时任务」才生效，之后每次都以**创建人**的身份执行，结果发到原来的群、话题或私聊。
- **脚本没有输出就不发消息**。所以监控类的需求应该写成：正常时什么都不打印，出问题时才输出。
- 失败只私聊通知创建人，连续失败 3 次自动暂停。以下情况也会自动暂停并私聊通知创建人：指令下线、换了新版本、不再允许定时，或者创建人已经不在群里（群成员名单缓存 10 分钟，创建人退群后最多约 10 分钟内任务仍可能按其身份运行）。
- 每个会话最多 20 个定时任务，全局最多同时运行 2 个。Amber 停机期间错过的运行不会补跑。

## 提交新指令

草稿格式和脚本约定见 [skills/amber/SKILL.md](../skills/amber/SKILL.md#把跑通的操作提交成新指令)。

**修改已有指令**：在同一个会话里用同一个名字提交草稿，就是这条指令的新版本。认领卡和审核文档会附上和当前版本的代码差异；新版本只能由原创建人或管理员认领；同一条指令同时只能有一个版本在认领或审核中。审核通过后旧版本自动下线，挂在旧版本上的定时任务暂停，并私聊创建人确认换绑。提交后，由人在认领卡上试运行、提交审核，审核人在飞书审批里同意后指令生效。agent 不能认领或审核。

## 接口（给不想用命令行的 agent）

所有接口都在 `/v1/` 下，只放行白名单 IP。除标注 GET 的以外都是 POST，请求体为 JSON。会话上下文字段是 `chatId`、`chatType`、`user`、`replyTo`、`inThread`、`label`。

| 方法 | 路径 | 请求体（除上下文外） |
|---|---|---|
| POST | `/v1/commands/list` | 无 |
| POST | `/v1/commands/show` | `command` |
| POST | `/v1/runs` | `command`、`args` |
| GET | `/v1/requests/<请求编号>?wait=秒` | 无（最多等 50 秒） |
| POST | `/v1/schedules` | `command`、`args`、`at`、`tz` |
| POST | `/v1/schedules/list` | 无 |
| POST | `/v1/schedules/<编号>/pause\|resume\|delete` | 无 |
| POST | `/v1/commands/retire` | `command` |
| POST | `/v1/commands/scope` | `command`、`global`（true 设为全局，false 取消全局） |
| POST | `/v1/drafts` | 草稿 JSON |
| GET | `/v1/info` | 无，返回网站地址 `webUrl` 和本机名字 |
| GET | `/v1/keys` | 无，返回公钥，见 [identity.md](identity.md) |
