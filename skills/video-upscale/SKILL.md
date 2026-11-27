---
name: video-upscale
description: 即梦画布视频超清/超分（后编辑 `node upscale video`）。把本地视频按 ≤23.8s 切片（服务端硬限 25s / 600 帧）上传建节点，或直接对画布已有视频节点批量做 2K/4K 智能超清；每批 1..20 个节点，提交后**不轮询**，只回受理结果，并把产物节点写进批次账本供 `video-interpolate` 补帧复用。
whenToUse: 用户要求视频超清 / 超分 / 升到 2K / 4K / 提高清晰度，或说"把这条（这批）视频超清一下""480P 升 2K""成片放大"时。
---

# 视频超清（超分）

> 本文事实全部来自 2026-11-27 实机验证（即梦画布 CLI 1.3.0，854×480 / 25fps / 212.49s 源片，9 段全部 2K 成功）。命令与枚举以 `schema` 实时结果为准：**调用前先 `dreamina_canvas` 的 `command=schema` + `action="node upscale video"`**。

## 三条硬限制（不知道就一定失败）

| 限制 | 值 | 后果 |
|---|---|---|
| 源片时长上限 | **25 s（25000 ms）** | 25.024 s 的片子被整段打回 `input_error`，报 "The source video duration is 25024 ms; the maximum for video upscaling is 25000 ms" |
| 源片帧数上限 | **600 帧** | 25fps × 24s = 600，正好卡满 |
| 目标分辨率 | 仅 **2K / 4K**（视频没有 8K，也没有 normal/pro 之分） | 8K、normal 一律本地拒绝 |

⇒ **切片一律用 23.8 s，不要用 24 s 或 25 s。** 实测 24 s 切片会产出 24.02 s（首段），23.8 s 切片产出 23.82 s，都留了余量；差 24 毫秒就会被拒。

## 流程 A：本地文件超清

### A1. 勘测

```powershell
$ff = "C:\Program Files\oopz\ffmpeg.exe"   # 顺序：$env:FFMPEG_PATH → PATH → C:\Program Files\oopz\ffmpeg.exe 等常见位置
& $ff -hide_banner -i "<源文件>" 2>&1 | Select-String "Duration|Stream #"
```

记下总时长、分辨率、fps。**是否超限由源片真实时长决定，不看容器标称。**

### A2. 按 23.8 s 切片（必须重编码）

```powershell
& $ff -y -i "<源文件>" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p `
  -force_key_frames "expr:gte(t,n_forced*23.8)" -c:a aac -b:a 128k `
  -f segment -segment_time 23.8 -reset_timestamps 1 -segment_format mp4 "<out>\seg%02d.mp4"
```

- **不能用 `-c copy`**：不重编码就无法保证每段精确 23.8 s 与关键帧对齐。
- 切完逐段复核时长，首段允许 23.82 s，末段是余数。
- 总段数 = `ceil(总时长 / 23.8)`。

### A3. 上传（串行 + 幂等 UUID + 失败重试）

```powershell
& <dreamina-canvas.exe> resource upload --project-id <pid> --file <seg> --name "<名>-01" --type video --resource-id <预生成UUID> --format json --non-interactive
```

- **每段先预生成 UUID 当幂等键**，重试必须复用同一个，避免重复登记。
- **串行**，不要一次并发 5 个以上：实测并发 5 个会出现偶发 `unknown`（错误退出），重试即成功。
- 上传只登记资源，不上画布。

### A4. 建节点（导入素材，不带生成参数）

```powershell
& <dreamina-canvas.exe> node create video --project-id <pid> --resource-id <uuid> --import-kind local_upload --title "<名>-01" --format json --non-interactive
```

- 返回体里取 `data.node.nodeId`，这是超分的来源节点。
- **绝不传 `--mode` / `--model` / `--resolution`**：导入节点带生成参数会被本地拒绝。
- 如果走 `dreamina_canvas` 工具报 `input_error`，说明插件版本早于 2026-11-27 的 `withVideoDefaults` 修复（该修复让导入路径跳过模型注入）；此时按上面的原生命令直调 CLI，或先升级/重启插件。

### A5. 批量超清

```json
{ "node_id": ["node_a","node_b", ...], "resolution": "2K", "credit_ceiling": 1500 }
```

