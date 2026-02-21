import { createSdkMcpServer, tool } from '@openautory/core';
import type { McpSdkServerConfigWithInstance } from '@openautory/core';
import type { ChannelAdapter, SendTarget } from '@openautory/shared';
import { z } from 'zod/v4';

/**
 * 创建 messaging MCP server，暴露主动发送消息的工具给 Claude Agent。
 * 注册后，Claude 可在任务执行过程中主动调用 send_message 通知用户。
 */
export function createMessagingMcpServer(
  adapters: ReadonlyArray<ChannelAdapter>,
): McpSdkServerConfigWithInstance {
  // 只注册实现了主动发送能力（send 方法）的适配器
  const sendCapable = adapters.filter(
    (a): a is ChannelAdapter & Required<Pick<ChannelAdapter, 'send'>> =>
      typeof a.send === 'function',
  );
  const adapterMap = new Map(sendCapable.map((a) => [a.name, a]));

  return createSdkMcpServer({
    name: 'messaging',
    version: '0.1.0',
    tools: [
      tool(
        'send_message',
        `Send a message proactively to a user or group chat on a messaging platform.
Use this when you need to notify the user about task completion, errors, or any other updates.

Supported channels: ${[...adapterMap.keys()].join(', ')}
Target types:
  - user: send to an individual user (provide userId)
  - chat: send to a group chat (provide chatId)`,
        {
          channel: z.enum(['feishu', 'wecom', 'http', 'ws']).describe(
            'The messaging channel to send through',
          ),
          target_type: z.enum(['user', 'chat']).describe(
            'Whether to send to an individual user or a group chat',
          ),
          target_id: z.string().describe(
            'The userId (for user) or chatId (for chat) to send to',
          ),
          content: z.string().describe('The message content to send'),
        },
        async (args) => {
          const adapter = adapterMap.get(args.channel);
          if (!adapter) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: `Unknown channel: ${args.channel}` }],
            };
          }

          if (!adapter.send) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: `Channel ${args.channel} does not support proactive send` }],
            };
          }

          const target: SendTarget =
            args.target_type === 'chat'
              ? { type: 'chat', chatId: args.target_id }
              : { type: 'user', userId: args.target_id };

          try {
            await adapter.send(target, args.content);
            return {
              content: [{ type: 'text' as const, text: 'Message sent successfully' }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: `Send failed: ${String(err)}` }],
            };
          }
        },
      ),
    ],
  });
}
