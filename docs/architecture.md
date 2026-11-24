# 架构与构建约束

> 从 `AGENTS.md` 拆出（2026-11-24）。这里放「为什么这么实现」的开发知识。
> 操作手册见 [`operations.md`](operations.md)，工具契约见 [`tool-contracts.md`](tool-contracts.md)，
> 业务口径见 [`business-rules.md`](business-rules.md)。

## 插件整体不加载：dsh 版本兼容门（2026-10-18 根因修复）

> **症状**：dsh 重启后 `creative_writer` / `dreamina_canvas` / `media_status` / `generate_video` 等**全部**工具消失，
> GUI 与主进程都没有报错。**根因不在 patch、不在 dist、不在符号链接**。
>
> **机制**：`@deepseek-ai/dsh-app-boot` 启动时对组合后的**每一行**插件行跑 compatibility preflight
> （`evaluatePluginCompatibility` → `prepareProfileEntries`）。manifest 若声明 `engines.dsh` 则只看它；否则检查
> `peerDependencies` 里每个 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 是否满足**当前 dsh 运行时版本**。不满足时该行
> `disabled = true`（group 行整组禁用），只往 stderr 写 `dsh: disabling profile plugin <row>: ...`，**进程不报错**。
> 本仓库 `peerDependencies` 锁过 `0.2.0-rc.2`，桌面版 dsh 升到 `0.2.1-rc.2`（2026-10-17 安装）后，19 个 insert 行全部被
> 静默禁用 —— 整个 bundle 一个工具都注册不出来。
>
> **为什么"曾经能用"**：升级后旧进程仍在跑（旧会话日志直到 10-18 01:45），重启才让新 dsh 生效；10-18 18:08 加
> `Ws_tool-creative` 只是同期巧合，与本故障无关。
>
> **修复（已固化）**：`package.json` 增加 `engines` 声明。`engines.dsh` 存在时优先且忽略 peer 检查。
> **2026-10-29 起上界已放开**：`"dsh": ">=0.2.0-rc.2"`（原 `>=0.2.0-rc.2 <0.3.0` 会让 0.3.x 起整包静默禁用；
> 用 DSH 0.2.1-rc.2 自带的 `evaluatePluginCompatibility` 对实际 manifest 复验，0.2.0-rc.2 ~ 1.0.0 全判 compatible）。
> **不能直接删 `engines.dsh`**：缺失时会回退检查 `peerDependencies` 里锁死的 `@deepseek-ai/dsh-*`，反而重新被拦。
>
> **离线验证（无需重启）**：
> `$env:ELECTRON_RUN_AS_NODE=1; & "D:\AI\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals <script.mjs>`，
> 脚本内 `import { evaluatePluginCompatibility, getDshRuntimeVersion } from 'file:///D:/AI/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'`，
> 用它读 `package.json`。返回 `undefined` = 兼容；返回对象（带 `requirements`）= 该行会被禁用。
>
> **部署注意（第二条坑，2026-10-18 踩到）**：profile 的 `node_modules/dsh-media-plugins` 必须是**指向本仓库的链接**
> （pnpm 的 symlink，或 `mklink /J` junction）。曾用 robocopy 把插件复制成真实目录 —— 这会把 pnpm 的 symlink 拓扑压平
> （`.pnpm` 里的依赖链接变成真实目录），运行时 `sharp` / `@deepseek-ai/schemastery` 找不到自己的间接依赖
> （`Cannot find package 'detect-libc'` / `'@deepseek-ai/cosmokit'`）。链接模式下改 `package.json` / `cordis.patch.yml`
> 无需同步；若必须复制，请整体保留 `.pnpm` 的 symlink 结构，或在 profile 里重跑 pnpm install 重建链接。
>
> **升级 dsh 后**：上界已放开，不再因版本号禁用；但插件仍可能因宿主 API 变化而运行时报错。应急手段：在 profile 的
> `compatibility.json` 写 `{ "dsh-media-plugins@<版本>": ["<dsh 版本>"] }`（exact 版本；**缺文件 = 不授权**），或
> `dsh plugin allow-version --accept-risk`；要恢复旧的门禁语义就 `git revert` 放开上界的那次提交。

## 依赖打包（2026-10-29，根治安装期启动崩溃）

> **插件已不再有任何 `@deepseek-ai/*` 运行时依赖**：`tsdown.config.ts` 用
> `deps.alwaysBundle: [/^@deepseek-ai\//]` 把它们全部打进 `dist/`，`dependencies` 只剩 `sharp` / `undici`。
>
> **事故链（2026-10-27）**：旧版把它们写在 `dependencies`（锁 `0.2.0-rc.2`）。pnpm 一装就落到
> `profile/node_modules/@deepseek-ai`，DSH 启动时**宿主核心插件**沿解析路径命中这份旧副本，
> 旧副本又 import 了 asar 内部包（`dsh-scope` / `dsh-sandbox` 等）解析不到 → `tools` / `agents`
> 服务无人注册 → 必需插件 `agent-loop` 起不来 → 整个应用 "The application could not start"。
>
> - **必须用 `alwaysBundle` 才会真的打包**：tsdown 默认把 `dependencies` 全部 externalize，
>   只删 `neverBundle` 无效（实测输出与改前字节级一致）。`onlyBundle: false` 用于抑制
>   "打包了未列白名单依赖"的警告。
> - **验证方式**：临时把仓库 `node_modules/@deepseek-ai` 改名移走，遍历 `package.json` 全部 `dist`
>   入口逐个 `import`，必须全部成功（改动前会 `ERR_MODULE_NOT_FOUND: Cannot find package
>   '@deepseek-ai/schemastery'`）。实测 21 个入口 OK=21 FAIL=0。
> - **为什么可以安全打包**：`defineTool` 返回普通对象（无 `instanceof` 校验）；`credentialRef` 走的
>   `brandString` 是编译期类型品牌，运行时原样返回字符串（无 Symbol），所以不会出现双份类实例问题。
> - **代价**：dist 从 724 KB 涨到约 1.06 MB（+340 KB）。
> - **安装纪律**：profile 的 `node_modules` 里**永远不该出现 `@deepseek-ai`**；
>   `scripts/verify-deployment.ps1` 现在把它当硬错误报出。装卸一律 link / junction，不要 `dsh plugin add`。
