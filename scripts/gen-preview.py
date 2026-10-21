# -*- coding: utf-8 -*-
"""
生成产品预览图：左「检测工具」、右「输入守卫（含扩展在社交平台弹窗的效果）」。
纯 PIL 手绘，不依赖浏览器截图，可重复生成。
输出：前端/icons/preview-products.png、前端/icons/og-guard.png
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = r"C:\Users\26067\OneDrive\Desktop\检测系统"
OUT_ICONS = os.path.join(ROOT, "前端", "icons")

F_REG = r"C:\Windows\Fonts\msyh.ttc"
F_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"

BG = (245, 247, 250)
PANEL = (255, 255, 255)
LINE = (228, 231, 236)
INK = (31, 36, 48)
SUB = (102, 112, 133)
FAINT = (152, 162, 179)
PRIMARY = (21, 112, 239)
FIELD = (247, 248, 250)
L1 = (220, 182, 10)
L2 = (247, 144, 9)
L3 = (224, 79, 47)
L4 = (217, 45, 32)


def f(sz, bold=False):
    return ImageFont.truetype(F_BOLD if bold else F_REG, sz)


def rr(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def tw(d, xy, text, font, fill):
    d.text(xy, text, font=font, fill=fill)


def wrap(d, xy, text, font, fill, max_w, line_gap=6):
    """按像素宽度折行，返回占用的总高度。"""
    x, y = xy
    line = ""
    for ch in text:
        if d.textlength(line + ch, font=font) > max_w and line:
            d.text((x, y), line, font=font, fill=fill)
            y += font.size + line_gap
            line = ch
        else:
            line += ch
    if line:
        d.text((x, y), line, font=font, fill=fill)
        y += font.size + line_gap
    return y - xy[1]


def badge(d, x, y, text, bg, size=11):
    font = f(size, bold=True)
    w = d.textlength(text, font=font) + 14
    rr(d, [x, y, x + w, y + 18], 9, fill=bg)
    d.text((x + 7, y + 2), text, font=font, fill=(255, 255, 255))
    return w


def logo(d, cx, cy, r, bg, text="PS"):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=bg)
    font = f(r, bold=True)
    w = d.textlength(text, font=font)
    d.text((cx - w / 2, cy - r * 0.62), text, font=font, fill=(255, 255, 255))


def card_header(d, x, y, w, color, title, sub):
    logo(d, x + 26, y + 30, 20, color)
    tw(d, (x + 56, y + 16), title, f(17, True), INK)
    tw(d, (x + 56, y + 40), sub, f(12), SUB)
    d.line([(x + 20, y + 68), (x + w - 20, y + 68)], fill=LINE, width=1)


def main():
    os.makedirs(OUT_ICONS, exist_ok=True)
    W, H = 1200, 820
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 标题
    tw(d, (48, 34), "隐私哨兵 · 两个独立产品", f(26, True), INK)
    tw(d, (48, 72), "左边负责「发之前想清楚」，右边负责「写的时候别手滑」——需要哪个用哪个，也能一起用",
       f(13), SUB)

    # ---------------- 左卡：检测工具 ----------------
    lx, ly, lw, lh = 48, 112, 520, 640
    rr(d, [lx, ly, lx + lw, ly + lh], 16, fill=PANEL, outline=LINE)
    card_header(d, lx, ly, lw, PRIMARY, "隐私哨兵 · 检测工具", "粘贴 / 上传 → 出一份可导出的报告")

    # 输入框
    rr(d, [lx + 28, ly + 88, lx + lw - 28, ly + 178], 10, fill=FIELD, outline=LINE)
    wrap(d, (lx + 44, ly + 104),
         "我叫张三，身份证 11010519491231002X，手机号 13800138000，"
         "卡号 4111111111111111，邮箱 zhangsan@example.com",
         f(13), INK, lw - 88)

    # 按钮
    rr(d, [lx + 28, ly + 194, lx + 148, ly + 228], 8, fill=PRIMARY)
    tw(d, (lx + 52, ly + 203), "开始检测", f(13, True), (255, 255, 255))
    rr(d, [lx + 160, ly + 194, lx + 268, ly + 228], 8, fill=PANEL, outline=LINE)
    tw(d, (lx + 182, ly + 203), "批量检测", f(13), INK)
    rr(d, [lx + 280, ly + 194, lx + 388, ly + 228], 8, fill=PANEL, outline=LINE)
    tw(d, (lx + 302, ly + 203), "检测规则", f(13), INK)

    tw(d, (lx + 28, ly + 248), "检测结果 · 4 处风险 · 评分 62 中危", f(13, True), INK)

    rows = [
        ("L3", "API 密钥", "sk-****3456", L3),
        ("L2", "银行卡号", "4111 **** **** 1111", L2),
        ("L1", "身份证号", "110105********02X", L1),
        ("L1", "手机号", "138****8000", L1),
    ]
    ry = ly + 274
    for tag, name, val, color in rows:
        rr(d, [lx + 28, ry, lx + lw - 28, ry + 52], 10, fill=PANEL, outline=LINE)
        d.rectangle([lx + 28, ry, lx + 31, ry + 52], fill=color)
        badge(d, lx + 44, ry + 8, tag, color)
        tw(d, (lx + 44 + 34, ry + 8), name, f(13, True), INK)
        tw(d, (lx + 44, ry + 29), val, f(12), SUB)
        tw(d, (lx + lw - 130, ry + 17), "整改建议 ›", f(12), PRIMARY)
        ry += 60

    # 导出
    rr(d, [lx + 28, ly + 526, lx + 150, ly + 560], 8, fill=PRIMARY)
    tw(d, (lx + 50, ly + 535), "复制脱敏文本", f(12, True), (255, 255, 255))
    rr(d, [lx + 162, ly + 526, lx + 268, ly + 560], 8, fill=PANEL, outline=LINE)
    tw(d, (lx + 186, ly + 535), "导出 JSON", f(12), INK)
    rr(d, [lx + 280, ly + 526, lx + 390, ly + 560], 8, fill=PANEL, outline=LINE)
    tw(d, (lx + 304, ly + 535), "复制报告", f(12), INK)
    tw(d, (lx + 28, ly + 578), "本地模式：原文不出浏览器 · 可切云端 AI 语义识别", f(11.5), FAINT)

    # ---------------- 右卡：输入守卫 ----------------
    rx, ry0, rw = 632, 112, 520
    rr(d, [rx, ry0, rx + rw, ry0 + lh], 16, fill=PANEL, outline=LINE)
    card_header(d, rx, ry0, rw, (6, 118, 71), "隐私哨兵 · 输入守卫", "边写边提醒 → 一键脱敏（任意网站生效）")

    # 模拟社交平台发布器
    rr(d, [rx + 28, ry0 + 88, rx + rw - 28, ry0 + 250], 12, fill=FIELD, outline=LINE)
    d.ellipse([rx + 44, ry0 + 104, rx + 76, ry0 + 136], fill=(83, 177, 253))
    tw(d, (rx + 44 + 8, ry0 + 110), "我", f(13, True), (255, 255, 255))
    tw(d, (rx + 88, ry0 + 106), "微博用户", f(13, True), INK)
    tw(d, (rx + 88, ry0 + 126), "正在公开发布 · 所有人可见", f(11), SUB)

    rr(d, [rx + 44, ry0 + 148, rx + rw - 44, ry0 + 232], 8, fill=PANEL, outline=LINE)
    # 显式分两行，避免号码被折行切断（读者会误以为是排版错误）
    tw(d, (rx + 58, ry0 + 162), "刚换号，有事打我电话 13800138000", f(13), INK)
    tw(d, (rx + 58, ry0 + 190), "身份证 11010519491231002X，急！", f(13), INK)

    # 浮动提醒条
    tx, ty = rx + 44, ry0 + 264
    rr(d, [tx, ty, tx + 360, ty + 196], 12, fill=PANEL, outline=LINE)
    d.rectangle([tx, ty, tx + 4, ty + 196], fill=L3)
    badge(d, tx + 18, ty + 14, "L3", L3)
    tw(d, (tx + 56, ty + 14), "检测到 2 处隐私信息 · 高危", f(13, True), INK)
    tw(d, (tx + 330, ty + 12), "×", f(15), FAINT)

    tw(d, (tx + 18, ty + 46), "手机号", f(12), SUB)
    rr(d, [tx + 70, ty + 42, tx + 240, ty + 64], 5, fill=FIELD)
    tw(d, (tx + 78, ty + 45), "138****8000", f(12), (52, 64, 84))
    tw(d, (tx + 18, ty + 74), "身份证号", f(12), SUB)
    rr(d, [tx + 70, ty + 70, tx + 250, ty + 92], 5, fill=FIELD)
    tw(d, (tx + 78, ty + 73), "110105********02X", f(12), (52, 64, 84))
    tw(d, (tx + 18, ty + 104), "公开平台发布后无法撤回，发送前请确认。", f(11.5), SUB)

    rr(d, [tx + 18, ty + 134, tx + 108, ty + 164], 8, fill=PRIMARY)
    tw(d, (tx + 32, ty + 141), "一键脱敏", f(12, True), (255, 255, 255))
    rr(d, [tx + 118, ty + 134, tx + 196, ty + 164], 8, fill=PANEL, outline=LINE)
    tw(d, (tx + 132, ty + 141), "直接删除", f(12), INK)
    tw(d, (tx + 206, ty + 141), "本次忽略", f(12), FAINT)

    tw(d, (rx + 28, ry0 + 486), "浏览器扩展：微博 / 知乎 / 闲鱼 / 招聘网站……任意站点同样生效", f(12), (6, 118, 71))
    tw(d, (rx + 28, ry0 + 512), "发布前对高危项二次确认，阈值可调，支持按站点静音", f(11.5), FAINT)

    rr(d, [rx + 28, ry0 + 548, rx + rw - 28, ry0 + 600], 10, fill=(247, 248, 250), outline=LINE)
    tw(d, (rx + 44, ry0 + 564), "提醒条只显示脱敏值 · 密码框不检测 · 原文永不出本机", f(12), INK)

    # 底部说明
    tw(d, (48, 776),
       "两者互相独立：检测工具打开网页即用；输入守卫网页版免安装，装扩展后在真实网站生效。默认均为本地检测，服务端不留存、不转发。",
       f(12.5), SUB)

    out = os.path.join(OUT_ICONS, "preview-products.png")
    img.save(out, quality=95)
    print("生成", out, img.size)

    # ---------------- OG 图（守卫） ----------------
    ow, oh = 1200, 630
    og = Image.new("RGB", (ow, oh), (21, 112, 239))
    o = ImageDraw.Draw(og)
    o.rounded_rectangle([60, 90, 1140, 540], radius=28, fill=(255, 255, 255))
    logo(o, 150, 200, 40, PRIMARY, "PS")
    tw(o, (210, 172), "隐私哨兵 · 输入守卫", f(40, True), INK)
    tw(o, (210, 226), "在任意网站发帖、评论、填表时实时提醒，一键脱敏", f(20), SUB)
    tw(o, (210, 268), "检测全程在浏览器本地完成，原文不上传", f(20), (6, 118, 71))
    # 示意提醒条
    rr(o, [150, 340, 810, 486], 14, fill=(255, 255, 255), outline=LINE, width=2)
    o.rectangle([150, 340, 156, 486], fill=L3)
    badge(o, 176, 362, "L3", L3, 13)
    tw(o, (222, 360), "检测到 2 处隐私信息 · 高危", f(20, True), INK)
    tw(o, (176, 404), "手机号", f(17), SUB)
    tw(o, (250, 404), "138****8000", f(17), (52, 64, 84))
    tw(o, (176, 436), "身份证号", f(17), SUB)
    tw(o, (250, 436), "110105********02X", f(17), (52, 64, 84))
    rr(o, [176, 486 - 0, 176, 486], 1)  # no-op 保持结构清晰
    ogu = os.path.join(OUT_ICONS, "og-guard.png")
    og.save(ogu, quality=92)
    print("生成", ogu, og.size)


if __name__ == "__main__":
    main()
