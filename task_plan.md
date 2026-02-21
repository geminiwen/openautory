# Task Plan: OpenAutory - Claude Agent Gateway

## Goal
构建一个基于 Anthropic SDK (with tool calling) 的 IM 网关，支持飞书、企业微信、自定义 HTTP/WebSocket 三个渠道接入，Bun + TypeScript Monorepo 架构。

## Phases
- [x] Phase 1: 需求澄清 + 架构规划
- [x] Phase 2: 编写项目规格文档 (spec/)
- [x] Phase 3: 初始化 Monorepo 项目结构
- [x] Phase 4: 实现 core 包 (AgentCore + MemorySessionStore，基于 claude-agent-sdk query())
- [x] Phase 5: 实现各平台 Adapter
  - [x] 5a: shared 公共类型 (UnifiedMessage, ChannelAdapter)
  - [x] 5b: feishu adapter
  - [x] 5c: wecom adapter
  - [x] 5d: http/ws adapter
- [x] Phase 6: 实现 apps/server 网关入口
- [ ] Phase 7: 测试 & 文档

## Key Questions
1. ✅ 接入渠道：飞书、企业微信、自定义 HTTP/WebSocket
2. ✅ Agent 模式：带工具调用的 Agent (toolRunner)
3. ✅ 项目结构：Monorepo
4. Session 持久化需求？（内存 / Redis / 数据库）
5. 工具调用的具体工具是什么？（先留扩展点）

## Decisions Made
- SDK: `@anthropic-ai/sdk` with `betaZodTool` + `toolRunner`
- Runtime: Bun
- Language: TypeScript (strict)
- 结构: `packages/core`, `packages/adapters/*`, `packages/shared`, `apps/server`
- 消息统一抽象层：`UnifiedMessage` interface
- Adapter 统一抽象层：`ChannelAdapter` interface

## Errors Encountered
(暂无)

## Status
**Phase 2 完成** - spec/architecture.md 已输出，等待确认后进入 Phase 3（初始化项目）
