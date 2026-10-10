# -*- coding: utf-8 -*-
# Generates the diagrams in docs/assets/*.svg (dark, matching the docs site). Edit here, then run:
#   python3 scripts/docs-diagrams.py
import sys, os
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'docs', 'assets')
BG, CARD, LINE, INK, MUTED, ACC = '#181818', '#262626', '#4a4a4a', '#ffffff', '#a8a8a8', '#f2a23a'
FONT = "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif"

def esc(s): return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

class D:
    def __init__(s, w, h, title):
        s.w, s.h, s.el = w, h, []
        s.title = title
    def box(s, x, y, w, h, title, lines=(), accent=False, dashed=False):
        st = f'stroke="{ACC if accent else LINE}" stroke-width="{2 if accent else 1.2}"' + (' stroke-dasharray="5 4"' if dashed else '')
        s.el.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{CARD}" {st}/>')
        n = len(lines)
        ty = y + h / 2 - (n * 20) / 2 + (6 if n else 6)
        s.text(x + w / 2, ty, title, 17, INK, 600)
        for i, l in enumerate(lines):
            s.text(x + w / 2, ty + 23 + i * 21, l, 14, MUTED)
    def region(s, x, y, w, h, label):
        s.el.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="none" stroke="{LINE}" stroke-dasharray="4 4"/>')
        s.text(x + 12, y + 20, label, 12, MUTED, 600, 'start')
    def text(s, x, y, t, size=13, color=INK, weight=400, anchor='middle'):
        s.el.append(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}" text-anchor="{anchor}">{esc(t)}</text>')
    def arrow(s, pts, label=None, lx=None, ly=None, color=ACC, anchor='middle'):
        d = 'M' + ' L'.join(f'{x} {y}' for x, y in pts)
        s.el.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="1.6" marker-end="url(#ah)"/>')
        if label:
            if lx is None:
                (x1, y1), (x2, y2) = pts[0], pts[-1]
                lx, ly = (x1 + x2) / 2, min(y1, y2) - 8
            s.text(lx, ly, label, 13, MUTED, 400, anchor)
    def save(s, name):
        svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {s.w} {s.h}" width="{s.w}" height="{s.h}" font-family="{FONT}" role="img" aria-label="{esc(s.title)}">'
               f'<title>{esc(s.title)}</title>'
               f'<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{ACC}"/></marker></defs>'
               f'<rect width="100%" height="100%" fill="{BG}"/>' + ''.join(s.el) + '</svg>\n')
        open(os.path.join(OUT, name), 'w', encoding='utf-8').write(svg)

# 1. 应用的生命周期
d = D(960, 430, '应用的生命周期：草稿经认领、试运行和审核后生效；生效的应用可以执行、定时、设置配置项和密钥、分享')
y, h = 40, 76
d.box(30, y, 150, h, '草稿', ['agent 写的脚本和参数'])
d.box(260, y, 170, h, '认领与试运行', ['创建人负责'])
d.box(510, y, 150, h, '审核', ['全部审核人同意'])
d.box(740, y, 190, h, '生效的应用', ['代码按哈希锁定'], accent=True)
d.arrow([(180, y + h / 2), (258, y + h / 2)], 'agent 提交')
d.arrow([(430, y + h / 2), (508, y + h / 2)], '提交审核')
d.arrow([(660, y + h / 2), (738, y + h / 2)], '通过')
d.text(595, y + h + 24, '驳回后改好，用同一个名字重新提交', 13, MUTED)
# fan out
bx, by, bw, bh = [30, 260, 490, 720], 250, 210, 140
cx = 835
d.el.append(f'<path d="M{cx} {y + h} L{cx} 200 L{bx[0] + bw / 2} 200" fill="none" stroke="{ACC}" stroke-width="1.6"/>')
for x in bx:
    d.arrow([(x + bw / 2, 200), (x + bw / 2, by - 2)])
d.box(bx[0], by, bw, bh, '执行', ['飞书、网站、agent', '以执行人的身份'])
d.box(bx[1], by, bw, bh, '定时任务', ['按时间自动执行', '以创建人的身份', '没有输出就不发消息'])
d.box(bx[2], by, bw, bh, '配置项和密钥', ['创建人设置一次', '每次执行自动带上', '新版本沿用，下线删除'])
d.box(bx[3], by, bw, bh, '分享', ['复制给同群的人', '上架到 Store 后安装', '全局应用', '重新分配'])
d.save('lifecycle.svg')

