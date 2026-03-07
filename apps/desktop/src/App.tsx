import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  CloseOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MinusOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Button, ConfigProvider, Drawer, Layout } from 'antd';
import Chat from './components/Chat';
import Settings from './components/Settings';

const { Content } = Layout;
const appWindow = getCurrentWindow();

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
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest('.window-frame')) {
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
        className={`app-shell${isMacLike ? ' app-shell-macos' : ''}`}
        onMouseDown={handleShellMouseDown}
      >
        <Layout className="app-layout">
          <div className="window-frame">
            <header className="app-titlebar" onMouseDown={handleTitlebarMouseDown}>
              <div className="app-titlebar-brand">
                <span className="app-titlebar-logo">OA</span>
                <div className="app-titlebar-copy">
                  <span className="app-titlebar-name">OpenAutory</span>
                  <span className="app-titlebar-subtitle">Desktop Workspace</span>
                </div>
              </div>

              <div className="app-titlebar-actions" data-no-drag="true">
                <Button
                  className="titlebar-action-button"
                  icon={<SettingOutlined />}
                  type="text"
                  onClick={() => setSettingsOpen(true)}
                />

                {!isMacLike ? (
                  <>
                    <Button
                      className="titlebar-window-button"
                      icon={<MinusOutlined />}
                      type="text"
                      onClick={handleMinimize}
                    />
                    <Button
                      className="titlebar-window-button"
                      icon={isMaximized ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                      type="text"
                      onClick={handleToggleMaximize}
                    />
                    <Button
                      className="titlebar-window-button titlebar-window-button-close"
                      icon={<CloseOutlined />}
                      type="text"
                      onClick={handleClose}
                    />
                  </>
                ) : null}
              </div>
            </header>

          <Content className="app-content">
            <Chat />
          </Content>
          </div>

          <Drawer
            className="settings-drawer"
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
