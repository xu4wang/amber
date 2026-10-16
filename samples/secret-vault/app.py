import json, sys

# 密钥保管箱：只用来存放。执行时列出说明和每个 KEY 是否已填，从不输出值。
# 取用：agent 运行 amber secret get 密钥保管箱 KEYn --user <你的邮箱> --out <文件>，你在私聊确认卡上允许后写进那台机器的文件。
inp = json.load(sys.stdin)
note = (inp.get("params") or {}).get("note") or ""
have = set((inp.get("secrets") or {}).keys())
names = ["KEY%d" % i for i in range(1, 11)]
print("**密钥保管箱**\n")
print("说明：%s\n" % (note.strip() or "（还没写。可以在网站这个应用页面底部的「配置项」里写明每个 KEY 是什么，比如：KEY1=gitlab 令牌，KEY2=数据库只读账号）"))
print("| 密钥 | 状态 |\n|---|---|")
for n in names:
    print("| %s | %s |" % (n, "已填" if n in have else "未填"))
print("\n取用：让你的 agent 运行 `amber secret get 密钥保管箱 KEYn --user 你的邮箱 --out 文件路径`，你在私聊确认卡上点「允许」后，值直接写进那台机器上的文件（权限 600），不会出现在聊天里。")
