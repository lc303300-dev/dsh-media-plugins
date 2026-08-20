---
name: {{skill_id}}
description: {{description}}
---

# {{display_name}}

## 核心任务

{{description}}

## 执行原则（CURATOR-REQUIRED：根据源资料补充每次执行都需要的信息）

- 用户当前明确指令是最高优先级的创意输入。
- 编写提示词前读取 `references/creative-guidance.md` 与 `references/examples.md`（正例/反例/边界案例），对照其组织方式与完整度；仅借鉴结构，不改变素材契约、不覆盖用户当前指令。
- 定稿前读取 `references/failure-cases.md`。

## 执行顺序（CURATOR-REQUIRED：按 workflow.yaml 阶段补全）

- `brief`：收集任务目标、画幅比例、场景数与每场景候选数，等待用户确认。
- 生产阶段：按已确认设置编写图片提示词 V1，完整展示并等待用户确认；确认后交回 Router 执行（单候选走 `image.generate`；多场景或多候选经付费批次确认后走 `image.batch-generate`，由平台层调度）。
- `final`：校验输出并确认交付。

## 禁止事项

- 不在本业务 Skill 内选择 provider、模型版本、分辨率、轮询、下载或付费执行策略（属平台层职责）。
- 不提交媒体、不调用生成工具。
- 不从示例推导素材契约；示例不覆盖用户当前指令。
