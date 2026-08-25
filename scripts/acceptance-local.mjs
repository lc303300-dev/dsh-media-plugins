#!/usr/bin/env node
/**
 * 离线端到端验收（零费用）：走通所有不触发付费的领域链路并输出报告。
 * 覆盖：Skill Registry、Project Pipeline、DT 审阅、批量调度数学、图片归一化/预览、GIF。
 * 用法：node scripts/acceptance-local.mjs
 * 产物：<workspace>/outputs/acceptance/ 下（预览、审阅页、GIF、联系表、报告 JSON）。
 */
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { SkillRegistry } from '../src/shared/registry-core.ts'
import {
  createProject, transition, validateVideoSettings, addMaterial, addPrompt, confirmPrompt, buildSubmissionPayload,
} from '../src/shared/project-core.ts'
import { validateManifest, computeDeadline, flattenTasks, buildContactSheetHtml } from '../src/shared/batch-core.ts'
import { normalizeProviderImage, makePreview } from '../src/shared/image-ops.ts'
import { buildReviewHtml, buildReviewItems } from '../src/shared/dt-core.ts'
import { videoToGif, resolveFfmpeg } from '../src/shared/gif-core.ts'
import { sha256File } from '../src/shared/private-runtime.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'outputs', 'acceptance')
mkdirSync(OUT, { recursive: true })
rmSync(join(OUT, 'work'), { recursive: true, force: true })
mkdirSync(join(OUT, 'work'), { recursive: true })

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  —  ${detail}`)
}

/* ---------- 1. Skill Registry 端到端 ---------- */
{
  const work = join(OUT, 'work', 'registry')
  const skillDir = join(work, 'city-night-skill')
  mkdirSync(skillDir, { recursive: true })
  const contract = {
    name: '城市夜景短片', version: '1.0.0', description: '未来城市夜景氛围短片', taxonomy: ['城市', '夜景', '氛围'],
    video: { ratios: ['16:9', '9:16'], duration_min: 4, duration_max: 10 },
    slots: [
      { id: 'hero', label: '主体图', min: 1, max: 3, count_rule: 'per_second' },
      { id: 'bg', label: '背景图', min: 0, max: 2, count_rule: 'fixed' },
    ],
    prompt: { lang: 'zh', corpus_policy: 'up_to_10_examples' },
  }
  writeFileSync(join(skillDir, 'contract.json'), JSON.stringify(contract, null, 2), 'utf8')
  writeFileSync(join(skillDir, 'routing.json'), JSON.stringify({ keywords: ['夜拍', '城市', '夜景'] }, null, 2), 'utf8')
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: 城市夜景短片\ndescription: 城市夜景氛围短片\n---\n\n# 城市夜景短片\n', 'utf8')
  const dbPath = join(work, 'registry.db')
  const reg = new SkillRegistry(dbPath)
  reg.ingest({ contract, routing: { keywords: ['夜拍', '城市'] }, packageRoot: skillDir, provenance: 'acceptance' })
  record('SkillRegistry.ingest → draft', reg.get('城市夜景短片')?.status === 'draft', 'name@version + sha256 已登记')
  reg.setStatus('城市夜景短片', '1.0.0', 'published')
  const hits = reg.search('夜景', 5, 'published')
  record('SkillRegistry.search(FTS5 trigram CJK)', hits.length >= 1 && hits[0].name === '城市夜景短片', `命中 ${hits.length} 条，top=${hits[0]?.name}`)
  const dup = (() => { try { reg.ingest({ contract: { ...contract, description: '不同内容' } }); return null } catch (e) { return e.message } })()
  record('SkillRegistry.去重（内容哈希漂移拒绝）', typeof dup === 'string' && dup.includes('different content'), dup ?? '未拒绝')
  reg.close()
}

/* ---------- 2. Project Pipeline 端到端 ---------- */
{
  const work = join(OUT, 'work', 'project')
  mkdirSync(work, { recursive: true })
  // 真实素材文件（用于哈希）
  const materialPath = join(work, 'hero.png')
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 20, g: 30, b: 60 } } }).png().toFile(materialPath)
  const hash = await sha256File(materialPath)

  let p = createProject('acceptance-1', '城市夜景短片')
  p = transition(p, 'awaiting_video_settings', 'skill confirmed')
  validateVideoSettings('16:9', 8)
  p = { ...transition(p, 'project_initialized'), ratio: '16:9', duration: 8 }
  p = transition(p, 'awaiting_image_stage_choice')
  p = transition(p, 'collecting_user_materials')
  p = addMaterial(p, 'hero', materialPath, hash, [{ id: 'hero', min: 1, max: 3 }])
  p = transition(p, 'final_images_ready')
  p = addPrompt(p, '夜晚的未来城市，霓虹倒映在湿街上，镜头缓慢推进。', 'skill_v1')
  p = transition(p, 'awaiting_prompt_confirmation')
  p = confirmPrompt(p)
  record('ProjectPipeline.全流程→prompt_confirmed', p.status === 'prompt_confirmed' && p.prompts.length === 1, '素材+提示词已锁定')
  const payload = buildSubmissionPayload(p, { [`hero:${materialPath}`]: hash })
  record('ProjectPipeline.build_payload（哈希复核通过）', payload.prompt_hash === p.lockedPromptHash, `prompt v${payload.prompt_version}`)
  let tamperRejected = null
  try {
    buildSubmissionPayload(p, { [`hero:${materialPath}`]: 'tampered-hash' })
  } catch (e) { tamperRejected = e.message }
  record('ProjectPipeline.素材哈希被篡改→拒绝提交', typeof tamperRejected === 'string' && tamperRejected.includes('hashes changed'), tamperRejected ?? '未拒绝')
  // 越级
  const skip = (() => { try { return transition(createProject('x'), 'completed') } catch (e) { return e.message } })()
  record('ProjectPipeline.状态越级被拒绝', typeof skip === 'string' && skip.includes('invalid project transition'), skip ?? '未拒绝')
}

/* ---------- 3. DT 审阅页 + 图片归一化/预览 ---------- */
{
  const work = join(OUT, 'work', 'dt')
  mkdirSync(work, { recursive: true })
  const src = join(work, 'material.png')
  await sharp({ create: { width: 3000, height: 1600, channels: 3, background: { r: 90, g: 40, b: 120 } } }).png().toFile(src)
  const beforeHash = await sha256File(src)
  const norm = await normalizeProviderImage(src, join(work, 'inputs'), 1920)
  const normMeta = await sharp(norm.path).metadata()
  record('图片归一化 EXIF+1920（原图哈希不变）', Math.max(normMeta.width ?? 0, normMeta.height ?? 0) === 1920 && (await sha256File(src)) === beforeHash, `${normMeta.width}x${normMeta.height}`)
  const prev = await makePreview(src, join(work, 'previews'), 1024)
  const prevMeta = await sharp(prev.path).metadata()
  record('image_preview ≤1024px', Math.max(prevMeta.width ?? 0, prevMeta.height ?? 0) === 1024, `${prevMeta.width}x${prevMeta.height}`)

  const manifest = {
    batch_id: 'acceptance-batch', duration: 8, ratio: '16:9', model: 'seedance2.5',
    materials: [{ path: src, hash: beforeHash }],
    prompts: [{ material: src, prompt: '夜晚未来城市霓虹街景，镜头从天空缓慢推向地面人群。' }],
  }
  const items = buildReviewItems(manifest, [{ material: src, preview: prev.path }])
  const html = buildReviewHtml(manifest, items)
  writeFileSync(join(OUT, 'dt-review.html'), html, 'utf8')
  record('DT 审阅页生成（含预览+中文提示词）', items.length === 1 && html.includes('夜晚未来城市'), `review items=${items.length}`)
}

/* ---------- 4. 批量调度数学（40 张 / 10 并发） ---------- */
{
  const manifest = {
    groups: [
      { id: 'g1', prompt: '橘猫', candidates: 20, image_ratio: '1:1' },
      { id: 'g2', prompt: '未来城市', candidates: 20, image_ratio: '16:9' },
    ],
    concurrency: 10,
  }
  validateManifest(manifest)
  const plan = computeDeadline(manifest)
  const tasks = flattenTasks(manifest)
  const sheet = buildContactSheetHtml(plan, manifest.groups, [
    { groupId: 'g1', slot: 1, path: 'D:/out/g1/g1-01.png' },
    { groupId: 'g2', slot: 3, path: 'D:/out/g2/g2-03.png' },
  ])
  writeFileSync(join(OUT, 'batch-contact-sheet.html'), sheet, 'utf8')
  record('批量 deadline 数学（ceil+1.5×）', plan.estimateSeconds === 240 && plan.deadlineSeconds === 360, `estimate=${plan.estimateSeconds}s deadline=${plan.deadlineSeconds}s tasks=${tasks.length}`)
  record('批量 job key 幂等', computeDeadline(manifest).jobKey === plan.jobKey, `jobKey=${plan.jobKey}`)
}

/* ---------- 5. GIF 端到端 ---------- */
{
  const work = join(OUT, 'work', 'gif')
  mkdirSync(work, { recursive: true })
  const ffmpeg = await resolveFfmpeg()
  const mp4 = join(work, 'clip.mp4')
  if (ffmpeg) {
    const { execFileSync } = await import('node:child_process')
    execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10', '-pix_fmt', 'yuv420p', mp4], { stdio: 'ignore' })
    const gif = await videoToGif(mp4, join(work, 'out'), { ffmpegPath: ffmpeg, maxSizeMB: 10 })
    record('video_to_gif 端到端（双遍 palette）', gif.withinBudget && gif.sizeBytes > 0, `${gif.width}px@${gif.fps}fps ${Math.round(gif.sizeBytes / 1024)}KB attempts=${gif.attempts}`)
  } else {
    record('video_to_gif 端到端', false, '未找到 ffmpeg（FFMPEG_PATH/PATH/常见路径）')
  }
}

/* ---------- 报告 ---------- */
const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok).length
writeFileSync(join(OUT, 'acceptance-report.json'), JSON.stringify({ generated_at: new Date().toISOString(), passed, failed, results }, null, 2), 'utf8')
console.log(`\n===== 验收结果：${passed} 通过 / ${failed} 失败 =====`)
console.log(`报告：${join(OUT, 'acceptance-report.json')}`)
console.log(`产物目录：${OUT}`)
process.exit(failed > 0 ? 1 : 0)
