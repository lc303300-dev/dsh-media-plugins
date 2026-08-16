---
name: {{skill_id}}
description: CURATOR-REQUIRED: describe the capability and trigger conditions.
---

# {{display_name}}

1. 读取 `contract.json`，只接受契约声明的输入。
2. 按需读取 references，不从示例推导契约。
3. 编写图片提示词 V1，完整展示并等待用户确认。
4. 将确认版本交回 Router；不得直接生成图片或选择 provider。

CURATOR-REQUIRED: 写入该 Skill 独有的事实裁决、停止条件和不可改变项，不复制其他 Skill 的槽位、布局或创作规则。
