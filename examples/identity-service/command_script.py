# 固化指令的脚本：以执行人的身份查「我能看到的销售额」。
# 它在 Amber 的沙盒里运行：只能用 Python 标准库，不能上外网，只能连声明过的服务。
import json, sys, urllib.request

inp = json.load(sys.stdin)
svc = inp["services"]["demo-profile"]          # Amber 为本次执行签发的凭证和服务地址
req = urllib.request.Request(
    f"http://127.0.0.1:{svc['tcpPort']}/sales",
    headers={"Authorization": "Amber " + svc["tokens"][0]},   # 每次请求用一张，每张只能用一次
)
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 本机服务，不走代理
try:
    with opener.open(req, timeout=10) as r:
        data = json.load(r)
except urllib.error.HTTPError as e:
    # 写到标准错误并以非 0 退出：Amber 把它当作执行失败，并把这句话显示给执行人
    sys.exit("服务拒绝了请求：" + json.loads(e.read().decode("utf-8")).get("error", str(e.code)))

rows = data["rows"]
if not rows:
    print("你没有任何区域的数据权限。")
    sys.exit(0)

print(f"**你能看到的区域**：{'、'.join(data['regions'])}\n")
print("```table")
print(json.dumps({
    "columns": [
        {"name": "region", "label": "区域", "type": "text"},
        {"name": "month", "label": "月份", "type": "text"},
        {"name": "amount", "label": "销售额", "type": "number"},
    ],
    "rows": rows,
}, ensure_ascii=False))
print("```")
