# scene-storyboard-grid 修订记录：白色细线分隔固定要求

## 修订时间

2026-08-16

## 修订来源（用户明确指令）

用户要求：把"白色细线分割"作为固定要求加入所有九宫格 Skill（含 facade-closeup-grid 与 scene-storyboard-grid）。

## 修订内容

- contract.json `business_constraints` 新增 `panel_separator`：`{style: "white_thin_line", required: true, uniform_width: true, full_span: true}`。
- SKILL.md：`OUTPUT CONTRACT` 必须声明 "nine equal panels separated by clear, uniform, full-span thin white grid lines"；不可越界项新增白色细线分隔为契约固定要求。
- references/creative-guidance.md：面板分隔线指导（白色、等宽、贯穿全幅；禁止深色/彩色分隔、禁止无分隔拼贴、禁止以内容留白代替）。
- references/failure-cases.md：新增失败案例 17（无分隔线/分隔线不合格 → 以像素级检测为准，整张重做）。

## 目的

保证九宫格输出可被确定性拆格工具按格线切分（无白色分隔线会导致拆格检测退化）。

## 原包说明

本包为插件内置正式图片 Skill 库首包，原始来源为 Codex_IS_搭建蓝图.md（已封存于原 intake-report/intake-receipt）。本修订以本文件为新来源追加封存。
