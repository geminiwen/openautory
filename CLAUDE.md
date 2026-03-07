# OpenAutory — Claude Code 指引

## 文档索引

| 文档 | 说明 |
|------|------|
| [docs/DEBUG.md](docs/DEBUG.md) | 调试与日志：日志文件位置、Rust/前端/server 日志用法、开发调试流程 |

## 项目结构

```
apps/server/     ← Bun HTTP + WebSocket server（端口 3000）
apps/desktop/    ← Tauri v2 桌面应用（React + Vite，端口 1420）
packages/shared/
packages/logger/
packages/core/        ← AgentCore，基于 @anthropic-ai/claude-agent-sdk
packages/adapters/http/
```

## 常用命令

```bash
# 编译 server sidecar（首次或 server 代码变更后必须执行）
cd apps/desktop && bun run build:server

# 启动桌面应用（开发模式）
cd apps/desktop && bun tauri dev

# 单独启动 server
cd apps/server && bun run --hot src/index.ts
```

## 技术约定

- **包管理**：Bun（workspace monorepo）
- **Rust 日志**：`log::info!` / `log::error!`，禁止用 `println!` / `eprintln!`
- **前端日志**：直接用 `console.*`（已 hook 到日志文件）
- **Tauri 版本**：v2（`tauri = "2"`，`@tauri-apps/cli: "^2"`）
