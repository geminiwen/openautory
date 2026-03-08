import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { CheckOutlined, FolderAddOutlined, FolderOutlined, UpOutlined } from '@ant-design/icons';
import { Bubble, Sender } from '@ant-design/x';
import { Dropdown } from 'antd';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Components } from 'react-markdown';
import type { ProjectInfo } from './Sidebar';
import CollapsiblePanel from './CollapsiblePanel';
import styles from './Chat.module.css';

const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? '');
    if (match) {
      return (
        <SyntaxHighlighter
          style={oneLight}
          language={match[1]}
          PreTag="div"
          customStyle={{
            margin: '0.6em 0',
            borderRadius: '8px',
            fontSize: '13px',
            lineHeight: '1.5',
            background: 'rgba(0,0,0,0.04)',
          }}
          codeTagProps={{ style: { fontFamily: "'SF Mono', Menlo, Consolas, monospace" } }}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
};

const renderMarkdown = (content: string) => (
  <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</Markdown>
);

interface ToolUseTrace {
  id: string;
  name: string;
  inputPreview: string;
  progress: string[];
  summary?: string;
}

export type ContentBlock =
  | { type: 'thinking'; key: string; text: string }
  | { type: 'text'; key: string; text: string }
  | { type: 'tool_use'; key: string; toolUse: ToolUseTrace };

type RenderGroup =
  | { type: 'thinking'; key: string; text: string }
  | { type: 'text'; key: string; text: string }
  | { type: 'tool_group'; key: string; tools: ToolUseTrace[] };

interface UserMessage {
  key: string;
  role: 'user';
  content: string;
  subtext?: string;
}

export interface AiMessage {
  key: string;
  role: 'ai';
  blocks: ContentBlock[];
  loading?: boolean;
}

export type Message = UserMessage | AiMessage;

interface AssistantTextBlock {
  type: 'text';
  text?: string;
}

interface AssistantThinkingBlock {
  type: 'thinking';
  thinking?: string;
  text?: string;
}

interface AssistantToolUseBlock {
  type: 'tool_use';
  id?: string;
  name?: string;
  input?: unknown;
}

interface AssistantUnknownBlock {
  type: string;
  [key: string]: unknown;
}

type AssistantContentBlock =
  | AssistantTextBlock
  | AssistantThinkingBlock
  | AssistantToolUseBlock
  | AssistantUnknownBlock;

export interface AssistantEventPayload {
  message?: {
    content?: AssistantContentBlock[];
  };
}

export interface ToolProgressEventPayload {
  tool_use_id: string;
  tool_name: string;
  elapsed_time_seconds: number;
}

export interface ToolUseSummaryEventPayload {
  summary: string;
  preceding_tool_use_ids: string[];
}

export interface ServerPayload {
  type: 'assistant' | 'result' | 'tool_progress' | 'tool_use_summary' | 'error' | 'session_init' | 'session_ready' | 'cancelled' | 'compact_boundary' | 'user' | 'system';
  subtype?: string;
  sessionId?: string;
  event?: AssistantEventPayload | ToolProgressEventPayload | ToolUseSummaryEventPayload | UserEventPayload | SystemEventPayload;
  message?: string;
}

export interface UserEventPayload {
  type: 'user';
  message?: { role: string; content: unknown };
}

interface SystemEventPayload {
  type: 'system';
  subtype?: string;
  content?: string;
}

const STARTER_PROMPTS = [
  'Summarize what this project currently does.',
  'Help me plan the next milestone for OpenAutory.',
  'Find risky areas in this codebase and suggest tests.',
];

export let msgCounter = 0;
export const nextKey = () => String(++msgCounter);

const USER_ID = 'desktop-user';

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function formatToolInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** 从 XML 标签中提取内容：`<tag>content</tag>` → `"content"` */
function extractXmlTag(s: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = s.indexOf(open);
  if (start === -1) return null;
  const contentStart = start + open.length;
  const end = s.indexOf(close, contentStart);
  if (end === -1) return null;
  const content = s.slice(contentStart, end).trim();
  return content || null;
}

export interface ParsedUserEvent {
  message: UserMessage;
  isCommandOutput: boolean;
}

/** 解析 SDK user event 为 UserMessage，返回 null 表示应跳过 */
export function parseUserEvent(event: UserEventPayload): ParsedUserEvent | null {
  // compact 产生的合成摘要不显示
  if ((event as Record<string, unknown>).isSynthetic) return null;
  // 跳过 SDK 内部元数据消息（与 Rust 历史加载器保持一致）
  const raw = event as Record<string, unknown>;
  if (raw.isMeta) return null;
  if (raw.sourceToolAssistantUUID) return null;
  if (raw.planContent) return null;
  if (raw.isCompactSummary) return null;
  if (raw.isVisibleInTranscriptOnly) return null;
  const content = event.message?.content;
  if (!content) return null;

  let text: string;
  if (typeof content === 'string') {
    if (!content || content.startsWith('/')) return null;
    text = content;
  } else if (Array.isArray(content)) {
    // 跳过 tool_result，提取 text
    const textBlock = (content as Array<Record<string, unknown>>).find(
      (b) => b.type === 'text' && typeof b.text === 'string' && (b.text as string).trim(),
    );
    if (!textBlock) return null;
    text = (textBlock.text as string).trim();
    if (!text || text.startsWith('/')) return null;
  } else {
    return null;
  }

  // 解析 XML 协议标签
  let isCommandOutput = false;
  if (text.startsWith('<')) {
    if (text.startsWith('<task-notification>')) {
      text = extractXmlTag(text, 'summary') ?? text;
    } else if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) {
      const cmd = extractXmlTag(text, 'command-name') ?? extractXmlTag(text, 'command-message') ?? '';
      const args = extractXmlTag(text, 'command-args') ?? '';
      text = args ? `${cmd} ${args}` : cmd;
      if (!text) return null;
    } else if (text.startsWith('<local-command-stdout>')) {
      text = extractXmlTag(text, 'local-command-stdout') ?? text;
      isCommandOutput = true;
    } else if (text.startsWith('<local-command-stderr>')) {
      text = extractXmlTag(text, 'local-command-stderr') ?? text;
      isCommandOutput = true;
    }
  }

  if (!text) return null;
  return { message: { key: nextKey(), role: 'user', content: text }, isCommandOutput };
}

