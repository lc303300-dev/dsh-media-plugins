# 壳程序自修改安全手册

DeepSeek Harness 的原生壳只负责启动后端、等待本地 HTTP 服务并承载 WebView2。任何插件、前端组件或媒体工具的加载失败都会表现为壳窗口错误，因此修改时必须先保证后端插件树可以独立启动。

## 修改顺序

1. 修改源码，不直接手改 `dist/`、`lib/` 或壳程序发布目录。
2. 对外部链接包先运行其 `scripts/start-task.ps1 -CheckOnly -SkipUpdate`。
3. 构建外部包并运行兼容性检查：

   `pnpm build`

   `powershell -File scripts/verify-dsh-compat.ps1`

4. 用备用端口独立启动 DSH 后端，确认 HTTP 返回 200，再构建和替换原生壳。
5. 替换壳程序前关闭旧的 `DeepSeekHarnessShell.exe`、Node 后端和 WebView2 子进程；保留上一份可启动的 exe。
6. 启动验证通过后，才把新功能加入 profile 的 `cordis.patch.yml`。

## DSH schema 规则

- Schemastery 没有 Zod 的 `.optional()`；对象字段需要用 `.default(...)` 或保持无默认字段。
- 工具输出 schema 不使用 `required` 字段。
- 每个 `type: object` 必须显式声明 `additionalProperties: true` 或 `false`。
- 先用 `node --import tsx/esm apps/cli/src/bin.ts web --host 127.0.0.1 --port 9799 --no-open` 验证插件树，再启动壳。

## 壳程序保护

- 托盘脚本不得自行启动后端；后端启动和端口选择只由原生壳负责。
- 不得在 WebView 导航失败时立即销毁健康后端；应先重试 HTTP，再显示诊断信息。
- 启动失败必须查看 `.codex-image-private/logs/dsh-web-*.err.log`，不能只根据 `ConnectionAborted` 判断原因。
- 修改壳时必须同时更新本手册，并执行 `git diff --check`、后端启动检查和 `dotnet build`。

## 回滚

若新版本失败，立即停止壳和后端，恢复上一份 exe 与插件 `dist/`，再启动验证。不要通过删除会话目录或凭证目录来“修复”启动问题。
