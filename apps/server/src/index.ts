import { AgentCore } from '@openautory/core';
import type { UnifiedMessage, UserRole } from '@openautory/shared';
import { createLogger } from '@openautory/logger';
import { FeishuAdapter } from '@openautory/adapter-feishu';
import { WecomAdapter } from '@openautory/adapter-wecom';
import { HttpAdapter } from '@openautory/adapter-http';
import { buildMcpRegistry } from './mcp/index.js';
import { config } from './config.js';

interface WsData {
  connectionId: string;
}

const logger = createLogger('server', { level: config.log.level, logDir: config.log.logDir });

// ── 初始化适配器 ────────────────────────────────────────────────
const httpAdapter = new HttpAdapter();

const feishuAdapter = config.feishu.enabled
  ? new FeishuAdapter({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      verificationToken: config.feishu.verificationToken,
      ...(config.feishu.encryptKey ? { encryptKey: config.feishu.encryptKey } : {}),
    })
  : null;

const wecomAdapter = config.wecom.enabled
  ? new WecomAdapter({
      corpId: config.wecom.corpId,
      agentId: config.wecom.agentId,
      secret: config.wecom.secret,
      token: config.wecom.token,
      encodingAESKey: config.wecom.encodingAESKey,
    })
  : null;

// ── 组装 MCP 服务器注册表 ───────────────────────────────────────
const activeAdapters = [httpAdapter, feishuAdapter, wecomAdapter].filter(
  (a): a is NonNullable<typeof a> => a !== null,
);

const mcpServers = buildMcpRegistry(activeAdapters, config.anthropic.extraMcpServers);

// ── 初始化 Agent ────────────────────────────────────────────────
const agent = new AgentCore({
  ...(config.anthropic.model ? { model: config.anthropic.model } : {}),
  ...(config.anthropic.appendSystemPrompt ? { appendSystemPrompt: config.anthropic.appendSystemPrompt } : {}),
  ...(config.anthropic.cwd ? { cwd: config.anthropic.cwd } : {}),
  ...(config.anthropic.allowedTools ? { allowedTools: config.anthropic.allowedTools } : {}),
  ...(config.anthropic.guestPermissionMode ? { guestPermissionMode: config.anthropic.guestPermissionMode } : {}),
  persistSession: false,
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
      const success = server.upgrade(req, { data: { connectionId } });
      return success ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
    }

    // 健康检查
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', model: config.anthropic.model ?? 'cli-default' });
    }

    // 自定义 HTTP 聊天接口（等待最终结果）
    if (url.pathname === '/chat' && req.method === 'POST') {
      const msgs = await httpAdapter.handleIncoming(req);
      if (msgs.length === 0) {
        return Response.json({ error: 'Invalid request' }, { status: 400 });
      }

      const msg = withRole(msgs[0]!);
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (data: unknown) =>
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          try {
            for await (const event of agent.processMessageStream(msg)) {
              send(event);
            }
          } catch (err) {
            send({ type: 'error', error: String(err) });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }

    // 飞书 Webhook
    if (url.pathname === '/webhook/feishu' && feishuAdapter) {
      const body = await req.clone().json() as { challenge?: string };
      if (body.challenge) {
        return Response.json({ challenge: body.challenge });
      }

      const msgs = await feishuAdapter.handleIncoming(req);
      for (const msg of msgs) {
        const m = withRole(msg);
        agent.processMessage(m)
          .then((reply) => feishuAdapter.sendReply(m, reply))
          .catch((e) => logger.error('Feishu reply failed', { error: String(e) }));
      }
      return new Response('OK');
    }

    // 企业微信 Webhook
    if (url.pathname === '/webhook/wecom' && wecomAdapter) {
      if (req.method === 'GET') {
        const echoStr = new URL(req.url).searchParams.get('echostr') ?? '';
        return new Response(echoStr);
      }

      const msgs = await wecomAdapter.handleIncoming(req);
      for (const msg of msgs) {
        const m = withRole(msg);
        agent.processMessage(m)
          .then((reply) => wecomAdapter.sendReply(m, reply))
          .catch((e) => logger.error('Wecom reply failed', { error: String(e) }));
      }
      return new Response('');
    }

    return new Response('Not Found', { status: 404 });
  },

  websocket: {
    open(ws) {
      logger.info('WS connected', { connectionId: ws.data.connectionId });
    },

    async message(ws, rawData) {
      const raw = httpAdapter.parseWsMessage(String(rawData), ws.data.connectionId);
      if (!raw) return;

      const msg = withRole(raw);

      try {
        for await (const event of agent.processMessageStream(msg)) {
          if (event.type === 'assistant') {
            ws.send(JSON.stringify({ type: 'assistant', sessionId: msg.sessionId, event }));
          } else if (event.type === 'result') {
            ws.send(JSON.stringify({ type: 'result', sessionId: msg.sessionId, event }));
          } else if (event.type === 'system' && event.subtype === 'init') {
            ws.send(JSON.stringify({ type: 'session_init', sessionId: msg.sessionId }));
          }
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: String(err) }));
      }
    },

    close(ws) {
      logger.info('WS disconnected', { connectionId: ws.data.connectionId });
    },
  },
});

logger.info('Server running', { port: server.port });
logger.info('Adapters initialized', { feishu: !!feishuAdapter, wecom: !!wecomAdapter, http: true, ws: true });
