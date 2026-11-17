# -*- coding: utf-8 -*-
"""把角色卡底图里“接近白”的背景提纯为纯白 #FFFFFF。

用法:
    python normalize_bg.py <入图> <出图> [阈值=232]
    python normalize_bg.py <入图> <出图> --threshold 232

行为（与 layout-spec.md 第 7 节一致，不做别的事）:
    - 仅当像素的三个通道都不低于阈值（默认 232）时才刷成纯白；
    - 其余像素一个不动；尺寸、模式不变（RGB 进 RGB 出，带 alpha 的仍是 RGBA）；
    - 有 alpha 的图：alpha=0 的像素完全不动，透明通道原样保留；
      半透明像素只改 RGB，alpha 不变；
    - 输出为 JPEG 时丢弃 alpha（JPEG 不支持透明），其余格式保留；
    - 不缩放、不裁切、不锐化、不调色。

依赖只有 Pillow。
"""

from __future__ import annotations

import argparse
import sys

from PIL import Image, ImageChops

DEFAULT_THRESHOLD = 232


def build_mask(rgb: Image.Image, threshold: int) -> Image.Image:
    """三通道同时达标的像素 = 背景。逐通道阈值化后逻辑与（multiply）。"""
    r, g, b = rgb.split()
    masks = [c.point(lambda v: 255 if v >= threshold else 0) for c in (r, g, b)]
    return ImageChops.multiply(ImageChops.multiply(masks[0], masks[1]), masks[2])


def normalize(path_in: str, path_out: str, threshold: int) -> tuple[int, int]:
    src = Image.open(path_in)
    has_alpha = src.mode in ("RGBA", "LA") or (src.mode == "P" and "transparency" in src.info)
    rgba = src.convert("RGBA")
    orig_rgb = rgba.convert("RGB")

    mask = build_mask(orig_rgb, threshold)
    if has_alpha:
        # 完全透明的像素不是背景：保持原样，透明通道原样保留
        alpha = rgba.getchannel("A")
        opaque = alpha.point(lambda v: 255 if v > 0 else 0)
        mask = ImageChops.multiply(mask, opaque)

    white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
    out = Image.composite(white, rgba, mask)
    if has_alpha:
        out.putalpha(rgba.getchannel("A"))
    else:
        out = out.convert("RGB")

    # 统计真正改了 RGB 的像素（纯白→纯白不计；亮度相同但色值不同的也会计入）
    diff = ImageChops.difference(orig_rgb, out.convert("RGB"))
    r, g, b = diff.split()
    changed_mask = ImageChops.lighter(ImageChops.lighter(r, g), b)
    total = rgba.size[0] * rgba.size[1]
    changed = sum(changed_mask.histogram()[1:])

    if path_out.lower().endswith((".jpg", ".jpeg")):
        out = out.convert("RGB")
    out.save(path_out)
    return changed, total


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="把近白背景提纯为纯白（角色卡后处理）")
    ap.add_argument("input", help="入图")
    ap.add_argument("output", help="出图")
    ap.add_argument("threshold", nargs="?", type=int, default=None,
                    help="判定为背景的通道下限，默认 232（位置参数，兼容文档写法）")
    ap.add_argument("--threshold", dest="threshold_opt", type=int, default=None,
                    help="判定为背景的通道下限，默认 232")
    args = ap.parse_args(argv)

    threshold = args.threshold_opt if args.threshold_opt is not None else args.threshold
    if threshold is None:
        threshold = DEFAULT_THRESHOLD
    if not 0 <= threshold <= 255:
        print("threshold 必须在 0-255 之间", file=sys.stderr)
        return 2

    try:
        changed, total = normalize(args.input, args.output, threshold)
    except FileNotFoundError:
        print(f"找不到入图: {args.input}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - CLI 边界，给出人话即可
        print(f"处理失败: {exc}", file=sys.stderr)
        return 1

    ratio = (changed / total * 100) if total else 0.0
    print(f"{args.output}  背景归一完成：{changed}/{total} px 变纯白（{ratio:.1f}%）  阈值 {threshold}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