export function appendAssistantBlocks(existing: ContentBlock[], contentArray: AssistantContentBlock[]): ContentBlock[] {
  const next = [...existing];
  const seenThinking = new Set(
    existing
      .filter((b): b is ContentBlock & { type: 'thinking' } => b.type === 'thinking')
      .map((b) => normalizeText(b.text)),
  );

  for (const block of contentArray) {
    if (block.type === 'thinking') {
      const raw = (block as AssistantThinkingBlock).thinking ?? (block as AssistantThinkingBlock).text ?? '';
      const normalized = normalizeText(raw);
      if (!normalized || seenThinking.has(normalized)) continue;
      seenThinking.add(normalized);
      next.push({ type: 'thinking', key: nextKey(), text: raw });
    } else if (block.type === 'text') {
      const text = (block as AssistantTextBlock).text ?? '';
      const last = next[next.length - 1];
      if (last && last.type === 'text') {
        next[next.length - 1] = { ...last, text: last.text + text };
      } else {
        next.push({ type: 'text', key: nextKey(), text });
      }
    } else if (block.type === 'tool_use') {
      const tb = block as AssistantToolUseBlock;
      const id = tb.id ?? nextKey();
      const existingIdx = next.findIndex((b) => b.type === 'tool_use' && b.toolUse.id === id);
      if (existingIdx !== -1) {
        const old = next[existingIdx] as ContentBlock & { type: 'tool_use' };
        next[existingIdx] = {
          ...old,
          toolUse: {
            ...old.toolUse,
            name: tb.name || old.toolUse.name,
            inputPreview: formatToolInput(tb.input) || old.toolUse.inputPreview,
          },
        };
      } else {
        next.push({
          type: 'tool_use',
          key: nextKey(),
          toolUse: {
            id,
            name: tb.name ?? 'Tool Use',
            inputPreview: formatToolInput(tb.input),
            progress: [],
          },
        });
      }
    }
  }

  return next;
}

