# -*- coding: utf-8 -*-
"""校验短剧即梦提示词（11 区块 · 逐镜行）是否按执行脚本落地。

用法:
    python check_prompts.py 02-即梦提示词-可提交版.md --expected tasks.json

tasks.json 从执行脚本第七章抄:
    [{"task": "T01", "shots": 3, "seconds": 9, "open_shot": "特写"}, ...]

校验项（任一项失败即退出码 1）:
    1. 每段 11 区块齐全（风格/布光锁定/参考/设定/特殊要求/导演/故事背景/画面内容/镜头/一致性/限定）
    2. 【镜头】逐镜行数 == 执行脚本该任务镜数
    3. 时间戳闭环：第一镜从 0 开始、逐镜相接、末镜 = 段时长
    4. 第一镜景别 == 执行脚本「开场景别」（特写/承接/中全景/全景）
    5. 每段至少一个 `图片N` 绑定
    6. 禁用写法：管道符拼接标题 / `@图片N` / `参考图片N` / fps / 码率 / 素材文件名
    7. 单段字数 1500–4500

只依赖标准库。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

BLOCKS = ["风格", "布光锁定", "参考", "设定", "特殊要求", "导演", "故事背景", "画面内容", "镜头", "一致性", "限定"]
SHOT_LINE = re.compile(r"镜头([一二三四五六七八九十]+)（\s*([\d.]+)\s*-\s*([\d.]+)\s*秒）")
CN_NUM = {c: i for i, c in enumerate("一二三四五六七八九十", start=1)}
PIPE_TITLE = re.compile(r"\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*秒?\s*[｜|]")
FPS = re.compile(r"\b\d+\s*fps\b|帧率|码率", re.IGNORECASE)
FILE_LEAK = re.compile(r"[\w\u4e00-\u9fa5]+\.(?:png|jpg|jpeg|mp4|mov|webp)\b", re.IGNORECASE)


def split_segments(text: str) -> list[tuple[str, str]]:
    """切成 (标签, 正文) 段。支持 `===T01===` 或每段以 `【风格】` 开头。"""
    parts = [p.strip() for p in re.split(r"^===+\s*(\S+?)\s*===+$", text, flags=re.MULTILINE)]
    if len(parts) > 1:
        segments = []
        for i in range(1, len(parts), 2):
            label = parts[i]
            body = parts[i + 1] if i + 1 < len(parts) else ""
            segments.append((label, body.strip()))
        return segments
    chunks = [c.strip() for c in re.split(r"(?=【风格】)", text) if c.strip()]
    return [(f"seg{i+1}", c) for i, c in enumerate(chunks)]


def block_text(body: str, name: str) -> str | None:
    pattern = re.compile(rf"【{name}】(.*?)(?=【|\Z)", re.DOTALL)
    m = pattern.search(body)
    return m.group(1).strip() if m else None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="校验短剧即梦提示词")
    ap.add_argument("prompt", help="02-即梦提示词-可提交版.md")
    ap.add_argument("--expected", required=True, help="从执行脚本第七章抄的 tasks.json")
    args = ap.parse_args(argv)

    path = Path(args.prompt)
    if not path.is_file():
        print(f"找不到提示词文件: {path}", file=sys.stderr)
        return 2
    expected = json.loads(Path(args.expected).read_text(encoding="utf-8"))
    text = path.read_text(encoding="utf-8")
    segments = split_segments(text)
    if len(segments) != len(expected):
        print(f"段数 {len(segments)} != 执行脚本任务数 {len(expected)}", file=sys.stderr)
        return 1

    errors: list[str] = []
    for (label, body), exp in zip(segments, expected):
        tag = str(exp.get("task", label))
        for name in BLOCKS:
            if block_text(body, name) is None:
                errors.append(f"{tag}: 缺区块【{name}】")

        shot_block = block_text(body, "镜头") or ""
        lines = [ln for ln in shot_block.splitlines() if SHOT_LINE.search(ln)]
        if len(lines) != int(exp["shots"]):
            errors.append(f"{tag}: 【镜头】{len(lines)} 行，执行脚本是 {exp['shots']} 镜")
        times = [SHOT_LINE.search(ln) for ln in lines]
        pairs = [(float(m.group(2)), float(m.group(3))) for m in times if m]
        if pairs:
            if abs(pairs[0][0]) > 1e-6:
                errors.append(f"{tag}: 第一镜不是从 0 开始（{pairs[0][0]}）")
            for a, b in zip(pairs, pairs[1:]):
                if abs(a[1] - b[0]) > 1e-6:
                    errors.append(f"{tag}: 时间戳不闭环（{a[1]} → {b[0]}）")
            if abs(pairs[-1][1] - float(exp["seconds"])) > 1e-6:
                errors.append(f"{tag}: 末镜 {pairs[-1][1]}s != 段时长 {exp['seconds']}s")

        open_shot = str(exp.get("open_shot", "特写"))
        if lines and open_shot not in lines[0]:
            errors.append(f"{tag}: 第一镜景别不是「{open_shot}」→ {lines[0][:40]}")

        if not re.search(r"图片\d+", body):
            errors.append(f"{tag}: 缺 `图片N` 绑定")

        if PIPE_TITLE.search(body):
            errors.append(f"{tag}: 出现管道符拼接的分镜标题")
        if re.search(r"@图片\d+|参考图片\d+", body):
            errors.append(f"{tag}: 出现 `@图片N` / `参考图片N`")
        if FPS.search(body):
            errors.append(f"{tag}: 出现 fps/码率 技术参数")
        if FILE_LEAK.search(body):
            errors.append(f"{tag}: 出现素材文件名")

        chars = len(re.sub(r"\s+", "", body))
        if not 1500 <= chars <= 4500:
            errors.append(f"{tag}: 字数 {chars} 超出 1500–4500")

    if errors:
        print(f"{len(errors)} 项不合格：")
        for e in errors:
            print(f"  [FAIL] {e}")
        return 1
    print(f"{len(segments)} 段全部通过 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
