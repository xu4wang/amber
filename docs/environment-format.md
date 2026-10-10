# 运行环境定义格式（amber-env/1）

运行环境定义是一份 JSON，描述「在这台机器上执行的脚本能访问什么」：哪些路径可读写、只读、禁止，脚本的主目录、Python、环境变量。Amber 执行端只认这个格式：执行端的 `envs/` 文件夹里每个 `<环境名>.json` 就是一份。

这份格式**不依赖 Amber 或 botmux**，其他 agent 平台、沙箱实现都可以直接生成或使用：

- **生成方**（把自己的权限配置转成这个格式）：例如 `export-botmux-env.mjs` 把 botmux 机器人的沙箱配置导出成一份定义。
- **使用方**（按这个格式生成自己的沙箱规则）：例如 Amber 执行端把它编译成 macOS Seatbelt 规则。

本文是规范：「必须」表示实现必须做到，「建议」表示推荐做法。

## 示例

最简单的一份（`amber-executor env set 台账 /data/ledger` 生成的就是它）：

```json
{
  "format": "amber-env/1",
  "name": "台账",
  "workdir": "/data/ledger",
  "access": { "readWrite": ["{WORKDIR}"] }
}
```

从一个 agent 的沙箱配置导出（和这个 agent 能访问的数据一致）：

```json
{
  "format": "amber-env/1",
  "name": "结算助手",
  "workdir": "/Users/me/clearing-settlement",
  "python": "/opt/homebrew/bin/python3",
  "access": {
    "readWrite": ["{WORKDIR}", "~/botmux-roles/cli_xxxx", "~/.botmux/bots/cli_xxxx", "~/.lark-cli-bots/cli_xxxx"],
    "readOnly": ["~/Library/Application Support/lark-cli/master.key.file", "~/Library/Application Support/lark-cli/appsecret_cli_xxxx.enc"],
    "deny": ["~/.botmux/bots/cli_xxxx/send-cred.json"]
  },
  "vars": { "LARKSUITE_CLI_CONFIG_DIR": "/Users/me/.lark-cli-bots/cli_xxxx" },
  "realHome": true,
  "source": "botmux:cli_xxxx"
}
```

只读版本：把数据路径都放进 `readOnly`，需要写的工具配置（比如上面的 lark-cli 配置目录）留在 `readWrite`。

## 字段

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `format` | 字符串 | 否 | 固定为 `"amber-env/1"`。不写视为 `amber-env/1`；写了别的值，使用方必须拒绝 |
| `name` | 字符串 | 否 | 环境名：Unicode 字母或数字开头（汉字、英文字母、数字都可以），后面可以跟字母、数字、`_`、`-`，最多 32 个字符。导入时可以另外指定，覆盖这里的值 |
| `workdir` | 字符串 | 是 | 环境的主目录：绝对路径或 `~/…`，不能含 `..`，必须是已存在的目录。脚本从环境变量 `WORKDIR` 拿到它；`access` 里的路径可以用 `{WORKDIR}` 代指它 |
| `python` | 字符串 | 否 | 这个环境默认用的 Python 解释器：绝对路径或 `~/…`，文件名是 `python`、`python3` 或 `python3.x`（如 `python3.12`）。优先级：脚本自己指定的 > 这里的 > 使用方的默认值（Amber 执行端是 `/usr/bin/python3`） |
| `access` | 对象 | 否 | 访问规则，见下文。**不写就等于 `{"readWrite": ["{WORKDIR}"]}`** |
| `access.readWrite` | 路径数组 | 否 | 可读可写（包括创建、删除）的路径 |
| `access.readOnly` | 路径数组 | 否 | 只读的路径 |
| `access.deny` | 路径数组 | 否 | 禁止访问的路径（用来在上面两类里挖掉一部分） |
| `vars` | 对象 | 否 | 给脚本的环境变量，`{"名字": "值"}`，值必须是字符串，最多 20 个，见「环境变量」 |
| `realHome` | 布尔 | 否 | 必须是 `true` 或 `false`，默认 `false`。为 `true` 时，脚本的 `HOME` 是运行用户的主目录；否则 `HOME` 是本次运行的临时目录 |
| `allowHosts` | 字符串数组 | 否 | 网络白名单：这个环境里的脚本能经代理访问的地址，见「网络」。使用方可以再加上自己统一放行的地址（Amber：管理员设置的「所有环境」名单） |
| `source` | 字符串 | 否 | 来源说明，最多 200 个字符，只用于展示（比如 `botmux:cli_xxxx`） |