export function updateBlockToolProgress(
  blocks: ContentBlock[],
  toolUseId: string,
  toolName: string,
  progressLine: string,
): ContentBlock[] {
  const next = [...blocks];
  const index = next.findIndex((b) => b.type === 'tool_use' && b.toolUse.id === toolUseId);
  if (index === -1) {
    next.push({
      type: 'tool_use',
      key: nextKey(),
      toolUse: { id: toolUseId, name: toolName, inputPreview: '', progress: [progressLine] },
    });
    return next;
  }
  const old = next[index] as ContentBlock & { type: 'tool_use' };
  const lastProgress = old.toolUse.progress[old.toolUse.progress.length - 1];
  const progress = lastProgress === progressLine
    ? old.toolUse.progress
    : [...old.toolUse.progress, progressLine];
  next[index] = {
    ...old,
    toolUse: { ...old.toolUse, name: toolName || old.toolUse.name, progress },
  };
  return next;
}

export function updateBlockToolSummary(
  blocks: ContentBlock[],
  toolUseIds: string[],
  summary: string,
): ContentBlock[] {
  const next = [...blocks];
  for (const toolUseId of toolUseIds) {
    const index = next.findIndex((b) => b.type === 'tool_use' && b.toolUse.id === toolUseId);
    if (index === -1) {
      next.push({
        type: 'tool_use',
        key: nextKey(),
        toolUse: { id: toolUseId, name: 'Tool Use', inputPreview: '', progress: [], summary },
      });
      continue;
    }
    const old = next[index] as ContentBlock & { type: 'tool_use' };
    next[index] = { ...old, toolUse: { ...old.toolUse, summary } };
  }
  return next;
}

function groupBlocks(blocks: ContentBlock[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      const last = groups[groups.length - 1];
      if (last && last.type === 'tool_group') {
        last.tools.push(block.toolUse);
        continue;
      }
      groups.push({ type: 'tool_group', key: block.key, tools: [block.toolUse] });
    } else {
      groups.push(block);
    }
  }
  return groups;
}

const aiBubbleClassNames = {
  root: styles.aiBubbleRoot,
  content: styles.aiBubbleContent,
};

type HistoryBlock =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type HistoryMsg =
  | { role: 'user'; text: string; subtext?: string; isCommandOutput?: boolean }
  | { role: 'assistant'; blocks: HistoryBlock[] }
  | { role: 'summary'; text: string };

function historyToMessages(history: HistoryMsg[]): Message[] {
  // 仅将 command stdout/stderr 合并到前一条 command 消息的 subtext
  const merged: HistoryMsg[] = [];
  for (const m of history) {
    if (m.role === 'user' && m.isCommandOutput && merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.role === 'user' && prev.text.startsWith('/')) {
        prev.subtext = prev.subtext ? `${prev.subtext}\n${m.text}` : m.text;
        continue;
      }
    }
    merged.push(m.role === 'user' ? { ...m } : m);
  }
  return merged.flatMap((m) => {
    if (m.role === 'user') {
      return [{ key: nextKey(), role: 'user' as const, content: m.text, subtext: m.subtext }];
    }
    if (m.role === 'summary') {
      return [{
        key: nextKey(),
        role: 'ai' as const,
        blocks: [{ type: 'text' as const, key: nextKey(), text: `*— 以上对话已压缩 —*\n\n${m.text}` }],
      }];
    }
    const blocks: ContentBlock[] = m.blocks.map((b) => {
      if (b.type === 'thinking') return { type: 'thinking' as const, key: nextKey(), text: b.text };
      if (b.type === 'text') return { type: 'text' as const, key: nextKey(), text: b.text };
      return {
        type: 'tool_use' as const,
        key: nextKey(),
        toolUse: { id: b.id, name: b.name, inputPreview: formatToolInput(b.input), progress: [] },
      };
    });
    return [{ key: nextKey(), role: 'ai' as const, blocks }];
  });
}

export interface ChatProps {
  cwd: string;
  sessionId: string | null; // null = new thread
  projectName: string;
  projects: ProjectInfo[];
  messages: Message[];
  loading: boolean;
  onUpdateMessages: (sessionId: string, updater: (prev: Message[]) => Message[]) => void;
  onUpdateLoading: (sessionId: string, loading: boolean) => void;
  wsSend: (data: unknown) => void;
  onNewSession?: (sessionId: string, preview: string) => void;
  onSwitchProject?: (cwd: string) => void;
  onAddProject?: () => void;
}

