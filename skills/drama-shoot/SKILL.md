---
name: drama-shoot
description: 短剧画板交付（2026-11-17 建）。把可提交提示词落成即梦画布：上传素材 → 先建图片节点（角色/场景/道具）→ 再建视频节点（m2v，每节点 count=1）→ **不自动开始、不扣费** → 把节点 id 与画布链接交给用户手动点开始；需要时导出 docx/文件清单。改卡用 `node edit`，禁止 delete + create。
whenToUse: 用户要上画布、建节点、提交短剧、或要交付文件清单时。
---

# 画板交付

> 规则依据：工作区 `AGENTS.md`「画板批量制片流程」与「节点布局」；硬规则：`video-director-prompt/references/ai-video-shooting-rules.md` 第十五节（先建图片节点再建视频节点）。

## 输入 / 产出

- 输入：`02-即梦提示词-可提交版.md`（已过 `check_prompts.py`）+ 素材文件（按 `图片N` 顺序）
- 产出：画布图片节点 + 视频节点（未运行）；需要时 `docx` 与文件清单

## 流程（顺序不能乱）

1. **上传素材**：角色卡 / 场景卡 / 道具卡 / 音色，按提示词里的 `图片N` 顺序。
2. **先建图片节点**：`node create image`，按角色 / 场景 / 道具分列排在画布左侧。**跳过这步 = 视频节点零参考。**
3. **再建视频节点**：`node create video`，提示词里用 `{{node:<图片节点id>}}` 引用；模式默认 **m2v（全能参考）**，每节点 `count=1`。
4. **不自动开始**（用户 2026-11-13 定）：不传 `--run`、不报价、不扣费；把 `node_id` 与画布链接交给用户，由他在画布点「开始生成」。
5. **交付**：需要时导出 docx（**必须设东亚字体**，否则中文乱码）+ 文件清单。

## 节点布局

- 新节点放画布最右侧节点的右边：`x = max(x+width) + 620`，同一批 `y` 从 0 开始每条 `+420`。
- 一批超过 10 条继续往下接，不另起新列。

## 改卡

- 用 `node edit video --node-id`，**禁止 delete + create**（删了再建会丢上游连线）。
- 只改坐标时只传 `--x/--y`，读回确认 model / resolution / duration / references 未被重置。

## 验收

- [ ] 图片节点先建、视频节点后建，每个视频节点都引用了对应图片节点
- [ ] 读回 `generation.promptParts`：`kind:"reference"` 条目数 = 素材数；`generation.references` 份数 = 素材数
- [ ] 没有 `--run`（除非用户明确要求自动开始，那要走票据门）
- [ ] 节点 id 与画布链接已交给用户
- [ ] docx 中文字体正常（回读校验）

## 提交门

`generate_video` / `prompt_batch set_prompts` 仍会查 24h 内 `creative_writer` 记录；按 2026-11-10 分工提示词由 Agent 写，提交时传 `allow_manual_prompts: true` + `manual_prompts_reason`，不要静默手写。
