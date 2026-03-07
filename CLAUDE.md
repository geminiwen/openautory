# OpenAutory — Claude Code 指引

## 层级命名约定

| 术语 | 指代 | 位置 |
|------|------|------|
| **桌面端** | Tauri 桌面应用 | `apps/desktop/` |
| **内核** | Bun HTTP/WS 服务 | `apps/server/` |
| **适配器** | 各平台 IM 接入层 | `packages/adapters/` |

## 文档索引

| 文档 | 说明 |
|------|------|
| [docs/DEBUG.md](docs/DEBUG.md) | 调试与日志：日志文件位置、Rust/前端/内核日志用法、调试流程 |
| [spec/architecture.md](spec/architecture.md) | 架构设计文档 |

---

## 项目结构

```
openautory/
├── apps/
│   ├── server/                     ← 内核：Bun HTTP + WebSocket 服务（端口 3000）
│   │   └── src/
│   │       ├── index.ts            ← 服务入口：路由 /chat /ws /health
│   │       ├── config.ts           ← 环境变量解析
│   │       └── mcp/
│   │           ├── index.ts        ← MCP 注册表
│   │           └── messaging.ts    ← 向外暴露 send_message 工具
│   │
│   └── desktop/                    ← 桌面端：Tauri v2 + React + Vite（端口 1420）
│       ├── src/
│       │   ├── main.tsx            ← React 入口 + Tauri 日志 hook
│       │   ├── App.tsx             ← 根布局：自定义标题栏 + Chat + Settings Drawer
│       │   └── components/
│       │       ├── Chat.tsx        ← Chat UI：WebSocket 客户端 + Bubble.List + Sender
│       │       └── Settings.tsx    ← 服务器 URL 配置（localStorage 持久化）
│       └── src-tauri/
│           ├── src/main.rs         ← Rust 主进程：启动/停止内核进程
│           ├── tauri.conf.json
│           ├── Cargo.toml
│           ├── capabilities/
│           │   └── default.json    ← 权限声明
│           └── icons/              ← 应用图标（RGBA PNG）
│
├── packages/
│   ├── shared/                     ← 公共类型：UnifiedMessage、ChannelAdapter、UserRole
│   ├── logger/                     ← 结构化日志：JSON 输出 + 文件轮转
│   ├── core/                       ← Claude Agent 引擎：AgentCore + SessionStore
│   └── adapters/
│       ├── http/                   ← HTTP REST + WebSocket 消息解析
│       ├── feishu/                 ← 飞书适配器（OAuth + 签名验证）
│       └── wecom/                  ← 企业微信适配器（AES 加密 + 签名）
│
├── spec/                           ← 设计文档
├── docs/                           ← 开发文档
├── CLAUDE.md                       ← 本文件
├── package.json                    ← Bun workspace 根配置
└── tsconfig.json                   ← TypeScript 基础配置
```

---

## 消息流

```
用户（飞书 / 企业微信 / HTTP / WebSocket）
  ↓  ChannelAdapter.handleIncoming() → UnifiedMessage
内核 apps/server
  ↓  AgentCore.processMessageStream()
@anthropic-ai/claude-agent-sdk
  ↓  流式事件（assistant / tool / result）
内核 → WebSocket 推送给桌面端 / SSE 推送给 HTTP 客户端
```

---

## 包依赖关系

```
shared ←── logger
       ←── core ←── adapter-http ←── server
       ←── adapter-feishu          ←── desktop（WebSocket 直连内核）
       ←── adapter-wecom
```

---

## 常用命令

```bash
# 从根目录启动桌面端（dev 模式，自动启动内核）
bun run dev

# 单独启动内核（调试用）
cd apps/server && bun run --hot src/index.ts

# 编译内核 sidecar（打包前必须）
cd apps/desktop && bun run build:server

# 打包桌面端
cd apps/desktop && bun run tauri:build
```

---

## 技术约定

- **包管理**：Bun（workspace monorepo）
- **Rust 日志**：`log::info!` / `log::error!`，禁止用 `println!` / `eprintln!`
- **前端日志**：直接用 `console.*`（已 hook 到日志文件）
- **Tauri 版本**：v2
- **React**：v19，函数组件 + hooks
- **内核 dev 模式**：`bun run --hot`（热重载）；release 模式：编译 sidecar
- **端口**：内核 3000，桌面端 Vite 1420