- **每批 1..20 个节点**（21 个被本地拒绝）。超过 20 就分多次。
- `resolution` 必填，`2K` | `4K`；`detail` 是图片超分专有，视频**没有**。
- **必须带 `credit_ceiling`**（整批上限）：报价 ≠ 授权，工具层不带会直接拒绝。先估：**2K ≈ 6 积分/秒、4K ≈ 11 积分/秒**（实测 23.8 s → 2K 收 138；7.07 s → 4K 收 77）。
- **不要传 `--title`**：服务端保留源标题并自动加 `_2K_智能超清` / `_4K_智能超清`，画布上就能直接认出成品。
- 返回 `items[].state = ACCEPTED` 即受理成功，`items[].nodeId` 就是产物节点。

### A6. 不轮询

**提交后不要 `--wait`，不要写轮询循环，不要查 `node find` 看进度。** 用户能直接在画布上看到进度；轮询只会白占 turn 且容易被中断（实测两次轮询脚本都因超时被打到后台）。

回执 = 受理结果 + 每段 product nodeId + 每段 authorizedCredits + 总计。收工。

### A7. 写批次账本（补帧要用）

把本批产物写进工作区账本，供 `video-interpolate` 在用户只说"补帧"时直接取源：

`<工作区>/.dsh/upscale/last-batch.json`

```json
{
  "batchId": "upscale-20261127-1722",
  "projectId": "<画布 UUID>",
  "canvasName": "<画布名>",
  "resolution": "2K",
  "createdAt": "2026-11-27T17:22:00+08:00",
  "source": { "kind": "local-file", "file": "D:\\...\\480P.mp4", "segmentSeconds": 23.8, "segments": 9 },
  "items": [
    { "index": 1, "sourceNodeId": "node_xxx", "outputNodeId": "node_yyy", "title": "璞逸480P-01_2K_智能超清" }
  ]
}
```

回执里也要把「序号 → 产物节点 id → 标题」列成表，让用户在画布上对得上。

## 流程 B：画布已有节点超清

用户指着画布上现成的视频要超清时：

1. `node find --project-id <pid> --type video --format json` 拿候选（注意 `hasMore`，默认只回 50 条，必要时用工具分页或按标题筛）。
2. **读回源参数再决定档位**：`node show --project-id <pid> --node-id <id>`，看 `resources[0].video` 的 `width/height/fps/durationSeconds` 与 `eligibleResolutions`。目标长边必须大于源长边。
3. 超过 23.8 s 的源**不能直接超分**：先 `resource download` 下来、按 23.8 s 切片、再走流程 A 重传重超（或明确告诉用户必须切）。
4. 之后同 A5–A7。

**`node show` 必须显式带 `--project-id`**：不带会退回"当前项目"并返回 `NOT_FOUND`（实测踩过）。

## 验收清单

- [ ] 源片每段时长 ≤ 23.8 s（不是 ≤25 s），总段数 = ceil(总时长/23.8)
- [ ] 上传串行、UUID 幂等、无重复登记
- [ ] 导入节点没有带 mode/model/resolution
- [ ] 每批节点数 ≤ 20，且带了 `credit_ceiling`
- [ ] 回执逐段有 `state=ACCEPTED` + 产物 nodeId
- [ ] **没有轮询**
- [ ] `.dsh/upscale/last-batch.json` 已写，items 覆盖全部产物
- [ ] 交付：画布链接 + 逐段对照表 + 总扣费

## 踩坑速查

| 现象 | 原因 | 处置 |
|---|---|---|
| `input_error` 但 dry-run 通过 | 源片超 25 s / 600 帧 | 按 23.8 s 重切 |
| 工具建导入节点全失败、直调 CLI 就通 | `withVideoDefaults` 给导入节点注入 model/resolution | 直调 CLI 或升级插件（2026-11-27 已修） |
| 并发上传偶发 `unknown` | 上传并发过高 | 串行 + 同 UUID 重试 |
| `node show` 返回 `NOT_FOUND` | 没带 `--project-id` | 显式传 project-id |
| `node find` 少了节点 | 默认只回 50 条 | 用 `hasMore`/分页或按标题筛 |
| 报价 unknown/blocked | 整批会停，不会按 0 批准 | 如实报告，不要删成员后继续 |
