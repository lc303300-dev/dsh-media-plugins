import { defineConfig } from 'tsdown'

// 独立 bundle 的构建：把全部 TS 入口转译为 ESM，不做类型检查，不依赖 monorepo。
// 所有 @deepseek-ai/*、node:*、undici、sharp 依赖由宿主/bundle 提供，标记 neverBundle 不打包。
export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'tool-vision': 'src/tool-vision.ts',
    'tool-image-gen': 'src/tool-image-gen.ts',
    'tool-video-gen': 'src/tool-video-gen.ts',
    'tool-skill-registry': 'src/tool-skill-registry.ts',
    'tool-project': 'src/tool-project.ts',
    'tool-dt': 'src/tool-dt.ts',
    'tool-revision': 'src/tool-revision.ts',
    'tool-curator': 'src/tool-curator.ts',
    'tool-image-skill-curator': 'src/tool-image-skill-curator.ts',
    'tool-image-skill-pipeline': 'src/tool-image-skill-pipeline.ts',
    'tool-batch-image': 'src/tool-batch-image.ts',
    'tool-video-to-gif': 'src/tool-video-to-gif.ts',
    'tool-preview': 'src/tool-preview.ts',
    'tool-grid-split': 'src/tool-grid-split.ts',
    'tool-status': 'src/tool-status.ts',
    'notify': 'src/notify.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  hash: false,
  fixedExtension: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/, /^undici$/, /^sharp$/],
  },
})
