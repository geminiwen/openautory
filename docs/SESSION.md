# Session 管理机制

## 路径约定

Claude Code 将 session 文件存储于：

```
~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
```

**编码规则**：将 cwd 绝对路径中的 `/` 和 `.` 全部替换为 `-`。

示例：

| cwd | encoded |
|-----|---------|
| `/Users/geminiwen/.autory` | `-Users-geminiwen--autory` |
| `/Users/geminiwen/Code/openautory` | `-Users-geminiwen-Code-openautory` |

桌面端固定使用 `~/.autory` 作为 cwd，对应目录：

```
~/.claude/projects/-Users-geminiwen--autory/
```

---

## Session 文件格式

每个 `.jsonl` 文件每行一条 JSON 记录，主要类型：

| type | 说明 |
|------|------|
| `file-history-snapshot` | 第一行，SDK 创建 session 时写入 |
| `user` | 用户消息 |
| `assistant` | AI 消息 |
| `progress` | 工具调用中间状态 |
| `system` | 系统事件 |

**关键字段**：

- `isSidechain: false` — 主对话链（true 为子 agent）
- `message.content` — 消息内容数组，`type: 'text'` 的 block 是正文
- `message.content[].type: 'tool_use'` / `'tool_result'` — 工具调用，UI 可跳过

---

## 启动流程

```
桌面端启动
  → Rust get_or_create_session("~/.autory")
      扫描 ~/.claude/projects/-Users-geminiwen--autory/*.jsonl
      找到 size > 300 字节的文件（有真实对话） → 返回其 UUID
      否则 → 返回空字符串
  → 前端拿到 sessionId（可能为空）

用户发消息
  → WebSocket 发送 { type: 'message', sessionId, content }
  → AgentCore.processMessageStream(msg)
      sessionId 非空 → options 加 resume: sessionId（SDK 恢复历史）
      sessionId 为空 → 不传 resume（SDK 新建 session）
  → SDK 处理完成后写 ~/.claude/projects/-Users-geminiwen--autory/<uuid>.jsonl
  → result 事件携带 session_id
  → server 检测到新 session_id → 发送 { type: 'session_ready', sessionId }
  → 前端更新 sessionId 状态，后续消息携带此 ID
```

---

## 历史消息恢复

Rust command `read_session_messages(sessionId, cwd)`：

1. 打开 `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
2. 逐行解析，过滤 `isSidechain: false` 的 `user` / `assistant` 行
3. `user`：取 `content[].type == 'text'` 的第一个 block
4. `assistant`：拼接所有 `type == 'text'` block
5. 返回 `[{ role, text }]`，前端映射为 `Message[]`

---

## 注意事项

- SDK 只能 `resume` 它自己创建的 session（有内部索引），不能伪造 UUID
- stub 文件（仅含 `file-history-snapshot`，≤300 字节）无法被 resume
- `get_or_create_session` 通过文件大小 > 300 字节区分真实 session 与 stub
