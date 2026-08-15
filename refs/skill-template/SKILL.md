---
name: {{skill_id}}
description: {{description}}
---

# {{display_name}}

## 核心任务

<!-- CURATOR-REQUIRED: 用一段话说明该 Skill 独有的业务目标，不重复 description。 -->

## 知识加载

- 创作前读取 `contract.json`，严格按素材槽顺序绑定参考素材。
- 编写提示词时读取 `references/creative-guidance.md`。
- 需要采用社区实践时读取 `references/community-experience.md`，只使用符合当前条件的经验。
- 定稿前读取 `references/failure-cases.md`。
- 仅在需要相似案例或用户要求时读取 `references/examples.md`；不得用示例改变素材契约。

## 执行原则

1. 用户当前明确指令具有最高优先级。
2. 只依据已确认素材、用户说明和本 Skill 知识编写提示词。
3. 保持素材引用顺序、主体身份、因果关系、时间顺序和结尾条件。
4. 使用中文为主，保留必要的专业英文并给出中文含义。
5. 完成后交由 Codex_CS 主工作流展示并取得用户确认。

## 禁止事项

- 不选择实际生成 provider、模型、分辨率、轮询或下载策略。
- 不直接提交图片或视频生成任务。
- 不把示例中的项目、地点、角色或镜头数量变成通用规则。
- 不在素材信息存在歧义时自行猜测。

