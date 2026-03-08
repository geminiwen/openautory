# Claude 会话标题（summary）机制

本文说明 Claude Code 如何为会话生成“标题”（SDK 字段名为 `summary`），以及 OpenAutory 当前实现与其差异。

## 版本与范围

- 结论基于本项目当前依赖：`@anthropic-ai/claude-agent-sdk@0.2.71`
- 验证时间：2026-03-08
- 关注范围：`listSessions()` 返回的 `SDKSessionInfo`

## 核心字段

`listSessions()` 返回的每条会话元数据包含：

- `summary`: UI 展示标题
- `customTitle?`: 用户通过 `/rename` 设置的标题
- `firstPrompt?`: 首条“有意义”的用户输入

> SDK 类型注释对 `summary` 的描述是：`custom title / auto-generated summary / first prompt`。

## 标题生成优先级

在 `0.2.71` 的实现里，实际优先级为：

```ts
summary = customTitle || lastPrompt || summary || firstPrompt
```

说明：

- `customTitle`：用户手动改名（最高优先级）
- `lastPrompt`：最近一次有效用户输入（若存在）
- `summary`：会话内的自动摘要字段
- `firstPrompt`：首条有效用户输入（兜底）

## firstPrompt 提取规则（简化）

SDK 在扫描 `.jsonl` 时会过滤噪声，只取“主链路且有效”的用户文本，大致包括：

- 仅 `type === "user"`，且非 sidechain / 非 meta
- 跳过 `tool_result`
- 跳过 compact 摘要记录
- 跳过中断占位等系统化文本
- 多行会被压成单行空格
- 超过 200 字会截断并追加 `…`

## OpenAutory 当前实现

当前桌面端侧边栏会话名来自 Rust 侧本地解析，已按相同优先级生成：

- `customTitle > lastPrompt > summary > firstPrompt`
- 最终截断 80 字作为 `preview`

说明：

- 目前是“本地解析 `.jsonl`”实现，不是直接调用 SDK `listSessions()`。
- 在大多数场景下与 SDK 行为一致；若后续 SDK 增加新过滤规则，建议优先切换到 `listSessions()` 直读。

## 接入建议

若目标是“与 Claude Code 一致”：

1. 优先方案：在服务端直接调用 SDK `listSessions()`，使用返回的 `summary`。
2. 兼容方案：继续 Rust 本地解析，但把优先级改为 `customTitle > lastPrompt > summary > firstPrompt`。

## 快速验证示例

```ts
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

const sessions = await listSessions({ dir: "/Users/geminiwen/Code/openautory", limit: 5 });
console.log(
  sessions.map((s) => ({
    sessionId: s.sessionId,
    summary: s.summary,
    customTitle: s.customTitle,
    firstPrompt: s.firstPrompt,
  })),
);
```
