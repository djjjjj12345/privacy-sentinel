# -*- coding: utf-8 -*-
"""生成扩展图标（蓝底 + 白色盾牌 + 对勾），16/48/128 三档。"""
from PIL import Image, ImageDraw

OUT = r"C:\Users\26067\OneDrive\Desktop\检测系统\extension\icons"


def shield_points(x0, y0, x1, y1):
    """盾牌轮廓：上宽平顶，下收成尖。"""
    w, h = x1 - x0, y1 - y0
    return [
        (x0 + w * 0.50, y0 + h * 0.06),
        (x0 + w * 0.94, y0 + h * 0.20),
        (x0 + w * 0.94, y0 + h * 0.52),
        (x0 + w * 0.50, y0 + h * 0.96),
        (x0 + w * 0.06, y0 + h * 0.52),
        (x0 + w * 0.06, y0 + h * 0.20),
    ]


def draw_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角蓝底
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=(21, 112, 239, 255))

    # 白色盾牌
    pad = size * 0.17
    d.polygon(shield_points(pad, pad, size - pad, size - pad), fill=(255, 255, 255, 255))

    # 盾牌中心的蓝色对勾，小尺寸下退化为一个点
    if size >= 32:
        lw = max(2, int(size * 0.075))
        cx, cy = size / 2, size * 0.52
        d.line([(cx - size * 0.16, cy), (cx - size * 0.04, cy + size * 0.14),
                (cx + size * 0.18, cy - size * 0.15)], fill=(21, 112, 239, 255),
               width=lw, joint="curve")
    else:
        r = max(1.5, size * 0.10)
        d.ellipse([size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r], fill=(21, 112, 239, 255))

    return img


if __name__ == "__main__":
    import os
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 48, 128):
        p = os.path.join(OUT, "icon-%d.png" % s)
        draw_icon(s).save(p)
        print("生成", p)
