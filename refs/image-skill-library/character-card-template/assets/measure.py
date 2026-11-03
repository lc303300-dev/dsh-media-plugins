# -*- coding: utf-8 -*-
"""量化角色卡的版式几何：检测白色间隙，切出每个图形块的 bbox 与相对比例。"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

WHITE = 238  # 低于该亮度视为内容（JPEG 白底常有 250-253 的轻微不纯，需压低阈值）


def blocks(path: Path):
    im = Image.open(path).convert("L")
    a = np.asarray(im, dtype=np.uint8)
    h, w = a.shape
    mask = a < WHITE  # True = 有内容

    # 行方向：内容行
    rows = mask.any(axis=1)
    # 找连续内容行区间（允许 <4px 的空隙）
    def runs(flags, gap=4, min_len=8):
        out, start = [], None
        for i, f in enumerate(flags):
            if f and start is None:
                start = i
            elif not f and start is not None:
                out.append((start, i - 1))
                start = None
        if start is not None:
            out.append((start, len(flags) - 1))
        merged = []
        for s, e in out:
            if merged and s - merged[-1][1] <= gap:
                merged[-1] = (merged[-1][0], e)
            else:
                merged.append((s, e))
        return [(s, e) for s, e in merged if e - s >= min_len]

    band_rows = runs(rows, gap=12, min_len=20)
    result = {"size": (w, h), "bands": []}
    for (y0, y1) in band_rows:
        sub = mask[y0:y1 + 1, :]
        cols = sub.any(axis=0)
        band_cols = runs(cols, gap=10, min_len=10)
        cells = []
        for (x0, x1) in band_cols:
            csub = mask[y0:y1 + 1, x0:x1 + 1]
            yy = np.where(csub.any(axis=1))[0]
            cells.append({
                "x0": x0, "x1": x1, "y0": y0 + int(yy[0]), "y1": y0 + int(yy[-1]),
                "w": x1 - x0 + 1, "h": int(yy[-1] - yy[0]) + 1,
            })
        result["bands"].append({"y0": y0, "y1": y1, "cells": cells})
    return result


def report(path: Path):
    print("=" * 78)
    print(path.name, end="  ")
    r = blocks(path)
    W, H = r["size"]
    print(f"{W}x{H}")
    for bi, band in enumerate(r["bands"]):
        by0, by1 = band["y0"], band["y1"]
        print(f"  band{bi}: y {by0}..{by1}  (顶部 {by0/H:.1%} 到底部 {by1/H:.1%}, 高 {by1-by0+1} = {(by1-by0+1)/H:.1%})")
        for ci, c in enumerate(band["cells"]):
            print(f"     cell{ci}: x {c['x0']}..{c['x1']} (w {c['w']} = {c['w']/W:.1%})  "
                  f"y {c['y0']}..{c['y1']} (h {c['h']} = {c['h']/H:.1%})")
        if len(band["cells"]) > 1:
            bottoms = [c["y1"] for c in band["cells"]]
            print(f"     底边: {bottoms}  极差 {max(bottoms)-min(bottoms)}px")
            widths = [c["w"] for c in band["cells"]]
            print(f"     宽度比: {[round(x/widths[0], 2) for x in widths]}")
    if len(r["bands"]) >= 2:
        gap = r["bands"][1]["y0"] - r["bands"][0]["y1"] - 1
        print(f"  两排间空隙: {gap}px = {gap/H:.1%} 高度")


for p in sys.argv[1:]:
    report(Path(p))
