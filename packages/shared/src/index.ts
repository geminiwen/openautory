export type ChannelType = 'feishu' | 'wecom' | 'http' | 'ws';

/** owner：完全信任，bypassPermissions；guest：受限权限 */
export type UserRole = 'owner' | 'guest';

export interface Attachment {
  type: 'image' | 'file';
  url: string;
  mimeType?: string;
}

export interface UnifiedMessage {
  /** 平台原始消息 ID */
  id: string;
  /** 会话 ID，用于维持多轮上下文，格式建议 `${channel}:${userId}` */
  sessionId: string;
  /** 用户标识（平台内唯一） */
  userId: string;
  /** 来源渠道 */
  channel: ChannelType;
  /** 用户角色，由 server 路由层根据配置打标 */
  role: UserRole;
  /** 文本内容 */
  content: string;
  /** 附件（图片/文件） */
  attachments?: Attachment[];
  /** 平台特有元数据，透传给适配器内部使用 */
  metadata?: Record<string, unknown>;
  timestamp: number;
}

/**
 * 主动发送消息的目标。
 * - `type: 'user'`  发送给单个用户（by userId）
 * - `type: 'chat'`  发送给群聊（by chatId，如企业微信群）
 */
export type SendTarget =
  | { type: 'user'; userId: string }
  | { type: 'chat'; chatId: string };

export interface ChannelAdapter {
  readonly name: ChannelType;

  /**
   * 处理来自平台的 Webhook / HTTP 请求。
   * 返回归一化消息列表（一次请求可能携带多条消息）。
   */
  handleIncoming(req: Request): Promise<UnifiedMessage[]>;

  /**
   * 被动回复：回复某条收到的消息。
   * target 从 UnifiedMessage 中派生，保留完整上下文。
   */
  sendReply(msg: UnifiedMessage, content: string): Promise<void>;

  /**
   * 主动发送：不依赖 incoming message，直接向用户或群聊推送。
   * 适用于任务完成通知、报警推送等主动场景。
   * 不支持主动推送的适配器（如纯 HTTP 请求-响应模式）可不实现此方法。
   */
  send?(target: SendTarget, content: string): Promise<void>;

  /** 验证平台签名（可选，返回 false 时应拒绝请求） */
  verifySignature?(req: Request): Promise<boolean>;
}
