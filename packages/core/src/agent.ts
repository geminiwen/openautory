import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, Options, McpServerConfig, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import type { UnifiedMessage, UserRole } from '@openautory/shared';
import { createLogger } from '@openautory/logger';
import type { Logger } from '@openautory/logger';

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
  /**
   * 注入给 query() 的 MCP 服务器。
   * 支持以下类型：
   * - in-process：由 createSdkMcpServer() 创建的 SDK 服务器
   * - stdio：本地子进程 MCP 服务器（command + args）
   * - http / sse：远程 MCP 服务器（url）
   * key 为 MCP server 名称，value 为对应配置。
   */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * 加载哪些来源的 Claude Code 配置文件。
   * - 'user'    ~/.claude/settings.json（全局用户配置）
   * - 'project' .claude/settings.json（项目级配置，同时启用 CLAUDE.md 读取）
   * - 'local'   .claude/settings.local.json（本地覆盖，不提交到 git）
   * 默认：['user', 'project', 'local']
   */
  settingSources?: SettingSource[];
}

export type AgentMessageEvent = SDKMessage;

export class AgentCore {
  private readonly config: AgentConfig;
  private readonly logger: Logger;

  constructor(config: AgentConfig = {}) {
    this.config = config;
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
   * 传入 abortController 可在外部中断流。
   */
  async *processMessageStream(msg: UnifiedMessage, abortController?: AbortController): AsyncGenerator<SDKMessage> {
    const persist = this.config.persistSession ?? true;
    this.logger.info('processMessageStream start', { sessionId: msg.sessionId, persist, cwd: this.config.cwd });

    const options: Options = {
      debug: true,
      ...(this.config.model ? { model: this.config.model } : {}),
      ...this.buildSystemPromptOption(),
      ...(this.config.maxTurns !== undefined ? { maxTurns: this.config.maxTurns } : {}),
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      ...(this.config.allowedTools ? { allowedTools: this.config.allowedTools } : {}),
      ...this.buildPermissionOptions(msg.role),
      persistSession: persist,
      ...(persist && msg.sessionId ? { resume: msg.sessionId } : {}),
      ...(this.config.mcpServers ? { mcpServers: this.config.mcpServers } : {}),
      settingSources: this.config.settingSources ?? ['user', 'project', 'local'],
      ...(abortController ? { abortController } : {}),
      stderr: (data: string) => {
        this.logger.error('SDK stderr', { data: data.trimEnd() });
      },
    };

    this.logger.info('query options', {
      model: options.model,
      cwd: options.cwd,
      persistSession: options.persistSession,
      resume: (options as Record<string, unknown>)['resume'],
    });

    const q = query({ prompt: msg.content, options });

    try {
      for await (const event of q) {
        const { type, subtype, is_error } = event as { type: string; subtype?: string; is_error?: boolean };
        const isError = is_error || (subtype && subtype.startsWith('error_'));
        if (isError) {
          this.logger.error('SDK event', { type, subtype, is_error });
        } else {
          this.logger.debug('SDK event', { type, subtype });
        }

        yield event;
      }
    } catch (err) {
      if (abortController?.signal.aborted) {
        this.logger.info('Stream aborted', { sessionId: msg.sessionId });
        return;
      }
      throw err;
    }
  }

  /** 判断 session 文件是否存在且包含真实对话数据（SDK 自建，>1 行）。 */
  private hasRealSessionData(sessionId: string): boolean {
    if (!sessionId) return false;
    const cwd = this.config.cwd ?? process.cwd();
    const encoded = cwd.replace(/[/.]/g, '-');
    const file = path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
    return lines.length > 1;
  }

  private buildPermissionOptions(_role: UserRole): Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions'> {
    return {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
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

  /** 清除指定会话（删除磁盘上的 .jsonl 文件） */
  clearSession(sessionId: string): void {
    const cwd = this.config.cwd ?? process.cwd();
    const encoded = cwd.replace(/[/.]/g, '-');
    const file = path.join(os.homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      this.logger.info('Session file deleted', { sessionId });
    }
  }
}
