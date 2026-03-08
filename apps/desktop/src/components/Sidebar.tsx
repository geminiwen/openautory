import { PlusOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import styles from './Sidebar.module.css';

export interface SessionInfo {
  id: string;
  modified: number; // Unix ms
  preview: string;
}

interface SidebarProps {
  projectName: string;
  sessions: SessionInfo[];
  activeSessionId: string | null;
  onNewThread: () => void;
  onSelectSession: (id: string) => void;
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

export default function Sidebar({ projectName, sessions, activeSessionId, onNewThread, onSelectSession }: SidebarProps) {
  return (
    <div className={styles.sidebar}>
      <div className={styles.header}>
        <div className={styles.projectName}>{projectName}</div>
        <Button
          className={styles.newBtn}
          type="text"
          icon={<PlusOutlined />}
          onClick={onNewThread}
          block
        >
          New thread
        </Button>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>Threads</div>
        <div className={styles.list}>
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`${styles.item}${session.id === activeSessionId ? ` ${styles.itemActive}` : ''}`}
              onClick={() => onSelectSession(session.id)}
            >
              <span className={styles.preview}>
                {session.preview || session.id.slice(0, 8)}
              </span>
              <span className={styles.time}>{formatRelativeTime(session.modified)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
