# -*- coding: utf-8 -*-
"""校验短剧执行脚本的「任务级硬约束表」与镜头排布。

用法:
    python check_exec_script.py 01-执行脚本-正式版.md [--target-seconds 60]

校验项（任一项失败即退出码 1）:
    1. 每个任务 2–4 镜（1 镜仅允许 ≤2 秒的插入镜）
    2. 每个任务 4–15 秒
    3. 镜号连续、不重叠、不跳号
    4. 场景切换=是 时必须填切换桥，且桥必须是人物局部特写（脚步/面部/手部/衣摆/特写）
    5. 开场景别必须是特写 / 承接 / 片头建立（中全景、全景只允许出现在第一个任务）
    6. 镜数 ≥2 的任务，景别数必须 ≥3
    7. 给出 --target-seconds 时，合计时长必须与目标一致（±1 秒）

只依赖标准库。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

HEADER_KEYS = ("任务", "镜号", "时长", "场景卡", "素材数", "开场景别", "场景切换", "切换桥", "镜数", "景别数")
CLOSEUP_WORDS = ("特写", "脚步", "面部", "手部", "手", "衣摆", "近景")


def split_row(line: str) -> list[str]:
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return [re.sub(r"\s+", " ", c) for c in cells]


def parse_tasks(text: str) -> list[dict]:
    """抓所有像任务行的表格行（首列匹配 Txx，且列数够）。"""
    tasks: list[dict] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("|"):
            continue
        cells = split_row(line)
        if len(cells) < 8 or not re.fullmatch(r"T\d+[A-Za-z]?", cells[0]):
            continue
        # 兼容：任务|镜号|时长|场景卡|素材数|开场景别|场景切换|切换桥|镜数|景别数|校验
        while len(cells) < 11:
            cells.append("")
        tasks.append({
            "task": cells[0],
            "shots": cells[1],
            "duration": cells[2],
            "scene": cells[3],
            "materials": cells[4],
            "open_shot": cells[5],
            "scene_switch": cells[6],
            "bridge": cells[7],
            "shot_count": cells[8],
            "shot_types": cells[9],
            "check": cells[10],
        })
    return tasks


def parse_range(value: str) -> tuple[int, int] | None:
    value = value.replace("－", "-").replace("—", "-").replace("~", "-").strip()
    m = re.fullmatch(r"(\d+)(?:\s*-\s*(\d+))?", value)
    if not m:
        return None
    a = int(m.group(1))
    b = int(m.group(2)) if m.group(2) else a
    return (min(a, b), max(a, b))


def parse_seconds(value: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)", value.replace("秒", "s"))
    return float(m.group(1)) if m else None


def parse_int(value: str) -> int | None:
    m = re.search(r"\d+", value)
    return int(m.group()) if m else None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="校验短剧执行脚本的任务级硬约束表")
    ap.add_argument("script", help="01-执行脚本-正式版.md")
    ap.add_argument("--target-seconds", type=float, default=None)
    args = ap.parse_args(argv)

    path = Path(args.script)
    if not path.is_file():
        print(f"找不到执行脚本: {path}", file=sys.stderr)
        return 2
    text = path.read_text(encoding="utf-8")
    tasks = parse_tasks(text)
    if not tasks:
        print("未找到任务级硬约束表（首列应为 T01/T02…，至少 8 列）", file=sys.stderr)
        return 2

    errors: list[str] = []
    warnings: list[str] = []
    prev_last = 0
    total = 0.0

    for index, t in enumerate(tasks, start=1):
        tag = t["task"]
        rng = parse_range(t["shots"])
        if rng is None:
            errors.append(f"{tag}: 镜号无法解析（{t['shots']}）")
            continue
        first, last = rng
        if first <= prev_last:
            errors.append(f"{tag}: 镜号 {first} 与上一任务末镜 {prev_last} 重叠或倒序")
        if first != prev_last + 1:
            errors.append(f"{tag}: 镜号跳号（上一任务到 {prev_last}，本任务从 {first} 开始）")
        prev_last = last

        declared = parse_int(t["shot_count"])
        actual = last - first + 1
        if declared is not None and declared != actual:
            errors.append(f"{tag}: 镜数写 {declared}，按镜号应为 {actual}")
        seconds = parse_seconds(t["duration"])
        if seconds is None:
            errors.append(f"{tag}: 时长无法解析（{t['duration']}）")
        else:
            total += seconds
            if not 4 <= seconds <= 15:
                errors.append(f"{tag}: 时长 {seconds}s 超出 4–15 秒")

        if actual > 4:
            errors.append(f"{tag}: {actual} 镜超过 4 镜上限（模型会丢镜）")
        if actual == 1:
            if seconds is not None and seconds > 2:
                errors.append(f"{tag}: 单镜任务只能是 ≤2 秒的插入镜，当前 {seconds}s")

        open_shot = t["open_shot"]
        if not any(w in open_shot for w in ("特写", "承接", "中全景", "全景")):
            errors.append(f"{tag}: 开场景别「{open_shot}」不合规（应为 特写/承接/片头中全景）")
        if any(w in open_shot for w in ("中全景", "全景")) and index > 1:
            errors.append(f"{tag}: 只有片头第一个任务可用中全景/全景开场，本任务是第 {index} 个")

        if t["scene_switch"] in ("是", "Y", "y", "✓"):
            if not t["bridge"] or t["bridge"] in ("—", "-", ""):
                errors.append(f"{tag}: 场景切换=是 但切换桥为空")
            elif not any(w in t["bridge"] for w in CLOSEUP_WORDS):
                errors.append(f"{tag}: 切换桥「{t['bridge']}」不是人物局部特写（脚步/面部/手部/衣摆/特写）")

        shots_types = parse_int(t["shot_types"])
        if actual >= 2 and shots_types is not None and shots_types < 3:
            errors.append(f"{tag}: 景别数 {shots_types} < 3（每任务至少 3 个景别）")

        if t["check"] and t["check"] not in ("✅", "✓", "通过"):
            warnings.append(f"{tag}: 校验列写的是「{t['check']}」，不是 ✅")

    if args.target_seconds is not None and abs(total - args.target_seconds) > 1:
        errors.append(f"合计时长 {total:g}s 与目标 {args.target_seconds:g}s 不一致（±1 秒）")

    print(f"任务数: {len(tasks)}   合计: {total:g}s")
    for w in warnings:
        print(f"  [warn] {w}")
    if errors:
        print(f"\n{len(errors)} 项不合格：")
        for e in errors:
            print(f"  [FAIL] {e}")
        return 1
    print("\n全部通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
