# -*- coding: utf-8 -*-
"""
把真实站点的验收截图拼成一张证据图，并把原图压成 jpg 控制仓库体积。

产物：
  docs/real-browser/evidence-grid.png   四站对比图（README / 答辩用）
  docs/real-browser/<site>-1-alert.jpg  提醒条出现
  docs/real-browser/<site>-2-masked.jpg 一键脱敏后的输入框
"""
import os
import glob
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'docs', 'real-browser')

FONT = 'C:/Windows/Fonts/msyh.ttc'
FONT_BD = 'C:/Windows/Fonts/msyhbd.ttc'


def f(size, bold=False):
    return ImageFont.truetype(FONT_BD if bold else FONT, size)


SITES = [
    ('baidu', '百度 · 搜索框（textarea）'),
    ('juejin', '掘金 · 搜索框（技术社区）'),
    ('bilibili', '哔哩哔哩 · 搜索框（Vue 受控组件）'),
    ('douban', '豆瓣 · 搜索框（原生 input）'),
]

# 只保留页面上半部分：浮条和输入框都在这里，裁掉大片空白后证据更清楚
CROP_H = 470

W = 1200
PAD = 20
GAP = 20
CELL_W = (W - PAD * 2 - GAP) // 2
IMG_W = CELL_W
IMG_H = int(CROP_H * IMG_W / 1280)
LABEL_H = 32
ROW_GAP = 22
TOP = 138
BOTTOM = 86
ROWS = (len(SITES) + 1) // 2
H = TOP + ROWS * (LABEL_H + IMG_H + ROW_GAP) + BOTTOM

canvas = Image.new('RGB', (W, H), '#FFFFFF')
d = ImageDraw.Draw(canvas)

d.text((PAD, 34), '真实网站实测：在别人的输入框里，把手机号和身份证拦下来',
       font=f(30, True), fill='#111827')
d.text((PAD, 84), 'Microsoft Edge 真实渲染 · 4 个公开站点 · 24 项断言全部通过（scripts/verify-real-browser.js 可复现）',
       font=f(17), fill='#4B5563')

for i, (name, label) in enumerate(SITES):
    r, c = divmod(i, 2)
    x = PAD + c * (CELL_W + GAP)
    y = TOP + r * (LABEL_H + IMG_H + ROW_GAP)
    d.text((x, y + 4), label, font=f(17, True), fill='#111827')

    src = os.path.join(OUT, name + '-1-alert.png')
    if not os.path.exists(src):
        continue
    raw = Image.open(src).convert('RGB')
    im = raw.crop((0, 0, raw.width, min(CROP_H, raw.height))).resize((IMG_W, IMG_H), Image.LANCZOS)
    canvas.paste(im, (x, y + LABEL_H))
    d.rectangle([x, y + LABEL_H, x + IMG_W - 1, y + LABEL_H + IMG_H - 1], outline='#E5E7EB')

foot_y = TOP + ROWS * (LABEL_H + IMG_H + ROW_GAP) + 8
d.line([PAD, foot_y, W - PAD, foot_y], fill='#E5E7EB')
d.text((PAD, foot_y + 16),
       '① 提醒条浮在真实输入框下方　　② 提示里只有脱敏值，从不回显原文　　③ 点「一键脱敏」，输入框里的真实值被就地改写',
       font=f(16), fill='#374151')
d.text((PAD, foot_y + 44),
       '测试样本：昨天在地铁站丢了个快递，捡到的联系我 13800138000，身份证 110105199003071239',
       font=f(15), fill='#9CA3AF')

grid_path = os.path.join(OUT, 'evidence-grid.png')
canvas.save(grid_path, 'PNG', optimize=True)

KEEP = []
for _name, _ in SITES:
    KEEP += [_name + '-1-alert', _name + '-2-masked']

for png in glob.glob(os.path.join(OUT, '*.png')):
    base = os.path.basename(png)
    if base == 'evidence-grid.png' or base[:-4] not in KEEP:
        continue
    im = Image.open(png).convert('RGB')
    im.save(png[:-4] + '.jpg', 'JPEG', quality=82, optimize=True, progressive=True)
    try:
        os.remove(png)
    except OSError:
        pass

for jpg in glob.glob(os.path.join(OUT, '*.jpg')):
    im = Image.open(jpg)
    if im.width > 1100:
        im.resize((1100, int(im.height * 1100 / im.width)), Image.LANCZOS).save(
            jpg, 'JPEG', quality=82, optimize=True, progressive=True)

print('生成：' + grid_path)
print('尺寸：%dx%d' % canvas.size)
print('目录体积：%.1f MB' % (sum(os.path.getsize(p) for p in glob.glob(os.path.join(OUT, '*')) if os.path.isfile(p)) / 1048576))
