# 图片业务 Skill 入库审核清单

## 身份与重复

- [ ] 目录、frontmatter、contract、routing 的 Skill ID 一致。
- [ ] 已检查正式名称、别名和意图的重复或近似冲突。
- [ ] description 能独立说明能力和触发场景。

## 契约

- [ ] 素材槽来自业务事实，不来自模板习惯。
- [ ] 每槽角色、作用域、数量、顺序和观察/发送策略清晰。
- [ ] allowed_slot_ids 与槽顺序一致，拒绝未声明素材。
- [ ] workload 的 scene_count / candidate_count_per_scene 范围与 batch_allowed 一致。
- [ ] 输出结构是确定性要求，不是示例偏好。
- [ ] 比例和提示词确认节点存在。

## 反污染

- [ ] 未继承其他 Skill 的槽名、槽数、布局、面板数或镜头池。
- [ ] 示例未定义契约。
- [ ] 专业经验写明适用条件。
- [ ] 无优秀范例图或未声明图片进入引用链。

## 执行与安全

- [ ] provider-neutral，只使用统一执行边界（generate_image / batch-image-generation）。
- [ ] 无密钥、Cookie、授权头、provider 适配器、轮询、下载、并发或自动重试。
- [ ] 不在用户确认前执行付费任务；多候选须有付费批次确认。

## 发布

- [ ] intake report 无 blocking questions 和 validation issues。
- [ ] 用户明确批准正式名称、素材契约、输出契约和发布（approved_by=user）。
- [ ] 收据包含来源哈希、validator version、intake-report 哈希与包哈希。
- [ ] 发布后完整校验和注册表重建成功；升级走备份+回滚流程。
