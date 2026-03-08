import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  CloseOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MinusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Button, ConfigProvider, Drawer, Layout } from 'antd';
import Chat, { type Message } from './components/Chat';
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
  const [isMaximized, setIsMaximized] = useState(false);
  const isMacLike = useMemo(() => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent), []);

  // Persistent WebSocket connection
  const { send: wsSend, subscribe: wsSubscribe } = useWebSocket(getServerUrl());

  // Multi-project state
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeCwd, setActiveCwd] = useState(DEFAULT_CWD);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);

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

  const refreshProjects = useCallback(async () => {
    const list = await invoke<ProjectInfo[]>('list_projects');
    setProjects(list);
    return list;
  }, []);

  // Initialize: load projects
  useEffect(() => {
    void invoke<ProjectInfo[]>('list_projects').then(setProjects);
  }, []);

  const activeProjectName = useMemo(() => {
    const p = projects.find((proj) => proj.cwd === activeCwd);
    return p?.name ?? activeCwd;
  }, [projects, activeCwd]);

  const handleNewThread = useCallback((cwd: string) => {
    setActiveCwd(cwd);
    setSelectedSessionId(null);
    setChatKey((k) => k + 1);
  }, []);

  const handleSwitchProject = useCallback((cwd: string) => {
    setActiveCwd(cwd);
    setSelectedSessionId(null);
    setChatKey((k) => k + 1);
  }, []);

  const handleSelectSession = useCallback(async (cwd: string, sessionId: string) => {
    const list = await invoke<ProjectInfo[]>('list_projects');
    setProjects(list);
    setActiveCwd(cwd);
    setSelectedSessionId(sessionId);
    setChatKey((k) => k + 1);
  }, []);

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
    setActiveCwd(folderPath);
    setSelectedSessionId(null);
    setChatKey((k) => k + 1);
  }, []);

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
        setSelectedSessionId(null);
        setChatKey((k) => k + 1);
      }
    },
    [selectedSessionId],
  );

  const handleRemoveProject = useCallback(
    async (cwd: string) => {
      const list = await invoke<ProjectInfo[]>('remove_project', { cwd });
      setProjects(list);
      if (activeCwd === cwd) {
        setActiveCwd(DEFAULT_CWD);
        const defaultProject = list.find((p) => p.cwd === DEFAULT_CWD);
        setSelectedSessionId(defaultProject?.sessions[0]?.id ?? null);
        setChatKey((k) => k + 1);
      }
    },
    [activeCwd],
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
            <div className={styles.chatArea}>
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
                wsSubscribe={wsSubscribe}
                onNewSession={handleNewSession}
                onSwitchProject={handleSwitchProject}
                onAddProject={handleAddProject}
              />
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
