# 我的飞书数据：以执行人本人的飞书身份只读地取数据，结果交给发起请求的 agent（amber read）。
# 只调用读接口；不发消息、不改文档、不动邮件。
import html, json, os, re, subprocess, sys, time
from datetime import datetime, timedelta, timezone

inp = json.load(sys.stdin)
P = inp.get("params") or {}
OP = (P.get("op") or "").strip()
Q = (P.get("q") or "").strip()
HOURS = int(P.get("hours") or 24)
LIMIT = int(P.get("limit") or 30)
LU = inp["larkUser"]
CLI = LU.get("cli") or "lark-cli"
ENV = {**os.environ, **LU["env"]}

MAX_OUT = 60000      # 交给 agent 的最多字数（读邮件、读文档、读妙记）
LIST_MAX = 25000     # 列表类操作的最多字数：agent 那边单次命令输出约 3 万字就会被截掉或折叠，超出的它多半看不到
ITEM_MAX = 2000      # 单条消息、单封邮件摘要的最多字数
REPLY_MAX = 500      # 搜消息带回的单条话题回复的最多字数
THREADS_MAX = 10     # 搜消息最多展开几个话题
REPLIES_MAX = 20     # 每个话题最多带几条回复
THREAD_BUDGET = int(os.environ.get("MLD_THREAD_BUDGET") or 140)  # 从脚本启动算，超过这么多秒不再展开话题（脚本整体超时 180 秒）
T0 = time.monotonic()
TZ = timezone(timedelta(hours=8))
now = datetime.now(TZ)
start = now - timedelta(hours=HOURS)


AUTH_HINT = "请私聊 Amber 发「授权飞书」（或点私聊菜单「授权飞书」）重新授权一次，再试"
MISSING = LU.get("missingScopes") or []   # Amber 新开通、但本人授权里还没有的权限


def parse_json(text):
    try:
        return json.loads(text)
    except Exception:
        i = (text or "").find("{")
        try:
            return json.JSONDecoder().raw_decode(text[i:])[0] if i >= 0 else None
        except Exception:
            return None


def fail(args, err):
    """A short, actionable reason: missing permissions say so (with what to do), the rest gives code and message."""
    e = err if isinstance(err, dict) else {}
    scopes = e.get("missing_scopes") or []
    text = json.dumps(e, ensure_ascii=False)
    if e.get("type") == "authorization" or scopes or "scope" in text.lower() or e.get("code") in (99991679, 99991672, 99991663):
        need = "、".join(scopes) or "、".join(MISSING)
        sys.exit("缺少飞书权限%s，读不了（%s）。%s" % ("（%s）" % need if need else "", " ".join(args[:2]), AUTH_HINT))
    msg = e.get("message") or e.get("msg") or text
    sys.exit("lark-cli %s 失败：%s %s" % (" ".join(args[:2]), e.get("code") or "", str(msg)[:300]))


def lark(args, timeout=150):
    r = subprocess.run([CLI] + args + ["--as", "user"], env=ENV, capture_output=True, text=True, timeout=timeout)
    out = parse_json(r.stdout)
    if not isinstance(out, dict):
        # lark-cli 出错时常把 JSON 写到 stderr：整段解析，不能只截尾巴
        err = parse_json(r.stderr)
        if isinstance(err, dict):
            fail(args, err.get("error") or err)
        sys.exit("lark-cli %s 失败：%s" % (" ".join(args[:2]), (r.stderr or r.stdout).strip()[-300:]))
    if r.returncode != 0 or out.get("ok") is False:
        fail(args, out.get("error") or out)
    return out.get("data", out)


def clean(text, limit=ITEM_MAX):
    t = text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
    t = re.sub(r"!\[[^\]]*\]\([^)]*\)", "[图片]", t or "")
    t = re.sub(r'<file [^>]*name="([^"]*)"[^>]*/?>', r"[文件 \1]", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t[:limit] + "…" if len(t) > limit else t


def first(d, *keys):
    for k in keys:
        v = d.get(k) if isinstance(d, dict) else None
        if v not in (None, "", [], {}):
            return v
    return None


def items(d, *keys):
    """The list in a lark-cli result, whichever key it is under."""
    if isinstance(d, list):
        return d
    for k in keys + ("items", "messages", "chats", "data"):
        v = d.get(k) if isinstance(d, dict) else None
        if isinstance(v, list):
            return v
    return []


def addr(v):
    """Mail addresses as 「名字 <邮箱>」, whatever shape lark-cli returns (string, object, or a list of them)."""
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        a = v.get("mail_address") or v.get("address") or v.get("email") or ""
        n = v.get("name") or v.get("display_name") or ""
        return ("%s <%s>" % (n, a)) if n and a else (a or n)
    if isinstance(v, list):
        return "、".join(x for x in (addr(i) for i in v) if x)
    return str(v)


def item_text(x, *keys):
    """The text of a list item that may be a string or an object (todos, chapters)."""
    if isinstance(x, dict):
        x = first(x, *keys) or ""
    return x if isinstance(x, str) else ""


def walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)


