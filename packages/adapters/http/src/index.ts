import type { ChannelAdapter, UnifiedMessage } from '@openautory/shared';
import crypto from 'node:crypto';

interface ChatRequest {
  sessionId?: string;
  userId?: string;
  content: string;
}

interface WsMessage {
  type: 'message';
  sessionId?: string;
  userId?: string;
  content: string;
}

export class HttpAdapter implements ChannelAdapter {
  readonly name = 'http' as const;

  async handleIncoming(req: Request): Promise<UnifiedMessage[]> {
    const body = await req.json() as ChatRequest;

    if (!body.content?.trim()) return [];

    const userId = body.userId ?? 'anonymous';
    const sessionId = body.sessionId ?? `http:${userId}`;

    return [
      {
        id: crypto.randomUUID(),
        sessionId,
        userId,
        role: 'guest',
      channel: 'http',
        content: body.content.trim(),
        timestamp: Date.now(),
      },
    ];
  }

  // HTTP 同步模式：reply 直接在 handler 返回，此方法为 no-op 以满足 ChannelAdapter 接口。
  async sendReply(_msg: UnifiedMessage, _content: string): Promise<void> {}

  /**
   * 将 WebSocket 消息解析为 UnifiedMessage。
   * WebSocket 连接管理由 server 层负责，adapter 只做消息格式转换。
   */
  parseWsMessage(rawData: string, connectionId: string): UnifiedMessage | null {
    let parsed: WsMessage;
    try {
      parsed = JSON.parse(rawData) as WsMessage;
    } catch {
      return null;
    }

    if (parsed.type !== 'message' || !parsed.content?.trim()) return null;

    const userId = parsed.userId ?? connectionId;
    const sessionId = parsed.sessionId ?? `ws:${userId}`;

    return {
      id: crypto.randomUUID(),
      sessionId,
      userId,
      role: 'guest',
      channel: 'ws',
      content: parsed.content.trim(),
      timestamp: Date.now(),
      metadata: { connectionId },
    };
  }
}
