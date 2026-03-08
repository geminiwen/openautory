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
import Chat from './components/Chat';
import Settings from './components/Settings';
import Sidebar, { type SessionInfo } from './components/Sidebar';
import styles from './App.module.css';

const { Content } = Layout;
const appWindow = getCurrentWindow();

const SESSION_CWD = '~/.autory';

function projectNameFromCwd(cwd: string): string {
  if (cwd === '~/.autory' || cwd === '~/.autory/') return '默认项目';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

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

  // Session state
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState(0);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [listVersion, setListVersion] = useState(0);

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

  // Initialize: load session list + pick most-recent session
  useEffect(() => {
    void invoke<SessionInfo[]>('list_sessions', { cwd: SESSION_CWD }).then(setSessions);
    void invoke<string>('get_or_create_session', { cwd: SESSION_CWD }).then((id) => {
      setSelectedSessionId(id || null);
    });
  }, []);

  // Re-fetch session list when listVersion bumps (new session created)
  useEffect(() => {
    if (listVersion === 0) return;
    void invoke<SessionInfo[]>('list_sessions', { cwd: SESSION_CWD }).then(setSessions);
  }, [listVersion]);

  const handleNewThread = useCallback(() => {
    setSelectedSessionId(null);
    setChatKey((k) => k + 1);
  }, []);

  const handleSelectSession = useCallback((id: string) => {
    setSelectedSessionId(id);
    setChatKey((k) => k + 1);
  }, []);

  const handleSessionReady = useCallback((realId: string) => {
    setSelectedSessionId(realId);
    setListVersion((v) => v + 1);
  }, []);

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
              projectName={projectNameFromCwd(SESSION_CWD)}
              sessions={sessions}
              activeSessionId={selectedSessionId}
              onNewThread={handleNewThread}
              onSelectSession={handleSelectSession}
            />
            <div className={styles.chatArea}>
              <Chat
                key={chatKey}
                sessionId={selectedSessionId}
                onSessionReady={handleSessionReady}
              />
            </div>
          </Content>

          <Drawer
            className={styles.settingsDrawer}
            title="Connection Settings"
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            width={400}
            destroyOnClose
          >
            <Settings />
          </Drawer>
        </Layout>
      </div>
    </ConfigProvider>
  );
}