def minute_items(data):
    """Minutes in a minutes +search result: token, title, time line and link (same parsing as the 拉前采妙记 app)."""
    out = {}
    for o in walk(data):
        meta = o.get("meta_data") if isinstance(o.get("meta_data"), dict) else {}
        link = meta.get("app_link") if isinstance(meta.get("app_link"), str) else ""
        tok = o.get("token") if isinstance(o.get("token"), str) else (re.search(r"/minutes/([a-z0-9]{20,})", link) or [None, None])[1]
        raw = o.get("display_info") if isinstance(o.get("display_info"), str) else ""
        info = html.unescape(re.sub(r"<[^>]+>", "", html.unescape(raw)))
        if not tok or not info:
            continue
        lines_ = [x.strip() for x in info.split("\n") if x.strip()]
        when = next((x for x in lines_ if "时间" in x), "")
        out[tok] = {"title": lines_[0] if lines_ else tok, "when": when, "url": link or ""}
    return out


def who(m):
    s = m.get("sender") or {}
    name = s.get("name") or s.get("sender_name") or m.get("sender_name") or "?"
    return name + ("(机器人)" if s.get("sender_type") == "app" else "")


def msg_line(m, indent="", limit=ITEM_MAX):
    if m.get("deleted") or m.get("msg_type") in ("system", "sticker"):
        return None
    chat = first(m, "chat_name") or (m.get("chat") or {}).get("name") or ""
    t = (m.get("create_time") or "")[:16]
    return "%s- %s %s%s：%s" % (indent, t, ("[%s] " % chat) if chat else "", who(m), clean(m.get("content"), limit))


def thread_lines(tid, hit_id, shown, timeout):
    """The other messages in a hit's thread (the root and its replies), indented under the hit.
    Search only returns messages that contain the keyword; a reply like 「给 Wade」 under 「要加白名单」 would be lost."""
    try:
        d = lark(["im", "+threads-messages-list", "--thread", tid, "--order", "asc", "--no-reactions", "--page-size", str(REPLIES_MAX + 1)], timeout=timeout)
    except SystemExit as e:
        return ["  ↳ （话题回复没读到：%s）" % clean(str(e.code), 200)]
    except subprocess.TimeoutExpired:
        return ["  ↳ （话题回复没读到：超时）"]
    rs = [r for r in items(d) if r.get("message_id") != hit_id]
    more = len(rs) > REPLIES_MAX or (isinstance(d, dict) and d.get("has_more"))
    out = []
    for r in rs[:REPLIES_MAX]:
        shown.add(r.get("message_id"))
        y = msg_line(r, "  ↳ ", REPLY_MAX)
        if y:
            out.append(y)
    if more:
        out.append("  ↳ （话题里还有更多回复没显示，可以用「会话记录」查这个群）")
    return out


