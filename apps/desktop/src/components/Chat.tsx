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

type ContentBlock =
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
}

interface AiMessage {
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

interface AssistantEventPayload {
  message?: {
    content?: AssistantContentBlock[];
  };
}

interface ToolProgressEventPayload {
  tool_use_id: string;
  tool_name: string;
  elapsed_time_seconds: number;
}

interface ToolUseSummaryEventPayload {
  summary: string;
  preceding_tool_use_ids: string[];
}

interface ServerPayload {
  type: 'assistant' | 'result' | 'tool_progress' | 'tool_use_summary' | 'error' | 'session_init' | 'session_ready' | 'cancelled' | 'compact_boundary';
  sessionId?: string;
  event?: AssistantEventPayload | ToolProgressEventPayload | ToolUseSummaryEventPayload;
  message?: string;
}

const STARTER_PROMPTS = [
  'Summarize what this project currently does.',
  'Help me plan the next milestone for OpenAutory.',
  'Find risky areas in this codebase and suggest tests.',
];

let msgCounter = 0;
const nextKey = () => String(++msgCounter);

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

function appendAssistantBlocks(existing: ContentBlock[], contentArray: AssistantContentBlock[]): ContentBlock[] {
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

function updateBlockToolProgress(
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

function updateBlockToolSummary(
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
  | { role: 'user'; text: string }
  | { role: 'assistant'; blocks: HistoryBlock[] }
  | { role: 'summary'; text: string };

function historyToMessages(history: HistoryMsg[]): Message[] {
  return history.flatMap((m) => {
    if (m.role === 'user') {
      return [{ key: nextKey(), role: 'user' as const, content: m.text }];
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
  wsSubscribe: (listener: (payload: ServerPayload) => void) => () => void;
  onNewSession?: (sessionId: string, preview: string) => void;
  onSwitchProject?: (cwd: string) => void;
  onAddProject?: () => void;
}

export default function Chat({ cwd, sessionId: propSessionId, projectName, projects, messages, loading, onUpdateMessages, onUpdateLoading, wsSend, wsSubscribe, onNewSession, onSwitchProject, onAddProject }: ChatProps) {
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

  // On mount: load history if we have an existing session
  useEffect(() => {
    if (propSessionId) {
      actualSessionIdRef.current = propSessionId;
      loadHistory(propSessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally only runs on mount (Chat is remounted via key)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const appendAssistantPayload = useCallback((key: string, payload: AssistantEventPayload) => {
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.key === key);
      if (index === -1) return prev;
      const msg = prev[index] as AiMessage;
      const next = [...prev];
      next[index] = {
        ...msg,
        blocks: appendAssistantBlocks(msg.blocks, payload.message?.content ?? []),
        loading: true,
      };
      return next;
    });
  }, [setMessages]);

  const appendToolProgressPayload = useCallback((key: string, payload: ToolProgressEventPayload) => {
    const roundedSeconds = Math.max(1, Math.round(payload.elapsed_time_seconds));
    const progressLine = `${payload.tool_name} · ${roundedSeconds}s`;
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.key === key);
      if (index === -1) return prev;
      const msg = prev[index] as AiMessage;
      const next = [...prev];
      next[index] = {
        ...msg,
        blocks: updateBlockToolProgress(msg.blocks, payload.tool_use_id, payload.tool_name, progressLine),
      };
      return next;
    });
  }, [setMessages]);

  const appendToolSummaryPayload = useCallback((key: string, payload: ToolUseSummaryEventPayload) => {
    setMessages((prev) => {
      const index = prev.findIndex((m) => m.key === key);
      if (index === -1) return prev;
      const msg = prev[index] as AiMessage;
      const next = [...prev];
      next[index] = {
        ...msg,
        blocks: updateBlockToolSummary(msg.blocks, payload.preceding_tool_use_ids, payload.summary),
      };
      return next;
    });
  }, [setMessages]);

  const finishRequest = useCallback(() => {
    setLoading(false);
  }, [setLoading]);

  const handleCancel = useCallback(() => {
    const sid = actualSessionIdRef.current;
    if (!sid) return;
    wsSend({ type: 'cancel', sessionId: sid });
  }, [wsSend]);

  // Track the current AI message key so the subscription listener can update the right bubble
  const aiKeyRef = useRef<string | null>(null);

  // Subscribe to incoming WebSocket messages, filter by current session
  useEffect(() => {
    const unsubscribe = wsSubscribe((payload) => {
      const currentAiKey = aiKeyRef.current;
      // Only process messages for our session
      if (payload.sessionId && payload.sessionId !== actualSessionIdRef.current) return;

      if (payload.type === 'assistant' && payload.event && currentAiKey) {
        appendAssistantPayload(currentAiKey, payload.event as AssistantEventPayload);
        return;
      }
      if (payload.type === 'tool_progress' && payload.event && currentAiKey) {
        appendToolProgressPayload(currentAiKey, payload.event as ToolProgressEventPayload);
        return;
      }
      if (payload.type === 'tool_use_summary' && payload.event && currentAiKey) {
        appendToolSummaryPayload(currentAiKey, payload.event as ToolUseSummaryEventPayload);
        return;
      }
      if (payload.type === 'compact_boundary') {
        loadHistory(actualSessionIdRef.current);
        return;
      }
      if (payload.type === 'result' && currentAiKey) {
        setMessages((prev) =>
          prev.map((m) => (m.key === currentAiKey && m.role === 'ai' ? { ...m, loading: false } : m)),
        );
        aiKeyRef.current = null;
        finishRequest();
        return;
      }
      if (payload.type === 'cancelled' && currentAiKey) {
        setMessages((prev) =>
          prev.map((m) => (m.key === currentAiKey && m.role === 'ai' ? { ...m, loading: false } : m)),
        );
        aiKeyRef.current = null;
        finishRequest();
        return;
      }
      if (payload.type === 'error' && currentAiKey) {
        const errorMessage = payload.message ?? 'Unknown error';
        setMessages((prev) =>
          prev.map((m) =>
            m.key === currentAiKey && m.role === 'ai'
              ? { ...m, blocks: [{ type: 'text' as const, key: nextKey(), text: `Error: ${errorMessage}` }], loading: false }
              : m,
          ),
        );
        aiKeyRef.current = null;
        finishRequest();
      }
    });
    return unsubscribe;
  }, [wsSubscribe, appendAssistantPayload, appendToolProgressPayload, appendToolSummaryPayload, finishRequest, loadHistory]);

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
    aiKeyRef.current = aiKey;

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
                            <details className={styles.metaDetails}>
                              <summary className={styles.metaSummary}>Thinking</summary>
                              <div className={styles.metaBody}>
                                <pre className={styles.thinkingBlock}>{group.text}</pre>
                              </div>
                            </details>
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
                            <details className={styles.metaDetails} onToggle={(e) => {
                              const details = e.currentTarget;
                              if (details.open) {
                                const list = details.querySelector(`.${styles.toolList}`);
                                if (list) list.scrollTop = list.scrollHeight;
                              }
                            }}>
                              <summary className={styles.metaSummary}>
                                <span>Tool Use</span>
                                <span className={styles.metaCount}>{group.tools.length}</span>
                                {lastProgress ? (
                                  <span className={styles.toolStatus}>{lastProgress}</span>
                                ) : null}
                              </summary>
                              <div className={`${styles.metaBody} ${styles.toolList}`}>
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
                              </div>
                            </details>
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

      <div className={styles.inputWrap}>
        <Sender
          rootClassName={styles.sender}
          classNames={{ input: styles.senderInput }}
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          loading={loading}
          placeholder="Type your request and press Enter"
          autoSize={{ minRows: 1, maxRows: 5 }}
        />
      </div>
    </div>
  );
}
