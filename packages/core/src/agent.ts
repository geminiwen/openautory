import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, Options, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { UnifiedMessage, UserRole } from '@openautory/shared';
import { createLogger } from '@openautory/logger';
import type { Logger } from '@openautory/logger';
import { MemorySessionStore } from './session.js';
import type { SessionStore } from './session.js';

export interface AgentConfig {
  /** Claude 模型，默认使用 CLI 配置 */
  model?: string;
  /**
   * 在 Claude Code 默认系统提示词后追加额外内容。
   * Claude Code 内置工具描述等默认提示仍然保留。
   */
  appendSystemPrompt?: string;
  /** 最大 agentic turns 数，默认不限 */
  maxTurns?: number;
  /** Agent 工作目录，默认 process.cwd() */
  cwd?: string;
  /**
   * 允许的工具列表（无需用户确认自动执行）。
   * 可用内置工具：Read, Write, Edit, Glob, Grep, Bash, Task, WebFetch, WebSearch 等。
   * 留空则使用 SDK 默认行为（会询问权限）。
   */
  allowedTools?: string[];
  /**
   * guest 角色的权限模式（owner 固定使用 bypassPermissions）：
   * - 'default'      标准行为，危险操作会询问
   * - 'acceptEdits'  自动接受文件编辑
   * - 'dontAsk'      不询问，未预授权的工具直接拒绝
   * 默认 'default'
   */
  guestPermissionMode?: Exclude<Options['permissionMode'], 'bypassPermissions'>;
  /**
   * 是否将 session 持久化到磁盘（~/.claude/projects/）。
   * 设为 false 可避免在服务器上积累历史记录。
   * 默认 true。
   */
  persistSession?: boolean;
  sessionStore?: SessionStore;
  /**
   * 注入给 query() 的 MCP 服务器。
   * 支持以下类型：
   * - in-process：由 createSdkMcpServer() 创建的 SDK 服务器
   * - stdio：本地子进程 MCP 服务器（command + args）
   * - http / sse：远程 MCP 服务器（url）
   * key 为 MCP server 名称，value 为对应配置。
   */
  mcpServers?: Record<string, McpServerConfig>;
}

export type AgentMessageEvent = SDKMessage;

export class AgentCore {
  private readonly config: AgentConfig;
  private readonly session: SessionStore;
  private readonly logger: Logger;

  constructor(config: AgentConfig = {}) {
    this.config = config;
    this.session = config.sessionStore ?? new MemorySessionStore();
    this.logger = createLogger('agent');
  }

  /**
   * 处理统一消息，返回 Agent 最终文本回复。
   * 注意：claude-agent-sdk 每次 query() 会启动一个子进程，约有 10-15s 启动开销。
   */
  async processMessage(msg: UnifiedMessage): Promise<string> {
    let result = '';
    for await (const event of this.processMessageStream(msg)) {
      if (event.type === 'result') {
        if (event.subtype === 'success') {
          result = event.result;
        } else {
          throw new Error(
            `Agent error (${event.subtype}): ${event.errors?.join(', ') ?? 'unknown'}`,
          );
        }
      }
    }
    return result;
  }

  /**
   * 流式处理统一消息，yield 每一个 SDKMessage 事件。
   * 适合 WebSocket 场景，可实时转发 assistant/tool_progress 等事件给客户端。
   */
  async *processMessageStream(msg: UnifiedMessage): AsyncGenerator<SDKMessage> {
    const persist = this.config.persistSession ?? true;
    const entry = persist ? await this.session.get(msg.sessionId) : undefined;

    const options: Options = {
      ...(this.config.model ? { model: this.config.model } : {}),
      ...this.buildSystemPromptOption(),
      ...(this.config.maxTurns !== undefined ? { maxTurns: this.config.maxTurns } : {}),
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      ...(this.config.allowedTools ? { allowedTools: this.config.allowedTools } : {}),
      ...this.buildPermissionOptions(msg.role),
      persistSession: persist,
      ...(entry ? { resume: entry.claudeSessionId } : {}),
      ...(this.config.mcpServers ? { mcpServers: this.config.mcpServers } : {}),
    };

    let capturedSessionId: string | undefined;

    const q = query({ prompt: msg.content, options });

    for await (const event of q) {
      // 捕获 session_id（来自 system/init 消息）
      if (event.type === 'system' && event.subtype === 'init') {
        capturedSessionId = event.session_id;
      }

      // 输出所有事件（含 subtype）便于调试
      const { type, subtype } = event as { type: string; subtype?: string };
      this.logger.debug('SDK event', { type, subtype, event: JSON.stringify(event) });

      yield event;
    }

    // persistSession: false 时不追踪 session，避免下次 resume 失败
    if (!persist) return;

    const sessionId = capturedSessionId ?? entry?.claudeSessionId;
    if (sessionId) {
      await this.session.set(msg.sessionId, {
        claudeSessionId: sessionId,
        updatedAt: Date.now(),
      });
    }
  }

  private buildPermissionOptions(role: UserRole): Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions'> {
    if (role === 'owner') {
      return {
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      };
    }
    return {
      permissionMode: this.config.guestPermissionMode ?? 'default',
    };
  }

  private buildSystemPromptOption(): Pick<Options, 'systemPrompt'> {
    if (this.config.appendSystemPrompt) {
      return {
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: this.config.appendSystemPrompt,
        },
      };
    }
    return {};
  }

  /** 清除指定会话（下次交互将开启新 session） */
  async clearSession(sessionId: string): Promise<void> {
    await this.session.delete(sessionId);
  }
}
