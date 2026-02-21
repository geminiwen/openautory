import type { ChannelAdapter, UnifiedMessage, SendTarget } from '@openautory/shared';
import crypto from 'node:crypto';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  /** 消息加密 key（启用加密时必填） */
  encryptKey?: string;
}

interface FeishuEventBody {
  schema?: string;
  header?: {
    event_type?: string;
  };
  event?: {
    message?: {
      message_id?: string;
      message_type?: string;
      content?: string;
      chat_id?: string;
    };
    sender?: {
      sender_id?: {
        open_id?: string;
      };
    };
  };
  challenge?: string;
  token?: string;
}

export class FeishuAdapter implements ChannelAdapter {
  readonly name = 'feishu' as const;

  private readonly config: FeishuConfig;
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  async verifySignature(req: Request): Promise<boolean> {
    // 飞书签名验证（简化版，仅验证 token）
    // 完整实现需验证 X-Lark-Signature header
    const body = await req.clone().json() as FeishuEventBody;
    return body.token === this.config.verificationToken;
  }

  async handleIncoming(req: Request): Promise<UnifiedMessage[]> {
    const body = await req.json() as FeishuEventBody;

    // 处理 URL 验证（首次配置飞书 Webhook 时）
    if (body.challenge) {
      return [];
    }

    const event = body.event;
    if (!event?.message || event.message.message_type !== 'text') {
      return [];
    }

    const messageId = event.message.message_id ?? crypto.randomUUID();
    const userId = event.sender?.sender_id?.open_id ?? 'unknown';
    const sessionId = `feishu:${userId}`;

    let content = '';
    try {
      const parsed = JSON.parse(event.message.content ?? '{}') as { text?: string };
      content = parsed.text ?? '';
    } catch {
      return [];
    }

    return [
      {
        id: messageId,
        sessionId,
        userId,
        role: 'guest',
        channel: 'feishu',
        content: content.trim(),
        timestamp: Date.now(),
        metadata: { chatId: event.message.chat_id },
      },
    ];
  }

  /** 被动回复：从 UnifiedMessage 元数据推导发送目标 */
  async sendReply(msg: UnifiedMessage, content: string): Promise<void> {
    const chatId = msg.metadata?.['chatId'] as string | undefined;
    const target: SendTarget = chatId
      ? { type: 'chat', chatId }
      : { type: 'user', userId: msg.userId };
    return this.send(target, content);
  }

  /** 主动发送：直接指定目标 */
  async send(target: SendTarget, content: string): Promise<void> {
    const token = await this.getAccessToken();

    // 飞书：user 用 open_id 发单聊，chat 用 chat_id 发群聊
    const [receiveId, receiveIdType] =
      target.type === 'chat'
        ? [target.chatId, 'chat_id']
        : [target.userId, 'open_id'];

    const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        receive_id: receiveId,
        receive_id_type: receiveIdType,
        msg_type: 'text',
        content: JSON.stringify({ text: content }),
      }),
    });

    if (!resp.ok) {
      throw new Error(`Feishu send failed: ${resp.status} ${await resp.text()}`);
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const resp = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      },
    );

    const data = await resp.json() as { tenant_access_token: string; expire: number };
    this.accessToken = data.tenant_access_token;
    // 提前 5 分钟刷新
    this.tokenExpiry = Date.now() + (data.expire - 300) * 1000;

    return this.accessToken;
  }
}