不认识的**顶层**字段：使用方应当忽略，生成方不应当写。`access` 里只允许 `readWrite`、`readOnly`、`deny` 三个键，出现别的键必须拒绝（写错权限名不能被悄悄忽略）。

## 路径

- **写法**：`access` 里的路径可以是绝对路径、`~` 或 `~/…`（运行用户的主目录）、`{WORKDIR}` 或 `{WORKDIR}/…`；`workdir` 和 `python` 只能是绝对路径或 `~/…`。
- **解析**：使用方必须在导入时把路径展开成绝对路径，按 POSIX 规则规范化（合并 `//`，去掉 `.` 和结尾的 `/`），然后才校验、展示、编译。导入时**不解析符号链接**：批准的人看到、批准的是展开后的路径。
- **禁止**：含 `..` 的路径；含 NUL 或换行的路径；`readWrite` / `readOnly` 里的根目录 `/`。
- **数量**：三类合计最多 100 条。
- **路径的含义**：一条路径同时覆盖它下面的所有文件和子目录。可以指向文件，也可以指向目录。
- **符号链接**：沙箱按真实路径判断访问权限。使用方应当在**编译时**把已存在的路径解析成真实路径（例如 macOS 上 `/tmp` 是 `/private/tmp`）；还不存在的路径无法解析，原样使用（Amber 对 `/tmp`、`/var`、`/etc` 这三个已知别名做了替换）。指向别处的链接，访问权限以链接目标所在的路径为准：链接本身在授权目录里，并不会让目标变得可访问。

## 规则怎么生效

1. **默认拒绝**：没有任何规则覆盖的路径，一律不可访问。
2. **最深的规则生效**：一个文件被多条规则覆盖时，以路径最长（最具体）的那条为准。所以 `readWrite: ["/data"]` 加上 `deny: ["/data/private"]`，就是 `/data` 下除了 `private` 都可读写。
3. **同一路径写了多条**：定义里的规则之间，取最严格的（`deny` 严于 `readOnly` 严于 `readWrite`）。定义里的规则和基础规则落在同一路径时，以定义为准（所以定义可以正好开放一个凭证位置，也可以正好关掉一个基础规则开放的目录）。比较前先解析成真实路径。
4. **基础规则**：使用方另外提供让程序能运行的基础规则，不需要写进定义，见下面「基础规则」。其中本次运行的临时目录总是可读写（也是脚本的当前目录和 `TMPDIR`）。
5. **凭证目录默认拒绝**：常见的凭证存放位置默认拒绝，见下表。定义里写了这些位置**里面**（或正好就是这个位置）的路径，就按定义开放；使用方必须在审批界面上把这类路径，以及**包含**这些位置的路径（比如开放了整个 `~/.config`），单独标出来。
6. **强制拒绝**：下列位置任何定义都打不开。使用方必须在导入时拒绝开放它们的定义，并且在执行时把它们放在所有规则之后再拒绝一次：
   - 使用方自己的配置目录（例如 Amber 执行端的私钥）；
   - `~/.ssh`；
   - 钥匙串：`~/Library/Keychains`、`/Library/Keychains`。

   声明 `deny` 这些位置是允许的（本来就拒绝）。

默认拒绝的凭证位置（第 5 条）：

| 位置 |
|---|
| `~/.gnupg` `~/.aws` `~/.azure` `~/.netrc` `~/.git-credentials` `~/.npmrc` `~/.pypirc` `~/.docker` `~/.kube` |
| `~/.config/gh` `~/.config/glab-cli` `~/.config/gcloud` `~/.config/op` `~/.config/1Password` `~/.1password` `~/.password-store` |
| `~/.lark-cli` `~/.lark-cli-bots` `~/Library/Application Support/lark-cli` |
| `~/.botmux` `~/.config/botmux` `~/.claude` `~/.claude.json` `~/.codex` `~/Library/Cookies` |
| 工具链里的凭证文件：`~/.cargo/credentials(.toml)` `~/.gem/credentials` `~/.m2/settings.xml` `~/.m2/settings-security.xml` `~/.gradle/gradle.properties` |

## 基础规则

