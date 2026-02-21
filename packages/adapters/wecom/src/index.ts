import type { ChannelAdapter, UnifiedMessage, SendTarget } from '@openautory/shared';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MEDIA_DIR = '/tmp/_openautory';

export interface WecomConfig {
  corpId: string;
  agentId: string;
  secret: string;
  token: string;
  encodingAESKey: string;
}

/** 企业微信解密后的消息内层字段 */
interface WecomInnerMessage {
  toUserName: string;
  fromUserName: string;
  msgType: string;
  content: string;
  msgId: string;
  agentId: string;
  /** 群聊消息才有 */
  chatId: string;
  /** 媒体消息公共字段 */
  mediaId: string;
  /** image 专用：缩略图直链 */
  picUrl: string;
  /** voice 专用：格式（amr / speex）*/
  format: string;
  /** file 专用：原始文件名 */
  fileName: string;
}

export class WecomAdapter implements ChannelAdapter {
  readonly name = 'wecom' as const;

  private readonly config: WecomConfig;
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  /** 用户名缓存：userId → displayName */
  private readonly userNameCache = new Map<string, string>();

  constructor(config: WecomConfig) {
    this.config = config;
  }

  async verifySignature(req: Request): Promise<boolean> {
    const url = new URL(req.url);
    const msgSignature = url.searchParams.get('msg_signature') ?? '';
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';

    if (req.method === 'GET') {
      // URL 验证阶段：签名 = sha1(sort([token, timestamp, nonce, echostr]))
      const echoStr = url.searchParams.get('echostr') ?? '';
      const sig = this.sha1([this.config.token, timestamp, nonce, echoStr].sort().join(''));
      return sig === msgSignature;
    }

    // POST 消息：签名 = sha1(sort([token, timestamp, nonce, encrypt]))
    const rawBody = await req.clone().text();
    const encrypt = this.extractXml(rawBody, 'Encrypt');
    if (!encrypt) return false;
    const sig = this.sha1([this.config.token, timestamp, nonce, encrypt].sort().join(''));
    return sig === msgSignature;
  }

  async handleIncoming(req: Request): Promise<UnifiedMessage[]> {
    if (req.method === 'GET') return [];

    const url = new URL(req.url);
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';
    const msgSignature = url.searchParams.get('msg_signature') ?? '';

    const rawBody = await req.text();
    const encrypt = this.extractXml(rawBody, 'Encrypt');
    if (!encrypt) return [];

    // 验证签名
    const expectedSig = this.sha1([this.config.token, timestamp, nonce, encrypt].sort().join(''));
    if (expectedSig !== msgSignature) return [];

    // 解密，然后再解析消息类型
    let inner: WecomInnerMessage;
    try {
      inner = this.decryptToMessage(encrypt);
    } catch {
      return [];
    }

    let content: string;
    switch (inner.msgType) {
      case 'text':
        if (!inner.content.trim()) return [];
        content = inner.content.trim();
        break;
      case 'image': {
        const filePath = await this.downloadMedia(inner.mediaId, inner.msgId, 'jpg');
        content = `![图片](${filePath})`;
        break;
      }
      case 'voice': {
        const ext = inner.format || 'amr';
        const filePath = await this.downloadMedia(inner.mediaId, inner.msgId, ext);
        content = `![语音](${filePath})`;
        break;
      }
      case 'video': {
        const filePath = await this.downloadMedia(inner.mediaId, inner.msgId, 'mp4');
        content = `![视频](${filePath})`;
        break;
      }
      case 'file': {
        const ext = inner.fileName ? path.extname(inner.fileName).slice(1) : 'bin';
        const filePath = await this.downloadMedia(inner.mediaId, inner.msgId, ext, inner.fileName);
        content = `![${inner.fileName || '文件'}](${filePath})`;
        break;
      }
      default:
        return [];
    }

    const sessionId = inner.chatId
      ? `wecom:chat:${inner.chatId}`
      : `wecom:${inner.fromUserName}`;

    // 异步拉取用户名（有缓存则直接用）
    const displayName = await this.fetchUserName(inner.fromUserName);

    // 群聊有 ChatId，单聊用发送者 userId 作为会话标识
    const chatId = inner.chatId || inner.fromUserName;

    const contextPrompt = this.buildContextPrompt({
      displayName,
      userId: inner.fromUserName,
      chatId,
    });

    return [
      {
        id: inner.msgId || crypto.randomUUID(),
        sessionId,
        userId: inner.fromUserName,
        role: 'guest',
        channel: 'wecom',
        content: contextPrompt + content,
        timestamp: Date.now(),
        metadata: {
          toUserName: inner.toUserName,
          chatId: inner.chatId || null,
          agentId: inner.agentId,
        },
      },
    ];
  }

