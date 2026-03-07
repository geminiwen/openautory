import type { AgentOptions, McpStdioServerConfig, McpHttpServerConfig, McpSSEServerConfig } from '@openautory/core';
import { createLogger } from '@openautory/logger';
import type { LogLevel } from '@openautory/logger';

type GuestPermissionMode = Exclude<NonNullable<AgentOptions['permissionMode']>, 'bypassPermissions'>;

type ExternalMcpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSSEServerConfig;

const configLogger = createLogger('config');

function parseGuestPermissionMode(val: string | undefined): GuestPermissionMode | undefined {
  const valid: GuestPermissionMode[] = ['default', 'acceptEdits', 'plan', 'dontAsk'];
  return valid.includes(val as GuestPermissionMode) ? (val as GuestPermissionMode) : undefined;
}

function parseTools(val: string | undefined): string[] | undefined {
  return val ? val.split(',').map((t) => t.trim()) : undefined;
}

function parseOwnerIds(val: string | undefined): Set<string> {
  return new Set((val ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

function parseLogLevel(val: string | undefined): LogLevel {
  const valid: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  return valid.includes(val as LogLevel) ? (val as LogLevel) : 'info';
}

/**
 * 从环境变量 MCP_SERVERS 解析外部 MCP 服务器配置。
 * 格式为 JSON 对象，key 为服务器名称，value 为配置：
 *
 * stdio 示例：
 *   {"filesystem": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/"]}}
 *
 * http 示例：
 *   {"my-server": {"type": "http", "url": "http://localhost:3001"}}
 *
 * sse 示例：
 *   {"my-sse": {"type": "sse", "url": "http://localhost:3002/sse"}}
 */
function parseMcpServers(val: string | undefined): Record<string, ExternalMcpServerConfig> {
  if (!val) return {};
  try {
    const parsed = JSON.parse(val) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      configLogger.warn('MCP_SERVERS must be a JSON object, ignoring');
      return {};
    }
    return parsed as Record<string, ExternalMcpServerConfig>;
  } catch {
    configLogger.warn('Failed to parse MCP_SERVERS JSON, ignoring');
    return {};
  }
}

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),

  log: {
    level: parseLogLevel(process.env['LOG_LEVEL']),
    logDir: process.env['LOG_DIR'] ?? null,
  },

  anthropic: {
    model: process.env['CLAUDE_MODEL'],
    appendSystemPrompt: process.env['CLAUDE_APPEND_SYSTEM_PROMPT'],
    cwd: process.env['CLAUDE_CWD'],
    allowedTools: parseTools(process.env['CLAUDE_ALLOWED_TOOLS']),
    /** guest 角色的权限模式，默认 'default' */
    guestPermissionMode: parseGuestPermissionMode(process.env['CLAUDE_GUEST_PERMISSION_MODE']),
    /**
     * 额外的外部 MCP 服务器（stdio / http / sse）。
     * 与内置 messaging MCP 合并后传入 AgentCore。
     */
    extraMcpServers: parseMcpServers(process.env['MCP_SERVERS']),
  },

  ownerUserIds: parseOwnerIds(process.env['OWNER_USER_IDS']),
};