lines = []
if OP == "搜消息":
    if not Q:
        sys.exit("搜消息要在「内容」里写关键词")
    d = lark(["im", "+messages-search", "--query", Q, "--start", start.isoformat(timespec="seconds"), "--end", now.isoformat(timespec="seconds"),
              "--no-reactions", "--page-size", str(min(LIMIT, 50))] + (["--page-limit", str((LIMIT + 49) // 50)] if LIMIT > 50 else []))
    ms = items(d)[:LIMIT]
    lines.append("# 搜消息「%s」（过去 %d 小时，%d 条；命中的消息在话题里时，话题里的其他消息缩进列在下面）" % (Q, HOURS, len(ms)))
    threads, shown = set(), set()
    for m in ms:
        if m.get("message_id") in shown:   # 已经作为前面某个话题的回复列出过
            continue
        x = msg_line(m)
        if not x:
            continue
        lines.append(x + ("  `%s`" % m["message_id"] if m.get("message_id") else ""))
        tid = m.get("thread_id")
        if not tid or tid in threads:
            continue
        threads.add(tid)
        left_s = THREAD_BUDGET - (time.monotonic() - T0)
        if len(threads) > THREADS_MAX or left_s < 5:
            lines.append("  ↳ （这条在话题里，回复没展开：可以用「会话记录」查这个群，或换更具体的关键词）")
            continue
        lines += thread_lines(tid, m.get("message_id"), shown, min(30, left_s))
elif OP == "会话记录":
    if not re.match(r"^(oc|ou)_[A-Za-z0-9]+$", Q):
        sys.exit("会话记录要在「内容」里写群的 oc_… 或私聊对方的 ou_…（可以先用「找会话」查）")
    d = lark(["im", "+chat-messages-list", "--chat-id" if Q.startswith("oc_") else "--user-id", Q, "--start", start.isoformat(timespec="seconds"),
              "--end", now.isoformat(timespec="seconds"), "--order", "desc", "--no-reactions", "--page-size", str(min(LIMIT, 50))]
             + (["--page-all", "--page-limit", str((LIMIT + 49) // 50)] if LIMIT > 50 else []), timeout=170)
    ms = list(reversed(items(d)[:LIMIT]))
    lines.append("# 会话记录 %s（过去 %d 小时，最近 %d 条，按时间正序）" % (Q, HOURS, len(ms)))
    for m in ms:
        x = msg_line(m)
        if x:
            lines.append(x)
        for r in m.get("thread_replies") or []:
            if r.get("message_id") != m.get("message_id"):
                y = msg_line(r, "  ↳ ")
                if y:
                    lines.append(y)
elif OP == "找会话":
    if Q:
        d = lark(["im", "+chat-search", "--query", Q, "--page-size", str(min(LIMIT, 50))])
    else:
        d = lark(["im", "+chat-list", "--types", "group,p2p", "--page-size", str(min(LIMIT, 100))])
    cs = items(d)[:LIMIT]
    lines.append("# 会话（%s，%d 个）" % ("名称含「%s」" % Q if Q else "我参与的", len(cs)))
    for c in cs:
        lines.append("- %s `%s`%s" % (first(c, "name", "chat_name") or "（未命名）", first(c, "chat_id") or "?", "（外部）" if c.get("external") else ""))
elif OP == "搜邮件":
    d = lark(["mail", "+triage", "--format", "json", "--max", str(LIMIT)] + (["--query", Q[:50]] if Q else []))
    ms = items(d)[:LIMIT]
    lines.append("# 邮件%s（%d 封）" % ("「%s」" % Q if Q else "（收件箱最近）", len(ms)))
    for m in ms:
        lines.append("- %s · %s · %s  `%s`" % (m.get("date") or "", clean(addr(m.get("from") or ""), 120), clean(m.get("subject") or "（无主题）", 200), m.get("message_id") or "?"))
elif OP == "读邮件":
    if not Q:
        sys.exit("读邮件要在「内容」里写邮件 id（可以先用「搜邮件」查）")
    d = lark(["mail", "+message", "--message-id", Q, "--html=false"])
    m = d.get("message", d) if isinstance(d, dict) else {}
    lines.append("# 邮件：%s" % clean(first(m, "subject") or "（无主题）", 300))
    for k, label in (("from", "发件人"), ("to", "收件人"), ("cc", "抄送"), ("date", "时间")):
        v = first(m, k, k + "_address", k + "_addresses")
        if v:
            lines.append("- %s：%s" % (label, clean(addr(v), 500)))
    body = first(m, "body_plain_text", "body_text", "plain_text", "text", "body", "content")
    lines.append("")
    lines.append(clean(body, MAX_OUT) if body else "（没有正文）")
    att = first(m, "attachments")
    if att:
        lines.append("\n附件：" + "、".join(clean(first(a, "filename", "name") or "?", 100) for a in att if isinstance(a, dict)))
elif OP == "搜妙记":
    # 我拥有的和我参与的，分开查再合并（接口对两个条件同时给的语义不确定）。
    found = {}
    for flag in ("--owner-ids", "--participant-ids"):
        page = None
        for _ in range(4):   # 每页最多 30 条，翻到够「最多条数」为止
            args = ["minutes", "+search", flag, "me", "--start", start.isoformat(timespec="seconds"), "--end", now.isoformat(timespec="seconds"), "--page-size", "30"]
            if Q:
                args += ["--query", Q[:50]]
            if page:
                args += ["--page-token", page]
            d = lark(args)
            found.update(minute_items(d))
            page = d.get("page_token") if isinstance(d, dict) and d.get("has_more") else None
            if not page or len(found) >= LIMIT:
                break
    items = list(found.items())[:LIMIT]
    lines.append("# 妙记%s（过去 %d 小时，%d 条）" % ("「%s」" % Q if Q else "", HOURS, len(items)))
    for tok, v in items:
        lines.append("- %s · %s  `%s`%s" % (clean(v["title"], 200), v["when"], tok, ("  " + v["url"]) if v["url"] else ""))
elif OP == "读妙记":
    # 只认整个妙记 token，或链接里 /minutes/ 后面那一段（只有小写字母和数字，拼进接口路径也安全）。
    m = re.fullmatch(r"([a-z0-9]{20,64})", Q or "") or re.search(r"/minutes/([a-z0-9]{20,64})(?:[/?#].*)?$", Q or "")
    if not m:
        sys.exit("读妙记要在「内容」里写妙记链接或 token（可以先用「搜妙记」查）")
    tok = m.group(1)
    d = lark(["minutes", "+detail", "--minute-tokens", tok, "--summary", "--todo", "--chapter"])
    mm = next((x for x in walk(d) if isinstance(x, dict) and x.get("minute_token") == tok), {})
    art = mm.get("artifacts") or {}
    lines.append("# 妙记：%s\n" % clean(mm.get("title") or tok, 300))
    if isinstance(art.get("summary"), str) and art["summary"].strip():
        lines.append("## 总结\n" + clean(art["summary"], 8000))
    todos = [t for t in (item_text(x, "content", "text", "title") for x in art["todos"]) if t] if isinstance(art.get("todos"), list) else []
    chapters = [c for c in (item_text(x, "title", "content", "summary") for x in art["chapters"]) if c] if isinstance(art.get("chapters"), list) else []
    if todos:
        lines.append("## 待办\n" + "\n".join("- " + clean(t, 500) for t in todos))
    if chapters:
        lines.append("## 章节\n" + "\n".join("- " + clean(c, 300) for c in chapters))
    # 逐字稿：落到本次运行的临时目录再读（同「拉前采妙记」），读完删掉。
    name = "transcript-%s.txt" % tok
    try:
        r = subprocess.run([CLI, "api", "GET", "/open-apis/minutes/v1/minutes/%s/transcript" % tok, "--params",
                            json.dumps({"need_speaker": True, "need_timestamp": False, "file_format": "txt"}), "-o", name, "--as", "user"],
                           env=ENV, capture_output=True, text=True, timeout=150)
        if os.path.exists(name):
            with open(name, encoding="utf-8", errors="replace") as f:
                text = f.read().strip()
            lines.append("## 逐字稿\n" + (text or "（空）"))
        else:
            lines.append("## 逐字稿\n（读取失败：%s）" % clean(r.stdout or r.stderr, 300))
    finally:
        if os.path.exists(name):
            os.remove(name)
elif OP == "读文档":
    if not Q:
        sys.exit("读文档要在「内容」里写文档链接或 token")
    d = lark(["docs", "+fetch", "--doc", Q, "--doc-format", "markdown"])
    doc = d.get("document", d) if isinstance(d, dict) else {}
    title = first(doc, "title") or first(d, "title") or Q
    text = first(doc, "content", "markdown") or first(d, "content", "markdown") or ""
    lines.append("# 文档：%s\n" % title)
    lines.append(text if isinstance(text, str) else json.dumps(text, ensure_ascii=False))

out = "\n".join(lines)
if OP in ("搜消息", "会话记录", "找会话", "搜邮件", "搜妙记") and len(out) > LIST_MAX:
    # 按整行截，并说清还剩几条，不让 agent 以为看到的就是全部。
    n, size = 0, 0
    while n < len(lines) and size + len(lines[n]) + 1 <= LIST_MAX:
        size += len(lines[n]) + 1
        n += 1
    left = sum(1 for x in lines[n:] if x.startswith("- "))
    out = "\n".join(lines[:n]) + "\n\n（输出已到 %d 字上限，后面还有 %d 条没显示。换更具体的关键词、缩短回看小时数或减少条数再查）" % (LIST_MAX, left)
elif len(out) > MAX_OUT:
    out = out[:MAX_OUT] + "\n\n（超过 %d 字，后面的已截断；可以缩小时间范围、条数，或换更具体的关键词）" % MAX_OUT
print(out)