基础规则由使用方提供，目的是让解释器和常用命令能运行，同时不暴露数据。规范要求：

- 必须**只读**：系统目录和语言工具链（解释器、包、命令行工具）。
- 必须**可读写**：本次运行新建的临时目录。
- 必须**拒绝**：上面的凭证位置（定义可以重新开放）和强制拒绝位置（谁都打不开）。
- 其余一律拒绝。

Amber 的取值，供参考：

- 只读：`/System` `/usr` `/bin` `/sbin` `/Library` `/opt` `/private/etc` `/private/var/select` `/private/var/db/timezone` `/private/var/run`，以及主目录下的工具链 `~/.nvm` `~/.pyenv` `~/Library/Python` `~/.local/lib` `~/.local/bin` `~/.cargo` `~/go` `~/.bun` `~/.rustup` 等；
- 可读写：`/dev`、本次运行的临时目录；
- 非文件权限：允许进程、信号、Mach、IPC、sysctl、file-ioctl、IOKit（解释器和常用命令需要）。

## 网络

脚本**不能直连网络**。环境的 `allowHosts` 列出它能访问的地址（使用方可以统一再加一些，Amber 把管理员设置的「所有环境」名单一起放行，初始是飞书），使用方在本机起一个只放行这些地址的 HTTPS 代理（`CONNECT`），沙箱只允许连这个代理，并通过 `HTTPS_PROXY` 等环境变量把代理地址交给脚本（curl、Python、Go 程序、lark-cli 都会自动使用）。

- 每项是精确域名（`open.feishu.cn`），或 `*.域名`（所有子域名，不含它本身）；可以带 `:端口`，不带就是 443。小写，最多 50 项；不支持 IP 地址和单独的 `*`。
- 代理只做 `CONNECT`（HTTPS），普通 HTTP 请求一律拒绝；不在名单上的地址返回 403。
- 名单是环境的一部分，变化的处理和路径一样（Amber：跟随定义文件的环境，增删地址直接生效并通知管理员，新增的地址标红）。

应用自己声明的网络能力（Amber：`network: true` 可以直连任何地址；调用登记过的本机服务）在这之外另算，随代码审核。

## 环境变量

