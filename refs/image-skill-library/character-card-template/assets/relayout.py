# -*- coding: utf-8 -*-
"""版式校正：把上下两排之间过大的空白压到目标值，重排到 3:4 画布。

不缩放、不裁切人物内容，只删除两排之间的空白并重新居中。
用法：python relayout.py <输入图> <输出图> [目标空隙占比，默认0.06]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

WHITE = 238
TARGET_RATIO = 3 / 4  # 宽/高


def find_bands(path: Path, gap=40, min_len=200):
    a = np.asarray(Image.open(path).convert("L"), dtype=np.uint8)
    rows = (a < WHITE).any(axis=1)
    runs, start = [], None
    for i, f in enumerate(rows):
        if f and start is None:
            start = i
        elif not f and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(rows) - 1))
    merged = []
    for s, e in runs:
        if merged and s - merged[-1][1] <= gap:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return [(s, e) for s, e in merged if e - s >= min_len]


def main(src: str, dst: str, gap_ratio: float = 0.06):
    src_p, dst_p = Path(src), Path(dst)
    im = Image.open(src_p).convert("RGB")
    W, H = im.size
    bands = find_bands(src_p)
    if len(bands) < 2:
        print(f"!! {src_p.name}: 只检测到 {len(bands)} 条内容带，跳过（不做校正）")
        im.save(dst_p, quality=95)
        return

    top = im.crop((0, bands[0][0], W, bands[0][1] + 1))
    bot = im.crop((0, bands[1][0], W, bands[1][1] + 1))
    h1, h2 = top.height, bot.height

    # 目标画布：3:4，宽度沿用原宽
    canvas_h = round(W / TARGET_RATIO)
    gap = round(canvas_h * gap_ratio)
    content_h = h1 + gap + h2
    if content_h > canvas_h:  # 放不下就把空隙压到最小
        gap = max(8, canvas_h - (h1 + h2))
        content_h = h1 + gap + h2
    y0 = (canvas_h - content_h) // 2

    canvas = Image.new("RGB", (W, canvas_h), (255, 255, 255))
    canvas.paste(top, (0, y0))
    canvas.paste(bot, (0, y0 + h1 + gap))
    canvas.save(dst_p, quality=95)

    print(f"{src_p.name} -> {dst_p.name}")
    print(f"  原始 {W}x{H}  上排 {h1}px  下排 {h2}px  原空隙 {bands[1][0]-bands[0][1]}px ({(bands[1][0]-bands[0][1])/H:.1%})")
    print(f"  校正 {W}x{canvas_h}  上排 {h1/canvas_h:.1%}  空隙 {gap/canvas_h:.1%}  下排 {h2/canvas_h:.1%}  上下留白 {(y0*2)/canvas_h:.1%}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 0.06)
