import { useState } from 'react';
import { CloseOutlined, FolderAddOutlined, FolderOpenOutlined, FolderOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons';
import { Button, Dropdown } from 'antd';
import { homeDir } from '@tauri-apps/api/path';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import styles from './Sidebar.module.css';

async function revealProject(cwd: string) {
  let resolved = cwd;
  if (resolved === '~' || resolved.startsWith('~/')) {
    const home = await homeDir();
    resolved = resolved === '~' ? home : home + resolved.slice(1);
  }
  await revealItemInDir(resolved);
}

export interface SessionInfo {
  id: string;
  modified: number; // Unix ms
  preview: string;
}

export interface ProjectInfo {
  cwd: string;
  name: string;
  sessions: SessionInfo[];
}

interface SidebarProps {
  projects: ProjectInfo[];
  activeCwd: string;
  activeSessionId: string | null;
  onNewThread: (cwd: string) => void;
  onSelectSession: (cwd: string, sessionId: string) => void | Promise<void>;
  onAddProject: () => void | Promise<void>;
  onRemoveProject: (cwd: string) => void | Promise<void>;
  onDeleteSession?: (cwd: string, sessionId: string) => void | Promise<void>;
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}天前`;
  if (hours > 0) return `${hours}小时`;
  if (minutes > 0) return `${minutes}分`;
  return '刚刚';
}

export default function Sidebar({
  projects,
  activeSessionId,
  onNewThread,
  onSelectSession,
  onAddProject,
  onRemoveProject,
  onDeleteSession,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const toggleProject = (cwd: string) => {
    setCollapsed((prev) => ({ ...prev, [cwd]: !prev[cwd] }));
  };

  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <span className={styles.headerTitle}>会话</span>
        <div className={styles.headerActions}>
          <Button
            type="text"
            size="small"
            icon={<FolderAddOutlined />}
            onClick={onAddProject}
            className={styles.headerBtn}
            title="添加项目"
          />
        </div>
      </div>

      <div className={styles.tree}>
        {projects.map((project) => {
          const isDefault = project.cwd === '~/.autory';
          const isCollapsed = !!collapsed[project.cwd];

          return (
            <div key={project.cwd} className={styles.projectGroup}>
              <Dropdown
                trigger={['contextMenu']}
                menu={{
                  items: [
                    {
                      key: 'reveal',
                      icon: <FolderOpenOutlined />,
                      label: 'View in Finder',
                      onClick: () => void revealProject(project.cwd),
                    },
                    ...(!isDefault ? [
                      { type: 'divider' as const },
                      {
                        key: 'remove',
                        icon: <CloseOutlined />,
                        label: '移除项目',
                        danger: true,
                        onClick: () => void onRemoveProject(project.cwd),
                      },
                    ] : []),
                  ],
                }}
              >
                <div className={styles.projectRow} onClick={() => toggleProject(project.cwd)}>
                  <RightOutlined className={`${styles.collapseArrow} ${isCollapsed ? '' : styles.collapseArrowOpen}`} />
                  <FolderOutlined className={styles.projectIcon} />
                  <span className={styles.projectName}>{project.name}</span>
                  <Button
                    type="text"
                    size="small"
                    icon={<PlusOutlined />}
                    className={styles.newThreadBtn}
                    onClick={(e) => { e.stopPropagation(); onNewThread(project.cwd); }}
                    title="新建"
                  />
                  {!isDefault && (
                    <Button
                      type="text"
                      size="small"
                      icon={<CloseOutlined />}
                      className={styles.removeBtn}
                      onClick={(e) => { e.stopPropagation(); void onRemoveProject(project.cwd); }}
                      title="移除项目"
                    />
                  )}
                </div>
              </Dropdown>

              {!isCollapsed && (
                <>
                  {project.sessions.length === 0 && (
                    <div className={styles.emptyHint}>无会话</div>
                  )}
                  {project.sessions.map((session) => (
                    <div
                      key={session.id}
                      className={`${styles.sessionRow}${session.id === activeSessionId ? ` ${styles.sessionRowActive}` : ''}`}
                      onClick={() => onSelectSession(project.cwd, session.id)}
                    >
                      <span className={styles.sessionPreview}>
                        {session.preview || session.id.slice(0, 8)}
                      </span>
                      <span className={styles.sessionTime}>{formatRelativeTime(session.modified)}</span>
                      {onDeleteSession && (
                        <Button
                          type="text"
                          size="small"
                          icon={<CloseOutlined />}
                          className={styles.sessionDeleteBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            void onDeleteSession(project.cwd, session.id);
                          }}
                          title="删除"
                        />
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
