import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  CloseOutlined,
  CodeOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MinusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Button, ConfigProvider, Drawer, Layout } from 'antd';
import Chat, {
  type AiMessage,
  type AssistantEventPayload,
  type Message,
  type ServerPayload,
  type ToolProgressEventPayload,
  type ToolUseSummaryEventPayload,
  type UserEventPayload,
  appendAssistantBlocks,
  nextKey,
  parseUserEvent,
  updateBlockToolProgress,
  updateBlockToolSummary,
} from './components/Chat';
import LogPanel from './components/LogPanel';
import Sidebar, { type ProjectInfo } from './components/Sidebar';
import { useWebSocket } from './hooks/useWebSocket';
import { getServerUrl } from './components/Settings';
import styles from './App.module.css';

const { Content } = Layout;
const appWindow = getCurrentWindow();

const DEFAULT_CWD = '~/.autory';

const appTheme = {
  token: {
    colorPrimary: '#0f766e',
    colorInfo: '#0f766e',
    colorSuccess: '#0f766e',
    borderRadius: 12,
    wireframe: false,
    fontFamily: '"Space Grotesk", "Avenir Next", "Segoe UI", "PingFang SC", sans-serif',
  },
};

export default function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logPanelOpen, setLogPanelOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const isMacLike = useMemo(() => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent), []);

  // Persistent WebSocket connection
  const { send: wsSend, subscribe: wsSubscribe } = useWebSocket(getServerUrl());

  // Multi-project state
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeCwd, setActiveCwd] = useState(DEFAULT_CWD);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [chatExiting, setChatExiting] = useState(false);
  const pendingSwitch = useRef<(() => void) | null>(null);

  // Session state: keyed by session ID, survives Chat remounts
  const [sessionsMessages, setSessionsMessages] = useState<Record<string, Message[]>>({});
  const [sessionsLoading, setSessionsLoading] = useState<Record<string, boolean>>({});

  const updateSessionMessages = useCallback((sessionId: string, updater: (prev: Message[]) => Message[]) => {
    setSessionsMessages((prev) => ({
      ...prev,
      [sessionId]: updater(prev[sessionId] ?? []),
    }));
  }, []);

  const updateSessionLoading = useCallback((sessionId: string, loading: boolean) => {
    setSessionsLoading((prev) => ({ ...prev, [sessionId]: loading }));
  }, []);

  // 全局 WS 事件订阅：即使 Chat 未挂载也能处理所有事件
  useEffect(() => {
    return wsSubscribe((payload: ServerPayload) => {
      const sid = payload.sessionId;
      if (!sid) return;

      if (payload.type === 'assistant' && payload.event) {
        setSessionsMessages((prev) => {
          const msgs = prev[sid];
          if (!msgs) return prev;
          const idx = msgs.findIndex((m) => 'loading' in m && m.loading);
          if (idx === -1) return prev;
          const ai = msgs[idx] as AiMessage;
          const updated = [...msgs];
          updated[idx] = {
            ...ai,
            blocks: appendAssistantBlocks(ai.blocks, (payload.event as AssistantEventPayload).message?.content ?? []),
          };
          return { ...prev, [sid]: updated };
        });
        return;
      }

      if (payload.type === 'tool_progress' && payload.event) {
        const ev = payload.event as ToolProgressEventPayload;
        const roundedSeconds = Math.max(1, Math.round(ev.elapsed_time_seconds));
        const progressLine = `${ev.tool_name} · ${roundedSeconds}s`;
        setSessionsMessages((prev) => {
          const msgs = prev[sid];
          if (!msgs) return prev;
          const idx = msgs.findIndex((m) => 'loading' in m && m.loading);
          if (idx === -1) return prev;
          const ai = msgs[idx] as AiMessage;
          const updated = [...msgs];
          updated[idx] = {
            ...ai,
            blocks: updateBlockToolProgress(ai.blocks, ev.tool_use_id, ev.tool_name, progressLine),
          };
          return { ...prev, [sid]: updated };
        });
        return;
      }

      if (payload.type === 'tool_use_summary' && payload.event) {
        const ev = payload.event as ToolUseSummaryEventPayload;
        setSessionsMessages((prev) => {
          const msgs = prev[sid];
          if (!msgs) return prev;
          const idx = msgs.findIndex((m) => 'loading' in m && m.loading);
          if (idx === -1) return prev;
          const ai = msgs[idx] as AiMessage;
          const updated = [...msgs];
          updated[idx] = {
            ...ai,
            blocks: updateBlockToolSummary(ai.blocks, ev.preceding_tool_use_ids, ev.summary),
          };
          return { ...prev, [sid]: updated };
        });
        return;
      }

      if (payload.type === 'user' && payload.event) {
        const parsed = parseUserEvent(payload.event as UserEventPayload);
        if (parsed) {
          setSessionsMessages((prev) => {
            const msgs = prev[sid] ?? [];
            if (parsed.isCommandOutput) {
              for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (m.role === 'user' && m.content.startsWith('/')) {
                  const updated = { ...m, subtext: m.subtext ? `${m.subtext}\n${parsed.message.content}` : parsed.message.content };
                  return { ...prev, [sid]: [...msgs.slice(0, i), updated, ...msgs.slice(i + 1)] };
                }
              }
            }
            return { ...prev, [sid]: [...msgs, parsed.message] };
          });
        }
        return;
      }

      if (payload.type === 'compact_boundary') {
        return;
      }

      if (payload.type === 'result' || payload.type === 'cancelled') {
        setSessionsMessages((prev) => {
          const msgs = prev[sid];
          if (!msgs) return prev;
          const idx = msgs.findIndex((m) => 'loading' in m && m.loading);
          if (idx === -1) return prev;
          const ai = msgs[idx] as AiMessage;
          // AI bubble 没有任何内容块（如 /compact）→ 直接移除
          if (ai.blocks.length === 0) {
            return { ...prev, [sid]: msgs.filter((_, i) => i !== idx) };
          }
          const updated = [...msgs];
          updated[idx] = { ...ai, loading: false };
          return { ...prev, [sid]: updated };
        });
        setSessionsLoading((prev) => prev[sid] ? { ...prev, [sid]: false } : prev);
        return;
      }

      if (payload.type === 'error') {
        const errorMessage = payload.message ?? 'Unknown error';
        setSessionsMessages((prev) => {
          const msgs = prev[sid];
          if (!msgs) return prev;
          const idx = msgs.findIndex((m) => 'loading' in m && m.loading);
          if (idx === -1) return prev;
          const updated = [...msgs];
          updated[idx] = {
            ...msgs[idx],
            role: 'ai' as const,
            blocks: [{ type: 'text' as const, key: nextKey(), text: `Error: ${errorMessage}` }],
            loading: false,
          } as AiMessage;
          return { ...prev, [sid]: updated };
        });
        setSessionsLoading((prev) => prev[sid] ? { ...prev, [sid]: false } : prev);
      }
    });
  }, [wsSubscribe]);

  const currentMessages = selectedSessionId ? (sessionsMessages[selectedSessionId] ?? []) : [];
  const currentLoading = selectedSessionId ? (sessionsLoading[selectedSessionId] ?? false) : false;

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void (async () => {
      setIsMaximized(await appWindow.isMaximized());

      unlisten = await appWindow.onResized(async () => {
        setIsMaximized(await appWindow.isMaximized());
      });
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  // Initialize: load projects
  useEffect(() => {
    void invoke<ProjectInfo[]>('list_projects').then(setProjects);
  }, []);

  const activeProjectName = useMemo(() => {
    const p = projects.find((proj) => proj.cwd === activeCwd);
    return p?.name ?? activeCwd;
  }, [projects, activeCwd]);

  const switchWithTransition = useCallback((apply: () => void) => {
    if (chatExiting) return;
    pendingSwitch.current = () => {
      apply();
      setChatKey((k) => k + 1);
    };
    setChatExiting(true);
  }, [chatExiting]);

  const handleChatAnimationEnd = useCallback(() => {
    if (chatExiting && pendingSwitch.current) {
      pendingSwitch.current();
      pendingSwitch.current = null;
      setChatExiting(false);
    }
  }, [chatExiting]);

  const handleNewThread = useCallback((cwd: string) => {
    switchWithTransition(() => {
      setActiveCwd(cwd);
      setSelectedSessionId(null);
    });
  }, [switchWithTransition]);

  const handleSwitchProject = useCallback((cwd: string) => {
    switchWithTransition(() => {
      setActiveCwd(cwd);
      setSelectedSessionId(null);
    });
  }, [switchWithTransition]);

  const handleSelectSession = useCallback((cwd: string, sessionId: string) => {
    switchWithTransition(() => {
      setActiveCwd(cwd);
      setSelectedSessionId(sessionId);
    });
  }, [switchWithTransition]);

  // 新 session 第一条消息时：前端已生成 sessionId，立刻插入侧边栏
  // session ID 由 desktop 生成并管理，SDK 以此 UUID 创建 session 文件，无需 ID 交换
  // 不做延迟刷新：乐观数据已正确，切换会话等操作会自然触发 refreshProjects
  const handleNewSession = useCallback((sessionId: string, preview: string) => {
    setSelectedSessionId(sessionId);
    setProjects((prev) =>
      prev.map((p) =>
        p.cwd !== activeCwd
          ? p
          : { ...p, sessions: [{ id: sessionId, modified: Date.now(), preview }, ...p.sessions] },
      ),
    );
  }, [activeCwd]);

  const handleAddProject = useCallback(async () => {
    const folderPath = await invoke<string | null>('pick_folder');
    if (!folderPath) return;
    const list = await invoke<ProjectInfo[]>('add_project', { cwd: folderPath });
    setProjects(list);
    switchWithTransition(() => {
      setActiveCwd(folderPath);
      setSelectedSessionId(null);
    });
  }, [switchWithTransition]);

  const handleDeleteSession = useCallback(
    async (cwd: string, sessionId: string) => {
      await invoke('delete_session', { sessionId, cwd });
      const list = await invoke<ProjectInfo[]>('list_projects');
      setProjects(list);
      setSessionsMessages((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      if (selectedSessionId === sessionId) {
        switchWithTransition(() => {
          setSelectedSessionId(null);
        });
      }
    },
    [selectedSessionId, switchWithTransition],
  );

  const handleRemoveProject = useCallback(
    async (cwd: string) => {
      const list = await invoke<ProjectInfo[]>('remove_project', { cwd });
      setProjects(list);
      if (activeCwd === cwd) {
        const defaultProject = list.find((p) => p.cwd === DEFAULT_CWD);
        switchWithTransition(() => {
          setActiveCwd(DEFAULT_CWD);
          setSelectedSessionId(defaultProject?.sessions[0]?.id ?? null);
        });
      }
    },
    [activeCwd, switchWithTransition],
  );

  const handleTitlebarMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, textarea, select, [data-no-drag="true"]')) {
      return;
    }

    if (event.detail === 2) {
      void appWindow.toggleMaximize();
      return;
    }

    void appWindow.startDragging();
  }, []);

  const handleShellMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) {
      return;
    }

    if (event.detail === 2) {
      void appWindow.toggleMaximize();
      return;
    }

    void appWindow.startDragging();
  }, []);

  const handleMinimize = useCallback(() => {
    void appWindow.minimize();
  }, []);

  const handleToggleMaximize = useCallback(() => {
    void appWindow.toggleMaximize();
  }, []);

  const handleClose = useCallback(() => {
    void appWindow.close();
  }, []);

  return (
    <ConfigProvider theme={appTheme}>
      <div
        className={`${styles.shell}${isMacLike ? ` ${styles.shellMacos}` : ''}`}
        onMouseDown={handleShellMouseDown}
      >
        <Layout className={styles.layout}>
          <header className={styles.titlebar} onMouseDown={handleTitlebarMouseDown}>
            <div className={styles.titlebarBrand}>
              <span className={styles.titlebarLogo}>OA</span>
              <div className={styles.titlebarCopy}>
                <span className={styles.titlebarName}>OpenAutory</span>
                <span className={styles.titlebarSubtitle}>Desktop Workspace</span>
              </div>
            </div>

            <div className={styles.titlebarActions} data-no-drag="true">
              <Button
                className={styles.actionBtn}
                icon={<CodeOutlined />}
                type="text"
                onClick={() => setLogPanelOpen((v) => !v)}
              />
              <Button
                className={styles.actionBtn}
                icon={<SettingOutlined />}
                type="text"
                onClick={() => setSettingsOpen(true)}
              />

              {!isMacLike ? (
                <>
                  <Button
                    className={styles.windowBtn}
                    icon={<MinusOutlined />}
                    type="text"
                    onClick={handleMinimize}
                  />
                  <Button
                    className={styles.windowBtn}
                    icon={isMaximized ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                    type="text"
                    onClick={handleToggleMaximize}
                  />
                  <Button
                    className={`${styles.windowBtn} ${styles.windowBtnClose}`}
                    icon={<CloseOutlined />}
                    type="text"
                    onClick={handleClose}
                  />
                </>
              ) : null}
            </div>
          </header>

          <Content className={styles.content}>
            <Sidebar
              projects={projects}
              activeCwd={activeCwd}
              activeSessionId={selectedSessionId}
              onNewThread={handleNewThread}
              onSelectSession={handleSelectSession}
              onAddProject={handleAddProject}
              onRemoveProject={handleRemoveProject}
              onDeleteSession={handleDeleteSession}
            />
            <div
              className={`${styles.chatArea} ${chatExiting ? styles.chatExit : styles.chatEnter}`}
              onAnimationEnd={handleChatAnimationEnd}
            >
              <Chat
                key={chatKey}
                cwd={activeCwd}
                sessionId={selectedSessionId}
                projectName={activeProjectName}
                projects={projects}
                messages={currentMessages}
                loading={currentLoading}
                onUpdateMessages={updateSessionMessages}
                onUpdateLoading={updateSessionLoading}
                wsSend={wsSend}
                onNewSession={handleNewSession}
                onSwitchProject={handleSwitchProject}
                onAddProject={handleAddProject}
              />
              <LogPanel open={logPanelOpen} onClose={() => setLogPanelOpen(false)} />
            </div>
          </Content>

          <Drawer
            title="设置"
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            width={400}
            destroyOnClose
          >
            <p style={{ color: 'rgba(29,37,48,0.45)', fontSize: 13 }}>暂无可配置项。</p>
          </Drawer>
        </Layout>
      </div>
    </ConfigProvider>
  );
}
