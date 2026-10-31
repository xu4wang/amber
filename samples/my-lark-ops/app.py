# 我的飞书操作：以执行人本人的飞书身份做需要「本人」才能做的写操作。每次执行都由本人在确认卡上点「执行」。
# 每个操作（op）是写死的接口和参数校验，不接受任意接口；加新操作 = 在 OPS 里加一项，作为新版本重新审核。
# 现有操作：建群、拉人、查邮箱。成员写邮箱、union_id（on_…）或姓名（通讯录里只有一个同名的人才算），
# 机器人写应用 id（cli_…）。
import json, os, re, subprocess, sys

inp = json.load(sys.stdin)
P = inp.get("params") or {}
OP = (P.get("op") or "").strip()
CHAT = (P.get("chat_id") or "").strip()
NAME = (P.get("name") or "").strip()
DESC = (P.get("description") or "").strip()
LU = inp["larkUser"]
CLI = LU["cli"]
ENV = {**os.environ, **LU["env"]}
AUTH_HINT = "请私聊 Amber 发「授权飞书」重新授权一次，再试"


def split(s):
    return [x.strip() for x in re.split(r"[,，\s]+", s or "") if x.strip()]


users, bots, names = [], [], []
for x in split(P.get("users")):
    if x.startswith("cli_"):
        bots.append(x)
    elif x.startswith("on_") or "@" in x:
        users.append(x)
    else:
        names.append(x)
for x in split(P.get("bots")):
    bots.append(x)
