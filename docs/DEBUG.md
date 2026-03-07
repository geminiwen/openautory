# 调试与日志

## 架构概览

本项目包含三个独立进程，各有自己的日志输出：

```
Tauri 主进程（Rust）
  └── 日志：tauri-plugin-log → stdout + 系统日志文件
  └── 启动 ↓
      Server sidecar（Bun/Node）
        └── 日志：console.log → stdout（由 Rust 进程捕获后丢弃）
  └── 加载 ↓
      WebView（React）
        └── 日志：console.* → tauri-plugin-log IPC → 同一日志文件
```

---

## 日志文件位置

| 平台 | 路径 |
|------|------|
| macOS | `~/Library/Logs/com.openautory.desktop/` |
| Linux | `~/.local/share/com.openautory.desktop/logs/` |
| Windows | `%APPDATA%\com.openautory.desktop\logs\` |

实时查看（macOS/Linux）：

```bash
tail -f ~/Library/Logs/com.openautory.desktop/*.log
```

---

## Rust 端日志

使用 `log` crate 宏，不要用 `println!` / `eprintln!`：

```rust
log::info!("Server sidecar started");
log::warn!("Port {} already in use, retrying", port);
log::error!("Failed to spawn sidecar: {e}");
log::debug!("Received WS message: {:?}", msg);
```

日志级别默认 `INFO`，在 `main.rs` 的 `tauri_plugin_log::Builder` 中调整：

```rust
.level(log::LevelFilter::Debug)  // 改为 Debug 看更多细节
```

---

## 前端（React/WebView）日志

`console.*` 已在 `src/main.tsx` 中被 hook，自动转发到日志文件：

```ts
console.log('...');    // → INFO  级别
console.debug('...');  // → DEBUG 级别
console.warn('...');   // → WARN  级别
console.error('...');  // → ERROR 级别
```

也可以直接使用 `@tauri-apps/plugin-log` 的函数，附加结构化信息：

```ts
import { info, error } from '@tauri-apps/plugin-log';

await info('WebSocket connected');
await error('Connection failed: ' + err.message);
```

`attachConsole()` 已在启动时调用，Rust 侧的日志也会同步出现在浏览器 DevTools Console 里。

---

## Server 端日志

Server（`apps/server`）使用 `@openautory/logger`，通过环境变量控制：

```bash
# 开发时单独启动 server
LOG_LEVEL=debug bun run apps/server/src/index.ts

# 调整 sidecar 日志级别（通过 Tauri 环境变量透传）
# 在 src-tauri/src/main.rs 的 sidecar spawn 处加 .env("LOG_LEVEL", "debug")
```

---

## 开发调试流程

### 1. Tauri 开发模式

```bash
cd apps/desktop

# 先编译 server sidecar（首次或 server 代码变更后）
bun run build:server

# 启动（Vite dev server + Rust + sidecar 一起）
bun tauri dev
```

- Rust 日志 → 终端（stdout）+ 日志文件
- 前端日志 → 浏览器 DevTools Console + 日志文件

### 2. 打开浏览器 DevTools

在 Tauri 窗口中：
- macOS: `Cmd + Option + I`
- 或在 `tauri.conf.json` 的 `app.windows` 里加 `"devtools": true`

### 3. 单独调试 server

```bash
cd apps/server
LOG_LEVEL=debug bun run --hot src/index.ts
```

用 wscat 或 websocat 直接测试 WebSocket：

```bash
# 安装
npm i -g wscat

# 连接并发送消息
wscat -c ws://localhost:3000/ws
> {"type":"message","sessionId":"test","userId":"dev","content":"hello"}
```

### 4. 只调试前端（跳过 sidecar）

手动先启动 server，再单独启动 Vite：

```bash
# 终端 1
cd apps/server && bun run --hot src/index.ts

# 终端 2
cd apps/desktop && bun dev
# 在浏览器打开 http://localhost:1420
```

---

## 常见问题

**sidecar 启动失败**
- 检查日志文件里的 `ERROR` 行
- 确认已运行 `bun run build:server` 编译了 sidecar 二进制
- 确认 3000 端口未被占用：`lsof -i :3000`

**前端日志没写入文件**
- 确认 `capabilities/default.json` 包含 `"log:allow-log"`
- `attachConsole()` 必须在 React mount 之前完成（已在 `main.tsx` 的 `setup()` 中保证）

**看不到 Debug 级别日志**
- `main.rs` 中将 `.level(log::LevelFilter::Info)` 改为 `.level(log::LevelFilter::Debug)`