# 2. 执行位置
d = D(960, 300, '执行位置：不写运行环境的应用在 Amber 本机沙箱运行，看不到业务数据；写了 env 的应用在执行端上、按运行环境的权限在沙箱里运行')
d.box(30, 110, 170, 80, '应用', ['审核过的代码'], accent=True)
d.box(300, 30, 300, 80, 'Amber 本机的沙箱', ['只有本次运行的临时目录', '看不到任何业务数据'])
d.region(300, 150, 630, 130, '数据所在的机器')
d.box(320, 185, 170, 80, '执行端', ['验签、核对代码哈希'])
d.box(530, 185, 180, 80, '运行环境', ['管理员批准的路径'])
d.box(750, 185, 160, 80, '沙箱', ['能访问环境里的数据'])
d.arrow([(200, 135), (250, 135), (250, 70), (298, 70)], '不写 env', 225, 60, anchor='middle')
d.arrow([(200, 165), (250, 165), (250, 225), (318, 225)], '写了 env', 225, 245, anchor='middle')
d.arrow([(490, 225), (528, 225)])
d.arrow([(710, 225), (748, 225)])
d.save('run-location.svg')

# 3. 执行端的工作方式
d = D(960, 290, '执行端的工作方式：执行端主动连接 Amber；Amber 把签名并加密的任务发给执行端，执行端验签、核对代码哈希后按运行环境的权限执行，把遮盖了密钥的结果返回')
d.box(40, 70, 230, 150, 'Amber', ['保存审核过的应用', '签名任务，用执行端的', '公钥加密代码、参数、密钥'], accent=True)
d.region(560, 30, 370, 240, '数据所在的机器')
d.box(590, 70, 310, 150, '执行端', ['验签、核对收件人和有效期', '重新计算代码哈希并比对', '按运行环境的权限在沙箱里执行'])
d.arrow([(272, 110), (588, 110)], '签名 + 加密的任务')
d.arrow([(588, 180), (272, 180)], '结果（密钥已遮盖）', 430, 172)
d.text(300, 250, '连接由执行端发起，执行端那台机器不用开端口', 13, MUTED)
d.save('executor-flow.svg')

# 4. 可信身份示例的调用流程
d = D(960, 330, '可信身份的调用流程：执行人点执行，Amber 为执行人签发凭证并在沙盒里运行脚本，脚本带凭证调用服务，服务验签后按执行人的权限返回数据')
xs, w, y, h = [20, 260, 500, 740], 200, 70, 110
d.box(xs[0], y, w, h, '执行人', ['在飞书或网站点「执行」', '身份来自飞书'])
d.box(xs[1], y, w, h, 'Amber', ['核对应用版本', '签发凭证', 'sub = 执行人'], accent=True)
d.box(xs[2], y, w, h, '应用脚本', ['在沙盒里运行', '只能连这个服务的端口'])
d.box(xs[3], y, w, h, '服务', ['验证签名、服务名、', '有效期、一次性编号', '按 sub 判断权限'])
for i, lab in enumerate(['① 执行', '② 凭证和端口', '③ Authorization: Amber <凭证>']):
    d.arrow([(xs[i] + w + 2, y + 40), (xs[i + 1] - 2, y + 40)])
    d.text((xs[i] + w + xs[i + 1]) / 2, y - 12 if i < 2 else y - 12, lab, 13, MUTED)
by = y + h + 60
d.arrow([(xs[3] + w / 2, y + h + 2), (xs[3] + w / 2, by), (xs[2] + w / 2, by), (xs[2] + w / 2, y + h + 4)], '④ 有权限的数据', (xs[2] + xs[3] + w) / 2, by - 8)
d.arrow([(xs[2] + w / 2 - 30, y + h + 4), (xs[2] + w / 2 - 30, by + 50), (xs[0] + w / 2, by + 50), (xs[0] + w / 2, y + h + 4)], '⑤ Amber 把结果显示给执行人', (xs[0] + xs[2] + w) / 2, by + 42)
d.save('identity-flow.svg')
print('ok')