bad = [x for x in users if not (re.fullmatch(r"on_[0-9a-f]{20,64}", x) or re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", x))]
bad += [x for x in bots if not re.fullmatch(r"cli_[0-9a-z]{16}", x)]
bad += [x for x in names if not re.fullmatch(r"[\w\u00b7\u4e00-\u9fff.'-]{1,30}", x)]
if bad:
    sys.exit("这些不像邮箱、union_id（on_…）或机器人应用 id（cli_…）：%s" % "、".join(bad[:10]))
users, bots, names = list(dict.fromkeys(users)), list(dict.fromkeys(bots)), list(dict.fromkeys(names))
if len(names) > 20:
    sys.exit("按姓名一次最多查 20 个人，其余请写邮箱")
if len(users) + len(names) > 50 or len(bots) > 5:
    sys.exit("一次最多 50 个人、5 个机器人")


def api(method, path, params=None, data=None):
    args = [CLI, "api", method, path, "--as", "user"]
    if params is not None:
        args += ["--params", json.dumps(params)]
    if data is not None:
        args += ["--data", json.dumps(data, ensure_ascii=False)]
    r = subprocess.run(args, env=ENV, capture_output=True, text=True, timeout=60)
    out = None
    for text in (r.stdout, r.stderr):
        i = (text or "").find("{")
        if i >= 0:
            try:
                out = json.JSONDecoder().raw_decode(text[i:])[0]
                break
            except Exception:
                pass
    if not isinstance(out, dict):
        sys.exit("飞书接口调用失败：%s" % (r.stderr or r.stdout).strip()[-300:])
    err = out.get("error") if isinstance(out.get("error"), dict) else None
    code = out.get("code", (err or {}).get("code", 0))
    if r.returncode != 0 or code not in (0, None) or out.get("ok") is False:
        e = err or out
        msg = e.get("msg") or e.get("message") or json.dumps(e, ensure_ascii=False)
        if "scope" in json.dumps(e).lower() or e.get("code") in (99991672, 99991679):
            sys.exit("缺少飞书权限（%s）。%s" % (msg[:200], AUTH_HINT))
        sys.exit("飞书接口返回错误 %s：%s" % (code or "", str(msg)[:300]))
    return out.get("data", out)


def lark(args):
    """lark-cli 快捷命令（不是 api）：返回 data。"""
    r = subprocess.run([CLI] + args + ["--as", "user"], env=ENV, capture_output=True, text=True, timeout=60)

    def first_json(text):
        i = (text or "").find("{")
        try:
            return json.JSONDecoder().raw_decode(text[i:])[0] if i >= 0 else None
        except Exception:
            return None
    out = first_json(r.stdout)
    if isinstance(out, dict) and r.returncode == 0 and out.get("ok") is not False:
        return out.get("data", out)
    # lark-cli 出错时把一段 JSON 写到 stderr（或 stdout）：取里面的 message，不要截尾巴
    e = first_json(r.stderr) or out or {}
    err = e.get("error") if isinstance(e.get("error"), dict) else e
    msg = str(err.get("message") or err.get("msg") or (r.stderr or r.stdout or "").strip()[-300:])
    if "scope" in msg.lower() or err.get("type") == "authorization":
        sys.exit("缺少飞书权限（%s）。%s" % (msg[:300], AUTH_HINT))
    sys.exit("按姓名查人失败：%s" % msg[:300])


# 姓名、邮箱 -> 人：都用「搜人」（contact +search-user，支持个人身份），拿到的 open_id 直接用来拉人。
# 不用 contact/v3/users/batch_get_id：它只收应用身份，个人身份调用会被拒（99991668）。
# 姓名要完全一样、邮箱要等于他的企业邮箱或邮箱；只认本公司的人。重名或查不到的列出来、不处理。
emails = [x for x in users if "@" in x]
unions = [x for x in users if x.startswith("on_")]
found, ambiguous, unknown = {}, {}, []   # found: 姓名或邮箱 -> (open_id, 显示名, 邮箱)


def search(queries, match):
    hits, failed = {}, {}
    for k in range(0, len(queries), 20):   # 一次最多 20 个
        chunk = queries[k:k + 20]
        d = lark(["contact", "+search-user", "--queries", ",".join(chunk), "--exclude-external-users"])
        for u in d.get("users") or []:
            q = u.get("matched_query") or ""
            if q in chunk and not u.get("is_cross_tenant") and u.get("open_id") and match(q, u):
                hits.setdefault(q, []).append(u)
        failed.update({x.get("query"): x.get("error") for x in d.get("queries") or [] if x.get("error")})
    return hits, failed


def mail_of(u):
    return u.get("enterprise_email") or u.get("email") or ""


def resolve(queries, match, what):
    hits, failed = search(queries, match)
    for q in queries:
        if q in failed:
            unknown.append("%s（查询失败：%s）" % (q, str(failed[q])[:80]))
            continue
        h = list({u["open_id"]: u for u in hits.get(q) or []}.values())
        if len(h) == 1:
            found[q] = (h[0]["open_id"], h[0].get("localized_name") or q, mail_of(h[0]))
        elif len(h) > 1:
            ambiguous[q] = ["%s（%s）" % (mail_of(u) or "无邮箱", u.get("department") or "部门未知") for u in h]
        else:
            unknown.append("%s（%s）" % (q, what))


if names:
    resolve(names, lambda q, u: (u.get("localized_name") or "") == q, "按姓名查不到")
if emails:
    resolve(emails, lambda q, u: q.lower() in ((u.get("enterprise_email") or "").lower(), (u.get("email") or "").lower()), "按邮箱查不到")


def notes_of_lookup():
    out = []
    if ambiguous:
        out.append("重名、没有处理：" + "；".join("%s：%s" % (n, "、".join(v)) for n, v in ambiguous.items()) + "。请改写邮箱")
    if unknown:
        out.append("没有处理：%s" % "、".join(unknown))
    return out


if OP == "查邮箱":
    if not names:
        sys.exit("查邮箱要在「成员」里写姓名，逗号分隔")
    rows = [(n, found[n][2]) for n in names if n in found]
    lines = ["| 姓名 | 邮箱 |", "|---|---|"] + ["| %s | %s |" % (n, m or "（没有邮箱）") for n, m in rows]
    print("\n".join(lines if rows else ["没有查到唯一匹配的人。"]) + ("\n\n" + "\n".join(notes_of_lookup()) if notes_of_lookup() else ""))
    sys.exit(0)

opens = list(dict.fromkeys(v[0] for v in found.values()))
unions = list(dict.fromkeys(unions))


def add_members(chat, ids, id_type):
    """拉人进群；返回 (成功数, 没拉进去的, 待审批的)。"""
    if not ids:
        return 0, [], []
    d = api("POST", "/open-apis/im/v1/chats/%s/members" % chat, {"member_id_type": id_type, "succeed_type": 1}, {"id_list": ids})
    failed = sorted(set((d.get("invalid_id_list") or []) + (d.get("not_existed_id_list") or [])))
    pending = d.get("pending_approval_id_list") or []
    return len(ids) - len(failed) - len(pending), failed, pending


def who(i):
    """把 id 换回名字，方便看。"""
    for q, v in found.items():
        if v[0] == i:
            return v[1]
    return i


def member_notes(failed, pending):
    out = []
    if failed:
        out.append("没拉进去：%s（可能已离职、和你不可见或 id 不对）" % "、".join(who(x) for x in failed))
    if pending:
        out.append("等群主或管理员审批：%s" % "、".join(who(x) for x in pending))
    return out


def op_create():
    if not NAME:
        sys.exit("建群要填群名")
    body = {"name": NAME[:60], "chat_mode": "group", "chat_type": "private"}
    if DESC:
        body["description"] = DESC[:100]
    if opens:
        body["user_id_list"] = opens
    if bots:
        body["bot_id_list"] = bots
    d = api("POST", "/open-apis/im/v1/chats", {"user_id_type": "open_id", "set_bot_manager": False}, body)
    cid = d.get("chat_id") or ""
    bad = d.get("invalid_user_id_list") or []
    n, failed, pending = add_members(cid, unions, "union_id") if cid else (0, unions, [])   # union_id 的人建好群后再拉
    lines = ["**已建群「%s」**：`%s`" % (d.get("name") or NAME, cid),
             "群主是你；拉进 %d 个人、%d 个机器人。" % (len(opens) - len(bad) + n, len(bots))]
    return lines + member_notes(list(bad) + failed, pending)


def op_add():
    if not re.fullmatch(r"oc_[0-9a-zA-Z]+", CHAT):
        sys.exit("拉人要在「群」里写群的 chat_id（oc_…）")
    if not opens and not unions and not bots:
        sys.exit("没有要拉的人或机器人" + ("：" + "；".join(notes_of_lookup()) if notes_of_lookup() else ""))
    total, failed, pending = 0, [], []
    for ids, t in ((opens, "open_id"), (unions, "union_id"), (bots, "app_id")):
        n, f, p = add_members(CHAT, ids, t)
        total, failed, pending = total + n, failed + f, pending + p
    return ["**已拉人进群** `%s`：成功 %d 个。" % (CHAT, total)] + member_notes(failed, pending)


# 操作清单：名字 -> 函数。加新操作只在这里加一项（参数在 app.json 里声明，op 的取值同步加上）。
OPS = {"建群": op_create, "拉人": op_add, "查邮箱": None}   # 查邮箱在上面处理
if OP not in OPS:
    sys.exit("不认识的操作「%s」，现在支持：%s" % (OP, "、".join(OPS)))
lines = OPS[OP]()
named = [(q, v) for q, v in found.items() if "@" not in q]
if named:
    lines.append("按姓名找到：%s" % "、".join("%s（%s）" % (q, v[2] or "无邮箱") for q, v in named))
lines += notes_of_lookup()
print("\n".join(lines))
