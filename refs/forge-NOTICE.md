# forge-index.jsonl 语料来源声明

本包内置的 `refs/forge-index.jsonl`（2477 条）是
[seedance-forge](https://github.com/StreetJammer/seedance-forge) 社区语料库
`references/indexes/combined.index.jsonl` 的原样复制（DSH 重建按用户要求全量入包）。

## Provenance

- 每条记录保留 `author`、`sourceLink`、`sourcePublishedAt`、`source_project`、
  `source_repo`、`source_license`、`seedance_version` 字段。
- 来源项目：forge-original、youmind、zerolu 等社区仓库/推文；许可证多为
  "upstream inherited"，未逐条终审（见指南 §11 风险项：语料含第三方来源）。
- `seedance_version` 仅作 provenance 元数据，**绝不用于选择生成模型**。

## 使用约束（与 Codex_DT 契约一致）

- 修订检索最多 3 条；explicit_local 禁用语料。
- 只提取可迁移结构（portable_pattern），不复制完整案例提示词。
- 不修改第三方语料；如需更新，从上游重新复制并保留本声明。
