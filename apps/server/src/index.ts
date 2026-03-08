import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { AgentCore } from '@openautory/core';
import type { UnifiedMessage, UserRole } from '@openautory/shared';
import { createLogger } from '@openautory/logger';
import { HttpAdapter } from '@openautory/adapter-http';
import { buildMcpRegistry } from './mcp/index.js';
import { config } from './config.js';

interface WsData {
  connectionId: string;
  activeAborts: Map<string, AbortController>;
}

interface HotReloadState {
  stopServer?: () => void;
  removeSignalHandlers?: () => void;
}

const hotReloadState = (globalThis as typeof globalThis & { __openautoryHotReloadState?: HotReloadState }).__openautoryHotReloadState
  ?? ((globalThis as typeof globalThis & { __openautoryHotReloadState?: HotReloadState }).__openautoryHotReloadState = {});

// bun --hot 会重跑模块；先清理上一次实例，避免端口残留。
hotReloadState.removeSignalHandlers?.();
hotReloadState.stopServer?.();

const logger = createLogger('server', { level: config.log.level, logDir: config.log.logDir });

// ── 确保工作目录存在 ─────────────────────────────────────────────
const agentCwd = path.join(os.homedir(), '.autory');
fs.mkdirSync(agentCwd, { recursive: true });

// ── 初始化适配器 ────────────────────────────────────────────────
const httpAdapter = new HttpAdapter();

// ── 组装 MCP 服务器注册表 ───────────────────────────────────────
const activeAdapters = [httpAdapter];

const mcpServers = buildMcpRegistry(activeAdapters, config.anthropic.extraMcpServers);

// ── 初始化 Agent ────────────────────────────────────────────────
const agent = new AgentCore({
  ...(config.anthropic.model ? { model: config.anthropic.model } : {}),
  ...(config.anthropic.appendSystemPrompt ? { appendSystemPrompt: config.anthropic.appendSystemPrompt } : {}),
  cwd: agentCwd,
  ...(config.anthropic.allowedTools ? { allowedTools: config.anthropic.allowedTools } : {}),
  ...(config.anthropic.guestPermissionMode ? { guestPermissionMode: config.anthropic.guestPermissionMode } : {}),
  persistSession: true,
  mcpServers,
});

// ── 角色解析 ────────────────────────────────────────────────────
function resolveRole(userId: string): UserRole {
  return config.ownerUserIds.has(userId) ? 'owner' : 'guest';
}

function withRole(msg: UnifiedMessage): UnifiedMessage {
  return { ...msg, role: resolveRole(msg.userId) };
}

// ── HTTP 服务器（使用 Bun.serve）────────────────────────────────
const server = Bun.serve<WsData>({
  port: config.port,

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket 升级
    if (url.pathname === '/ws') {
      const connectionId = crypto.randomUUID();
      const success = server.upgrade(req, { data: { connectionId, activeAborts: new Map() } });
      return success ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
    }

    // 健康检查
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', model: config.anthropic.model ?? 'cli-default' });
    }

    // /chat 端点已移除，统一走 WebSocket
    return new Response('Not Found', { status: 404 });
  },

  websocket: {
    open(ws) {
      logger.info('WS connected', { connectionId: ws.data.connectionId });
    },

    async message(ws, rawData) {
      let parsed: { type?: string; sessionId?: string };
      try {
        parsed = JSON.parse(String(rawData));
      } catch {
        return;
      }

      // 处理取消请求
      if (parsed.type === 'cancel') {
        const sessionId = parsed.sessionId;
        if (sessionId) {
          ws.data.activeAborts.get(sessionId)?.abort();
        }
        ws.send(JSON.stringify({ type: 'cancelled', sessionId }));
        return;
      }

      const raw = httpAdapter.parseWsMessage(String(rawData), ws.data.connectionId);
      if (!raw) return;  // sessionId 缺失时静默忽略

      const msg = withRole(raw);
      const abortController = new AbortController();
      ws.data.activeAborts.set(msg.sessionId, abortController);

      logger.info('WS message received', { sessionId: msg.sessionId, userId: msg.userId, content: msg.content.slice(0, 80) });

      try {
        for await (const event of agent.processMessageStream(msg, abortController)) {
          const { type, subtype } = event as { type: string; subtype?: string };
          logger.info('SDK event', { type, subtype, ...(type === 'result' ? { event: JSON.stringify(event) } : {}) });

          if (event.type === 'system' && event.subtype === 'init') {
            logger.info('Session init', { sessionId: msg.sessionId, event: JSON.stringify(event) });
            ws.send(JSON.stringify({ type: 'session_init', sessionId: msg.sessionId }));
            continue;
          }

          if (event.type === 'system' && event.subtype === 'compact_boundary') {
            logger.info('Compact boundary', { sessionId: msg.sessionId });
            ws.send(JSON.stringify({ type: 'compact_boundary', sessionId: msg.sessionId }));
            continue;
          }

          if (event.type === 'result') {
            // SDK 分配的真实 session_id 可能与我们传入的不同（新建 session 时）
            const realSessionId = (event as Record<string, unknown>)['session_id'] as string | undefined;
            if (realSessionId && realSessionId !== msg.sessionId) {
              logger.info('Session ready', { clientSessionId: msg.sessionId, realSessionId });
              ws.send(JSON.stringify({ type: 'session_ready', sessionId: realSessionId }));
            }
          }

          if (
            event.type === 'assistant'
            || event.type === 'result'
            || event.type === 'tool_progress'
            || event.type === 'tool_use_summary'
          ) {
            ws.send(JSON.stringify({ type: event.type, sessionId: msg.sessionId, event }));
          }
        }
        logger.info('Stream finished', { sessionId: msg.sessionId });
      } catch (err) {
        logger.error('Stream error', { sessionId: msg.sessionId, err: String(err) });
        ws.send(JSON.stringify({ type: 'error', message: String(err) }));
      } finally {
        ws.data.activeAborts.delete(msg.sessionId);
      }
    },

    close(ws) {
      for (const controller of ws.data.activeAborts.values()) {
        controller.abort();
      }
      logger.info('WS disconnected', { connectionId: ws.data.connectionId });
    },
  },
});

logger.info('Server running', { port: server.port, cwd: agentCwd });
logger.info('Adapters initialized', { http: true, ws: true });

// 优雅关闭：等待已有请求完成后退出
function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  server.stop(true); // true = 等待已有请求完成
  process.exit(0);
}

const onSigTerm = () => shutdown('SIGTERM');
const onSigInt = () => shutdown('SIGINT');

process.on('SIGTERM', onSigTerm);
process.on('SIGINT', onSigInt);

const cleanup = () => {
  process.off('SIGTERM', onSigTerm);
  process.off('SIGINT', onSigInt);
  server.stop(true);
};

hotReloadState.removeSignalHandlers = () => {
  process.off('SIGTERM', onSigTerm);
  process.off('SIGINT', onSigInt);
};
hotReloadState.stopServer = () => {
  server.stop(true);
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    logger.info('Hot reload dispose, stopping previous server instance');
    cleanup();
  });
}
