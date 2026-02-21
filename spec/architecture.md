# OpenAutory - 架构规格

## 项目概述

OpenAutory 是一个 Claude Agent 网关服务，统一对接多个 IM 平台和 HTTP/WebSocket 接口，将用户消息转发给 Claude Agent（带工具调用能力）并回复。

**技术栈：** Bun + TypeScript (strict) + Anthropic SDK

---

## Monorepo 结构

```
openautory/
├── packages/
│   ├── shared/              # 公共类型、工具函数
│   ├── core/                # Claude Agent 核心引擎
│   └── adapters/
│       ├── feishu/          # 飞书/Lark 适配器
│       ├── wecom/           # 企业微信适配器
│       └── http/            # 自定义 HTTP + WebSocket 适配器
├── apps/
│   └── server/              # 主网关服务入口
├── package.json             # Bun Workspaces 根配置
└── bun.lockb
```

---

## 核心抽象层

### 1. UnifiedMessage（统一消息格式）

所有平台的消息都先归一化为 `UnifiedMessage`：

```typescript
interface UnifiedMessage {
  id: string;                          // 平台原始消息 ID
  sessionId: string;                   // 会话 ID（用于维持上下文）
  userId: string;                      // 用户标识
  channel: ChannelType;                // 来源渠道
  content: string;                     // 文本内容
  attachments?: Attachment[];          // 附件（图片/文件，可选）
  metadata?: Record<string, unknown>;  // 平台特有元数据
  timestamp: number;
}

type ChannelType = 'feishu' | 'wecom' | 'http' | 'ws';

interface Attachment {
  type: 'image' | 'file';
  url: string;
  mimeType?: string;
}
```

### 2. ChannelAdapter（渠道适配器接口）

每个平台实现此接口：

```typescript
interface ChannelAdapter {
  readonly name: ChannelType;

  // 处理平台 Webhook / HTTP 请求，返回归一化消息列表
  handleIncoming(req: Request): Promise<UnifiedMessage[]>;

  // 回复消息给平台用户
  sendReply(msg: UnifiedMessage, content: string): Promise<void>;

  // 验证平台签名（可选）
  verifySignature?(req: Request): Promise<boolean>;
}
```

### 3. AgentCore（Claude Agent 核心）

```typescript
interface Tool {
  name: string;
  description: string;
  // Zod schema + run handler（使用 betaZodTool 定义）
}

class AgentCore {
  constructor(config: AgentConfig);

  // 注册工具
  registerTool(tool: BetaZodTool): void;

  // 处理消息，返回 Agent 回复文本
  processMessage(msg: UnifiedMessage): Promise<string>;

  // 清理会话（释放历史）
  clearSession(sessionId: string): void;
}

interface AgentConfig {
  apiKey: string;
  model: string;               // e.g. 'claude-opus-4-6'
  maxTokens: number;
  systemPrompt?: string;
  maxIterations?: number;      // toolRunner 最大循环次数
}
```

---

## 消息流

```
IM Platform
    │
    ▼ (Webhook / Long-polling)
ChannelAdapter.handleIncoming()
    │  归一化为 UnifiedMessage
    ▼
MessageRouter (apps/server)
    │  按 channel 路由
    ▼
AgentCore.processMessage()
    │  维护会话历史
    │  调用 Anthropic toolRunner
    │  ↕ 工具调用循环
    ▼
AgentCore 返回文本
    │
    ▼
ChannelAdapter.sendReply()
    │
    ▼
IM Platform（回复给用户）
```

---

## 会话管理

- **Session Key：** `${channel}:${userId}`（或自定义 sessionId）
- **存储：** 默认内存 Map，预留 `SessionStore` 接口支持 Redis
- **历史格式：** Anthropic `MessageParam[]` 数组
- **过期策略：** TTL（默认 30 分钟无活动自动清理）

```typescript
interface SessionStore {
  get(sessionId: string): Promise<MessageParam[] | null>;
  set(sessionId: string, messages: MessageParam[], ttl?: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
}
```

---

## 各适配器说明

### 飞书 (Feishu/Lark)

- **接入方式：** 事件订阅 Webhook（POST）
- **消息类型：** `im.message.receive_v1`
- **签名验证：** X-Lark-Signature
- **回复方式：** 飞书消息 API（Bearer Token）
- **特殊处理：** 飞书 challenge 验证（首次配置）

### 企业微信 (WeCom)

- **接入方式：** 企业微信应用消息回调（GET/POST）
- **消息类型：** XML 格式
- **签名验证：** msg_signature + timestamp + nonce
- **加解密：** AES-CBC（企业微信消息加密）
- **回复方式：** 主动调用企业微信消息 API

### 自定义 HTTP / WebSocket

- **HTTP：** REST API，`POST /chat` 接收消息，同步返回回复
- **WebSocket：** `ws://host/ws`，双向实时通信
  - 客户端发 `{ type: 'message', sessionId, content }`
  - 服务端回 `{ type: 'reply', sessionId, content }` 或 `{ type: 'stream', delta }`

---

## 工具系统

使用 `@anthropic-ai/sdk` 的 `betaZodTool` 定义工具，工具在 `packages/core/src/tools/` 下按功能分文件：

```
packages/core/src/tools/
├── registry.ts      # 工具注册表
├── web-search.ts    # 示例：网页搜索工具
└── index.ts         # 导出所有默认工具
```

工具通过 `AgentCore.registerTool()` 动态注册，支持按渠道/租户差异化配置工具集。

---

## 配置

通过环境变量 + 可选配置文件驱动：

```env
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-opus-4-6
CLAUDE_MAX_TOKENS=4096

# 飞书
FEISHU_APP_ID=cli_...
FEISHU_APP_SECRET=...
FEISHU_VERIFICATION_TOKEN=...
FEISHU_ENCRYPT_KEY=...

# 企业微信
WECOM_CORP_ID=...
WECOM_AGENT_ID=...
WECOM_SECRET=...
WECOM_TOKEN=...
WECOM_ENCODING_AES_KEY=...

# 服务器
PORT=3000
```

---

## 包依赖关系

```
shared  ←──────────────────────┐
  ↑                            │
core (依赖 shared)             │
  ↑                            │
adapters/* (依赖 shared+core)  │
  ↑                            │
apps/server (依赖全部)─────────┘
```

---

## 开发路线

| 阶段 | 内容 |
|------|------|
| Phase 1 | 初始化 Monorepo，配置 Bun Workspaces + TypeScript |
| Phase 2 | 实现 `packages/shared` 类型定义 |
| Phase 3 | 实现 `packages/core`（Agent + Session + Tool Registry）|
| Phase 4 | 实现 `packages/adapters/http`（最简单，用于本地测试）|
| Phase 5 | 实现 `packages/adapters/feishu` |
| Phase 6 | 实现 `packages/adapters/wecom` |
| Phase 7 | 实现 `apps/server` 网关，集成所有适配器 |
| Phase 8 | 端到端测试 + 部署文档 |