- 名字：大写字母开头，只含大写字母、数字、下划线，最多 64 个字符；值必须是字符串，最多 1024 个字符，不能含 NUL 或换行；最多 20 个。
- 不能设置（使用方必须拒绝）：`PATH`、`HOME`、`TMPDIR`、`WORKDIR`、`LANG`、`PYTHON*`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`。这些由使用方决定，或者能改变程序加载什么代码。
- 使用方必须另外设置 `WORKDIR`（= `workdir`）、`TMPDIR`（= 本次运行的临时目录）、`HOME`（见 `realHome`）。Amber 还会设置 `PATH`（系统和 Homebrew 的常用位置）、`LANG`、`PYTHONIOENCODING`。

## realHome

有些工具按 `HOME` 找自己的配置或密钥（比如 lark-cli 在 `$HOME/Library/Application Support/lark-cli` 找密钥存储），或者用户自己装在主目录下的 Python 包（`pip install --user`）。`realHome: true` 时：

- 脚本的 `HOME` 是运行用户的主目录；
- 使用方应当让 Python 加载用户自己的 site-packages（Amber 用 `python -E` 而不是 `-I`）；
- **能访问的路径不变**：仍然只有 `access` 和基础规则里的路径。`HOME` 只是一个变量，不是授权。

## 校验清单（使用方）

导入一份定义时必须：

1. `format` 有值且不是 `amber-env/1`：拒绝。
2. `workdir` 不能含 `..`，必须存在且是目录；`python`、`realHome`、`source` 类型正确。
3. 展开、规范化全部路径；按「路径」一节检查。
4. `readWrite` / `readOnly` 里的路径，如果是强制拒绝的位置、在它里面、或者包含它（比如开放了整个 `~`，而 `~/.ssh` 在里面）：拒绝整份定义。
5. 检查 `vars` 的名字和值。
6. 把展开后的定义交给批准的人看，并标出凭证路径。批准的应当是展开后的这一份；之后任何改动都要重新批准。
7. 每次执行前再按 1–5 检查一遍（定义文件可能在批准之后被人改过）。

## 映射到沙箱

使用方把「基础规则 + 定义 + 本次运行的临时目录」编译成目标平台的规则。

**macOS（Seatbelt / `sandbox-exec`）**，Amber 执行端的做法：

```
(version 1)
(deny default)
(import "/System/Library/Sandbox/Profiles/bsd.sb")
; 规则按路径深度从浅到深输出，同深度时宽松的在前；Seatbelt 以最后匹配的规则为准，这样就实现了「最深的规则生效」
(allow file-read* (subpath "/data"))                       ; readOnly / readWrite
(deny  file-write* (subpath "/data"))                      ; readOnly：再拒绝写
(allow file-write* (subpath "/data/export"))               ; readWrite
(deny  file-read* (subpath "/data/private"))               ; deny：读写都拒绝
(deny  file-write* (subpath "/data/private"))
(allow file-read-metadata (literal "/") (literal "/data")) ; 祖先目录只允许看元数据，不允许列目录
; 最后输出强制拒绝，任何规则都盖不过它
(deny file-read* (subpath "/Users/me/.ssh"))
(deny file-write* (subpath "/Users/me/.ssh"))
```

**其他平台**：规范只要求最终效果和上面「规则怎么生效」一致，具体机制由平台实现决定。例如 Linux 上可以用 bubblewrap：只读路径用 `--ro-bind`、可读写路径用 `--bind`，按深度从浅到深挂载；`deny` 的路径不挂载，或用空目录 / 空文件覆盖（覆盖文件时要确认读到的是空内容而不是原文件）；强制拒绝的位置一律不挂载。这只是建议做法，Amber 目前只实现了 macOS。

## 在 Amber 里怎么用（不属于格式本身）

- **谁来检查**：执行端在导入时和每次执行前按校验清单检查（它知道本机的主目录和自己的配置目录）；登记到 Amber 时，Amber 再检查一遍格式（绝对路径、不含 `..`、不是根目录、环境变量名），然后把展开后的环境发给管理员批准。批准绑定的是登记上来的这一份，任何改动都会重新申请。
- **环境文件夹**：执行端定时读 `envs/` 文件夹；新增文件要批准，已有文件里路径、环境变量、Python 的变化自动生效并通知管理员，删除文件直接生效，其他变化要重新批准，见[执行端](executor.md#环境文件夹改了怎么生效)。
- **执行限制**：Amber 执行端目前只运行 Python 脚本；时限由 Amber 管理员设定（初始默认 60 秒，最长 10 分钟，最多 30 分钟）；应用不能再声明任何路径；调用 Amber 上登记的服务要经 Amber 转发（见[执行端](executor.md#调用-amber-上登记的服务)）。

## 从 botmux 导出

`export-botmux-env.mjs --bot <appId>` 读本机的 botmux 配置（`~/.botmux/bots.json`），生成和这个机器人在 botmux 沙箱里能访问的数据一致的定义：

- 可读写：它的 `workingDir`、bots.json 里 `sandboxPaths.readWrite`、它的机器人目录 `~/.botmux/bots/<appId>`、它的角色库 `~/botmux-roles/<appId>`、它的 lark-cli 配置 `~/.lark-cli-bots/<appId>`（存在的才写入）；
- 只读：`sandboxPaths.readOnly`；macOS 上它自己的 lark-cli 密钥 `appsecret_<appId>.enc` 和密钥库的 `master.key.file`（不包括任何其他机器人的）；
- 禁止：`sandboxPaths.deny`，以及 botmux 的发消息凭证 `~/.botmux/bots/<appId>/send-cred.json`；
- `vars.LARKSUITE_CLI_CONFIG_DIR` 指向它的 lark-cli 配置，`realHome: true`，`source: "botmux:<appId>"`；
- `--readonly`：数据路径都改成只读，lark-cli 配置仍可写（它要在那里刷新令牌）；`--python` 指定解释器；`--name` 指定环境名。

## 参考实现

- 校验与编译：`src/sandbox-policy.ts`（`validateEnvAccess`、`buildPolicy`、`compileToSeatbelt`）。
- 导入、导出：`client/amber-executor/amber-executor.mjs`（`env import`、`env set`、`env export`）。
- 从 botmux 生成：`client/amber-executor/export-botmux-env.mjs`。其他 agent 平台可以照着写一个自己的导出工具：把「这个 agent 能访问哪些路径、用什么身份调用外部工具」翻译成上面的字段。
