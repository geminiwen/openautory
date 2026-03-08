import type { ChannelAdapter, UnifiedMessage } from '@openautory/shared';
import crypto from 'node:crypto';

interface WsMessage {
  type: 'message';
  sessionId?: string;
  userId?: string;
  content: string;
}

export class HttpAdapter implements ChannelAdapter {
  readonly name = 'http' as const;

  // HTTP /chat 端点已移除，此方法保留以满足 ChannelAdapter 接口但不再使用。
  async handleIncoming(_req: Request): Promise<UnifiedMessage[]> {
    return [];
  }

  // HTTP 同步模式：reply 直接在 handler 返回，此方法为 no-op 以满足 ChannelAdapter 接口。
  async sendReply(_msg: UnifiedMessage, _content: string): Promise<void> {}

  /**
   * 将 WebSocket 消息解析为 UnifiedMessage。
   * sessionId 可选；缺失时传空字符串，由 AgentCore 决定是否 resume。
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

    return {
      id: crypto.randomUUID(),
      sessionId: parsed.sessionId,
      userId,
      role: 'guest',
      channel: 'ws',
      content: parsed.content.trim(),
      timestamp: Date.now(),
      metadata: { connectionId },
    };
  }
}
