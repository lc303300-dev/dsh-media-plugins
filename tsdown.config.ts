import { defineConfig } from 'tsdown'

// 独立 bundle 的构建：直接把三个 TS 入口转译成 ESM，不做类型检查，
// 不依赖 monorepo。所有 @deepseek-ai/* 依赖由宿主 dsh 提供，
// node:* 是内置模块，undici 是 bundle 自带依赖——三者都标记 neverBundle，不打包。
export default defineConfig({
  entry: {
    'tool-vision': 'src/tool-vision.ts',
    'tool-image-gen': 'src/tool-image-gen.ts',
    'tool-video-gen': 'src/tool-video-gen.ts',
    'notify': 'src/notify.ts',
  },
  format: ['esm'],
  outDir: '.',
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/, /^undici$/],
  },
})