export default function Chat({ cwd, sessionId: propSessionId, projectName, projects, messages, loading, onUpdateMessages, onUpdateLoading, wsSend, onNewSession, onSwitchProject, onAddProject }: ChatProps) {
  const [inputValue, setInputValue] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  // Tracks the real session ID — may start as propSessionId and get updated
  // after session_ready. Using a ref so WS callbacks always see the latest value.
  const actualSessionIdRef = useRef<string>(propSessionId ?? '');

  // Scoped setters: write to the App-level session state map
  const setMessages = useCallback((updater: Message[] | ((prev: Message[]) => Message[])) => {
    const sid = actualSessionIdRef.current;
    if (!sid) return;
    onUpdateMessages(sid, typeof updater === 'function' ? updater : () => updater);
  }, [onUpdateMessages]);

  const setLoading = useCallback((value: boolean) => {
    const sid = actualSessionIdRef.current;
    if (!sid) return;
    onUpdateLoading(sid, value);
  }, [onUpdateLoading]);

  const loadHistory = useCallback((sid: string) => {
    invoke<HistoryMsg[]>('read_session_messages', { sessionId: sid, cwd }).then((history) => {
      setMessages(historyToMessages(history));
    });
  }, [setMessages, cwd]);

  // On mount: load history if we have an existing session and no in-memory messages
  useEffect(() => {
    if (propSessionId) {
      actualSessionIdRef.current = propSessionId;
      if (messages.length === 0) {
        loadHistory(propSessionId);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally only runs on mount (Chat is remounted via key)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const handleCancel = useCallback(() => {
    const sid = actualSessionIdRef.current;
    if (!sid) return;
    wsSend({ type: 'cancel', sessionId: sid });
  }, [wsSend]);

  // IME 输入法：选词时按 Enter 不应触发发送
  const composingRef = useRef(false);
  const handleCompositionStart = useCallback(() => { composingRef.current = true; }, []);
  const handleCompositionEnd = useCallback(() => { composingRef.current = false; }, []);
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.keyCode === 229 || e.nativeEvent.isComposing || composingRef.current) return false;
  }, []);

  const handleSubmit = useCallback(async (rawText: string) => {
    const text = rawText.trim();
    if (!text || loading) return;
    setInputValue('');
    setLoading(true);

    // 新 session：先生成 UUID，确保后续 setMessages 能写入正确的 map key
    if (!actualSessionIdRef.current) {
      const newId = crypto.randomUUID();
      actualSessionIdRef.current = newId;
      await invoke('create_session', { sessionId: newId, cwd });
      onNewSession?.(newId, text);
    }

    const userKey = nextKey();
    const aiKey = nextKey();

    setMessages((prev) => [
      ...prev,
      { key: userKey, role: 'user', content: text },
      { key: aiKey, role: 'ai', blocks: [], loading: true },
    ]);

    wsSend({
      type: 'message',
      sessionId: actualSessionIdRef.current,
      userId: USER_ID,
      content: text,
      cwd,
    });
  }, [wsSend, setMessages, loading, cwd, onNewSession]);

  return (
    <div className={styles.surface}>
      <div className={styles.stream}>
        {messages.length === 0 ? (
          <section className={styles.empty}>
            <p className={styles.emptyKicker}>OpenAutory</p>
            <h2 className={styles.emptyTitle}>
              <span>开始构建</span>
              <br />
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: '_header', label: '选择你的项目', disabled: true, style: { color: 'rgba(29,37,48,0.4)', fontSize: 12, cursor: 'default' } },
                    ...projects.map((p) => ({
                      key: p.cwd,
                      icon: <FolderOutlined />,
                      label: (
                        <span className={styles.projectMenuItem}>
                          <span>{p.name}</span>
                          {p.cwd === cwd && <CheckOutlined style={{ fontSize: 12, color: 'var(--oa-accent, #0f766e)' }} />}
                        </span>
                      ),
                      onClick: () => onSwitchProject?.(p.cwd),
                    })),
                    { type: 'divider' as const },
                    { key: '_add', icon: <FolderAddOutlined />, label: '添加新项目', onClick: () => onAddProject?.() },
                  ],
                }}
              >
                <span className={styles.projectPicker}>
                  {projectName} <UpOutlined className={styles.projectPickerIcon} />
                </span>
              </Dropdown>
            </h2>
            <div className={styles.promptGrid}>
              {STARTER_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className={styles.promptChip}
                  onClick={() => handleSubmit(prompt)}
                  disabled={loading}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className={styles.messageList}>
          {messages.map((message) => {
            if (message.role === 'user') {
              return (
                <div key={message.key} className={`${styles.entry} ${styles.entryUser}`}>
                  <div className={`${styles.row} ${styles.rowUser}`}>
                    <div className={`${styles.bubble} ${styles.bubbleUser}`}>
                      <div className={styles.bubbleText}>{message.content}</div>
                      {message.subtext && (
                        <div className={styles.bubbleSubtext}>{message.subtext}</div>
                      )}
                    </div>
                  </div>
                </div>
              );
            }

            return (
              <div key={message.key} className={`${styles.entry} ${styles.entryAi}`}>
                {message.blocks.length === 0 && message.loading ? (
                  <div className={`${styles.row} ${styles.rowAi}`}>
                    <Bubble
                      loading
                      content={undefined}
                      classNames={aiBubbleClassNames}
                    />
                  </div>
                ) : (
                  groupBlocks(message.blocks).map((group) => {
                    switch (group.type) {
                      case 'thinking':
                        return (
                          <div key={group.key} className={styles.metaPanel}>
                            <CollapsiblePanel summary="Thinking">
                              <pre className={styles.thinkingBlock}>{group.text}</pre>
                            </CollapsiblePanel>
                          </div>
                        );
                      case 'text':
                        return (
                          <div key={group.key} className={`${styles.row} ${styles.rowAi}`}>
                            <Bubble
                              content={renderMarkdown(group.text || '')}
                              classNames={aiBubbleClassNames}
                            />
                          </div>
                        );
                      case 'tool_group': {
                        const lastTool = group.tools[group.tools.length - 1]!;
                        const lastProgress = lastTool.progress[lastTool.progress.length - 1];
                        return (
                          <div key={group.key} className={styles.metaPanel}>
                            <CollapsiblePanel
                              summary={
                                <>
                                  <span>Tool Use</span>
                                  <span className={styles.metaCount}>{group.tools.length}</span>
                                  {lastProgress ? (
                                    <span className={styles.toolStatus}>{lastProgress}</span>
                                  ) : null}
                                </>
                              }
                              bodyClassName={styles.toolList}
                            >
                              {group.tools.map((toolUse) => (
                                <div key={toolUse.id} className={styles.toolItem}>
                                  <div className={styles.toolHeader}>
                                    <strong>{toolUse.name}</strong>
                                    {toolUse.progress.length > 0 ? (
                                      <span className={styles.toolStatus}>{toolUse.progress[toolUse.progress.length - 1]}</span>
                                    ) : null}
                                  </div>
                                  {toolUse.summary ? (
                                    <p className={styles.toolSummary}>{toolUse.summary}</p>
                                  ) : null}
                                  {toolUse.inputPreview ? (
                                    <pre className={styles.toolInput}>{toolUse.inputPreview}</pre>
                                  ) : null}
                                </div>
                              ))}
                            </CollapsiblePanel>
                          </div>
                        );
                      }
                    }
                  })
                )}
                {message.loading && message.blocks.length > 0 ? (
                  <div className={`${styles.row} ${styles.rowAi}`}>
                    <Bubble
                      loading
                      content={undefined}
                      classNames={aiBubbleClassNames}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
          <div ref={endRef} />
        </div>
      </div>

      <div
        className={styles.inputWrap}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
      >
        <Sender
          rootClassName={styles.sender}
          classNames={{ input: styles.senderInput }}
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onKeyDown={handleKeyDown}
          loading={loading}
          placeholder="Type your request and press Enter"
          autoSize={{ minRows: 1, maxRows: 5 }}
        />
      </div>
    </div>
  );
}