  /** 被动回复：从 UnifiedMessage 元数据推导发送目标 */
  async sendReply(msg: UnifiedMessage, content: string): Promise<void> {
    const chatId = msg.metadata?.['chatId'] as string | null | undefined;
    const target: SendTarget = chatId
      ? { type: 'chat', chatId }
      : { type: 'user', userId: msg.userId };
    return this.send(target, content);
  }

  /** 主动发送：不依赖 incoming message */
  async send(target: SendTarget, content: string): Promise<void> {
    const token = await this.getAccessToken();

    const [endpoint, body] =
      target.type === 'chat'
        ? [
            'https://qyapi.weixin.qq.com/cgi-bin/appchat/send',
            { chatid: target.chatId, msgtype: 'text', text: { content }, safe: 0 },
          ]
        : [
            'https://qyapi.weixin.qq.com/cgi-bin/message/send',
            { touser: target.userId, msgtype: 'text', agentid: this.config.agentId, text: { content } },
          ];

    const resp = await fetch(`${endpoint}?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`WeCom send failed: ${resp.status}`);
    }
  }

  /** 下载临时媒体文件到本地，返回本地绝对路径 */
  private async downloadMedia(
    mediaId: string,
    msgId: string,
    defaultExt: string,
    originalName?: string,
  ): Promise<string> {
    const token = await this.getAccessToken();
    const resp = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${encodeURIComponent(mediaId)}`,
    );
    if (!resp.ok) throw new Error(`WeCom media download failed: ${resp.status}`);

    // 从 Content-Disposition 尝试获取文件名
    let fileName = originalName ?? '';
    if (!fileName) {
      const disposition = resp.headers.get('Content-Disposition') ?? '';
      const m = disposition.match(/filename[^;=\n]*=(?:(['"])([^'"]*)\1|([^;\s]*))/);
      fileName = m?.[2] ?? m?.[3] ?? '';
    }
    if (!fileName) {
      fileName = `${msgId}.${defaultExt}`;
    }

    await fs.mkdir(MEDIA_DIR, { recursive: true });
    const filePath = path.join(MEDIA_DIR, fileName);
    const buf = await resp.arrayBuffer();
    await fs.writeFile(filePath, Buffer.from(buf));
    return filePath;
  }

  // ── 内部工具 ──────────────────────────────────────────────────

  private buildContextPrompt(params: {
    displayName: string;
    userId: string;
    chatId: string;
  }): string {
    return (
      `<context>\n` +
      `Sender: @${params.displayName}(id:${params.userId},id_type:open_id)\n` +
      `ChatId: ${params.chatId}\n` +
      `</context>\n\n`
    );
  }

  private async fetchUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const token = await this.getAccessToken();
      const resp = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/user/get?access_token=${token}&userid=${encodeURIComponent(userId)}`,
      );
      const data = await resp.json() as { name?: string; alias?: string; errcode?: number };
      const name = data.name ?? data.alias ?? userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const resp = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${this.config.corpId}&corpsecret=${this.config.secret}`,
    );
    const data = await resp.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;

    return this.accessToken;
  }

  private sha1(str: string): string {
    return crypto.createHash('sha1').update(str).digest('hex');
  }

  private extractXml(xml: string, tag: string): string {
    const match = xml.match(
      new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}>([\\s\\S]*?)</${tag}>`),
    );
    return match?.[1] ?? match?.[2] ?? '';
  }

  private decryptToMessage(encrypted: string): WecomInnerMessage {
    const key = Buffer.from(this.config.encodingAESKey + '=', 'base64');
    const iv = key.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);

    let buf = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]);

    // 去除 PKCS7 padding
    const padLen = buf[buf.length - 1] ?? 0;
    buf = buf.subarray(0, buf.length - padLen);

    // 格式：16字节随机数 + 4字节消息长度（big-endian）+ 消息内容 + corpId
    const msgLen = buf.readUInt32BE(16);
    const innerXml = buf.subarray(20, 20 + msgLen).toString('utf8');

    return {
      toUserName: this.extractXml(innerXml, 'ToUserName'),
      fromUserName: this.extractXml(innerXml, 'FromUserName'),
      msgType: this.extractXml(innerXml, 'MsgType'),
      content: this.extractXml(innerXml, 'Content'),
      msgId: this.extractXml(innerXml, 'MsgId'),
      agentId: this.extractXml(innerXml, 'AgentID'),
      chatId: this.extractXml(innerXml, 'ChatId'),
      mediaId: this.extractXml(innerXml, 'MediaId'),
      picUrl: this.extractXml(innerXml, 'PicUrl'),
      format: this.extractXml(innerXml, 'Format'),
      fileName: this.extractXml(innerXml, 'FileName'),
    };
  }
}
