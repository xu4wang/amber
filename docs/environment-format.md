# 运行环境定义格式（amber-env/1）

运行环境定义是一份 JSON，描述「在这台机器上执行的脚本能访问什么」：哪些路径可读写、只读、禁止，脚本的主目录、Python、环境变量。Amber 执行端只认这个格式（`amber-executor env import`）。

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
| `format` | 字符串 | 否 | 固定为 `"amber-env/1"`。写了别的值，使用方必须拒绝 |
| `name` | 字符串 | 否 | 环境名：字母、数字、汉字开头，可含 `_` `-`，最多 32 个字符。导入时可以另外指定，覆盖这里的值 |
| `workdir` | 字符串 | 是 | 环境的主目录，必须是已存在的目录。脚本从环境变量 `WORKDIR` 拿到它；路径里可以用 `{WORKDIR}` 代指它 |
| `python` | 字符串 | 否 | 这个环境默认用的 Python 解释器（绝对路径，以 `python`、`python3` 或 `python3.x` 结尾）。脚本自己指定的优先 |
| `access` | 对象 | 否 | 访问规则，见下文。**不写就等于 `{"readWrite": ["{WORKDIR}"]}`** |
| `access.readWrite` | 路径数组 | 否 | 可读可写（包括创建、删除）的路径 |
| `access.readOnly` | 路径数组 | 否 | 只读的路径 |
| `access.deny` | 路径数组 | 否 | 禁止访问的路径（用来在上面两类里挖掉一部分） |
| `vars` | 对象 | 否 | 给脚本的环境变量，`{"名字": "值"}`，最多 20 个 |
| `realHome` | 布尔 | 否 | 默认 `false`。为 `true` 时，脚本的 `HOME` 是运行用户的主目录；否则 `HOME` 是本次运行的临时目录 |
| `source` | 字符串 | 否 | 来源说明，最多 200 个字符，只用于展示（比如 `botmux:cli_xxxx`） |

不认识的字段：使用方应当忽略，生成方不应当写。

## 路径

- **写法**：绝对路径；`~` 或 `~/…`（运行用户的主目录）；`{WORKDIR}` 或 `{WORKDIR}/…`。
- **解析**：使用方必须在导入时把路径展开成绝对路径，按 POSIX 规则规范化（合并 `//`，去掉 `.` 和结尾的 `/`），然后才校验、展示、编译。
- **禁止**：含 `..` 的路径；含 NUL 或换行的路径；`readWrite` / `readOnly` 里的根目录 `/`。
- **数量**：三类合计最多 100 条。
- **路径的含义**：一条路径同时覆盖它下面的所有文件和子目录。可以指向文件，也可以指向目录。
- **符号链接**：规则按真实路径匹配。使用方应当在编译时把已存在的路径解析成真实路径（例如 macOS 上 `/tmp` 是 `/private/tmp`）；指向别处的链接，访问权限以链接目标所在的路径为准。

## 规则怎么生效

1. **默认拒绝**：没有任何规则覆盖的路径，一律不可访问。
2. **最深的规则生效**：一个文件被多条规则覆盖时，以路径最长（最具体）的那条为准。所以 `readWrite: ["/data"]` 加上 `deny: ["/data/private"]`，就是 `/data` 下除了 `private` 都可读写。
3. **同一路径写了多条**：取最严格的（`deny` 严于 `readOnly` 严于 `readWrite`）。
4. **基础规则**：使用方另外提供让程序能运行的基础规则：系统目录、常用语言工具链只读，本次运行的临时目录可读写（也是脚本的当前目录、`TMPDIR`）。基础规则不需要写进定义。
5. **凭证目录默认拒绝**：常见的凭证存放位置默认拒绝，见下表。定义里写了这些位置**里面**（或正好就是这个位置）的路径，就按定义开放；使用方必须在审批界面上把这类路径单独标出来。
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

## 环境变量

- 名字：大写字母开头，只含大写字母、数字、下划线，最多 64 个字符；值最多 1024 个字符，不能含 NUL 或换行。
- 不能设置（使用方必须拒绝）：`PATH`、`HOME`、`TMPDIR`、`WORKDIR`、`LANG`、`PYTHON*`、`DYLD_*`、`LD_*`、`NODE_OPTIONS`。这些由使用方决定，或者能改变程序加载什么代码。
- 使用方必须另外设置 `WORKDIR`（= `workdir`）、`TMPDIR`（= 本次运行的临时目录）、`HOME`（见 `realHome`）。

## realHome

有些工具按 `HOME` 找自己的配置或密钥（比如 lark-cli 在 `$HOME/Library/Application Support/lark-cli` 找密钥存储），或者用户自己装在主目录下的 Python 包（`pip install --user`）。`realHome: true` 时：

- 脚本的 `HOME` 是运行用户的主目录；
- 使用方应当让 Python 加载用户自己的 site-packages（Amber 用 `python -E` 而不是 `-I`）；
- **能访问的路径不变**：仍然只有 `access` 和基础规则里的路径。`HOME` 只是一个变量，不是授权。

## 校验清单（使用方）

导入一份定义时必须：

1. `format` 有值且不是 `amber-env/1`：拒绝。
2. `workdir` 必须存在且是目录。
3. 展开、规范化全部路径；按「路径」一节检查。
4. `readWrite` / `readOnly` 里的路径，如果是强制拒绝的位置、在它里面、或者包含它（比如开放了整个 `~`，而 `~/.ssh` 在里面）：拒绝整份定义。
5. 检查 `vars` 的名字和值。
6. 把展开后的定义（真实路径）交给批准的人看，并标出凭证位置里的路径。批准的应当是展开后的这一份；之后任何改动都要重新批准。

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

**Linux（bubblewrap）** 的对应做法：`--ro-bind` 对应只读路径、`--bind` 对应可读写路径；`deny` 用空的 tmpfs 或 `/dev/null` 覆盖（`--tmpfs`、`--ro-bind /dev/null`）；按深度从浅到深挂载，深的覆盖浅的。强制拒绝的位置一律不挂载。

## 参考实现

- 校验与编译：`src/sandbox-policy.ts`（`validateEnvAccess`、`buildPolicy`、`compileToSeatbelt`）。
- 导入、导出：`client/amber-executor/amber-executor.mjs`（`env import`、`env set`、`env export`）。
- 从 botmux 生成：`client/amber-executor/export-botmux-env.mjs`。其他 agent 平台可以照着写一个自己的导出工具：把「这个 agent 能访问哪些路径、用什么身份调用外部工具」翻译成上面的字段。
