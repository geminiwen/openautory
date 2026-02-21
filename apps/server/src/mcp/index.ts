import type { McpServerConfig, McpSdkServerConfigWithInstance } from '@openautory/core';
import type { ChannelAdapter } from '@openautory/shared';
import { createMessagingMcpServer } from './messaging.js';

export type { McpSdkServerConfigWithInstance };

/**
 * 组装所有 MCP 服务器并返回合并后的注册表。
 *
 * 内置：
 *   - messaging：暴露主动发消息工具给 Agent（仅含实现了 send() 的适配器）
 *
 * 外部（通过 extraMcpServers 注入，来自环境变量 MCP_SERVERS）：
 *   - stdio / http / sse 类型的外部 MCP 服务器
 *
 * 新增内置 MCP 时，在此文件 import 并加入 builtins 对象即可。
 */
export function buildMcpRegistry(
  adapters: ReadonlyArray<ChannelAdapter>,
  extraMcpServers: Record<string, McpServerConfig> = {},
): Record<string, McpServerConfig> {
  const builtins: Record<string, McpSdkServerConfigWithInstance> = {
    messaging: createMessagingMcpServer(adapters),
  };

  return {
    ...builtins,
    ...extraMcpServers,
  };
}
