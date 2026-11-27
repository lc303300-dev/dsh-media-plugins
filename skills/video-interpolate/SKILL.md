---
name: video-interpolate
description: 即梦画布视频补帧（后编辑 `node interpolate video --fps 60`）。用户只说"补帧"时，自动读上一批超清账本（`.dsh/upscale/last-batch.json`），在同一个画布把这些 2K/4K 成片批量补到 60 fps；会员权益下免费（实测 authorizedCredits=0），不传积分上限、**不轮询**。
whenToUse: 用户说"补帧""补到 60 帧""上 60fps""提帧率"，或在 `video-upscale` 完成后要求把高清片补成流畅版时。
---

# 视频补帧

> 事实来源：2026-11-27 实机验证（CLI 1.3.0，2K / 3184×1792 / 25fps / 23.8s 源片，5 段批量补 60fps 全部 `ACCEPTED` 且 `authorizedCredits: 0`）。

## 前置

补帧的源必须是**画布上已成功的视频节点**，通常就是刚做完超清的产物（`*_2K_智能超清` / `*_4K_智能超清`）。所以标准顺序是：

`video-upscale` 出片 → 用户看片 → 用户说"补帧" → 本技能取那批产物 → 补 60fps

## 取源：先读账本，再回退

1. **读 `.dsh/upscale/last-batch.json`**，取 `projectId` 与 `items[].outputNodeId`。这是首选，因为用户说的"刚才高清的"就是这一批。
2. 账本不存在或已过期（跨会话/换窗口）时回退：
   - `node find --project-id <pid> --type video --format json`
   - 筛标题含 `_2K_智能超清` / `_4K_智能超清` 的节点
   - **按 `node show` 的 `resources[0].createdAt` 取最新的那一批**，不要把所有历史超清片一起补
3. 拿不准"哪一批"时，把候选项列成表让用户点，**不要默认全选**（补帧虽免费，但会给画布堆一倍的节点）。

## 命令

```json
{ "node_id": ["node_a","node_b", ...], "fps": 60, "project_id": "<pid>" }
```

- `fps` 必填，**只接受 30 或 60**。
- `node_id` 每批 1..20 个、必须唯一。
- **不传 `credit_ceiling`，也不传 `credit_token`。** 会员权益下整批报价为 0（`totalMaxCredits: 0`、`authorizedCredits: 0`），传上限反而会走"零上限确认"分支，多一步且容易失败。若返回的报价不是 0 或要求确认，说明会员免费额度不适用——停下来把金额报给用户，等明确批准。
- **不传 `--title`**：服务端保留源标题并追加操作标记。
- 提交即执行，没有 `--run`。工具层只把 `run` / `upscale` 当付费动作拦，`interpolate` 直接放行。

## 不轮询

**提交后不要 `--wait`，不要写轮询循环。** 用户自己在画布上看进度。回执里拿到 `state=ACCEPTED` + 产物 `nodeId` 即可收工。

## 补帧准入（会挡住请求的条件）

| 检查项 | 实测值 | 含义 |
|---|---|---|
| `targetFpsMustExceed` | **26** | 源 25fps 可补 60；源已 ≥26fps 时补 30 会被判"未超过"而拦下 |
| `eligibleFps` | `[30, 60]` | 只有两档 |
| 有效帧率容差 | 1 fps | 29/59 fps 视为"已达到 30/60" |
| 源必须成功且可消费 | `success` + 有 resource | 空的/取消的节点不能补 |

- 源 25fps → **直接补 60**，不要补 30（25→30 提升小，且部分权益对 30 不通）。
- 源 60fps 再补 60 会被拒（契约要求目标帧率必须超过现有有效帧率）。

## 验收清单

- [ ] 源取自账本或"最近一批"超清产物，不是历史全量
- [ ] 每批 ≤20 个节点，`fps=60`
- [ ] 没有传 `credit_ceiling` / `credit_token`
- [ ] 回执逐项 `ACCEPTED`，`authorizedCredits` 为 0（非 0 时必须先问用户）
- [ ] **没有轮询**
- [ ] 交付：逐段「超清节点 → 补帧节点 → 标题」对照表 + 画布链接 + 实付积分

## 与超清的分工

| | 超清 `node upscale video` | 补帧 `node interpolate video` |
|---|---|---|
| 付费门 | **必须** `credit_ceiling` | **不要传**（会员免费） |
| 分辨率/帧率 | `resolution: 2K\|4K` | `fps: 30\|60` |
| 典型扣费 | 2K ≈ 6 积分/秒 | 0 |
| 源时长上限 | 25 s / 600 帧 | 同批源已过超清，自然满足 |

两者都不轮询、都不传 `--title`、都是"提交即执行"。
