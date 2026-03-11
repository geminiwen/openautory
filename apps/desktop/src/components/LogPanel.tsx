import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import styles from './LogPanel.module.css';

interface ServerLog {
  stream: string;
  line: string;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_VALUE: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function parseLevel(line: string): LogLevel {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed.level === 'string') {
      const l = parsed.level.toLowerCase();
      if (l in LEVEL_VALUE) return l as LogLevel;
    }
  } catch {
    // not JSON — default to info
  }
  return 'info';
}

interface LogEntry {
  stream: string;
  line: string;
  level: LogLevel;
  timestamp: number;
}

const MAX_LOGS = 2000;

interface LogPanelProps {
  open: boolean;
  onClose: () => void;
}

export default function LogPanel({ open, onClose }: LogPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filterLevel, setFilterLevel] = useState<LogLevel>('debug');
  const bodyRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  useEffect(() => {
    const unlisten = listen<ServerLog>('server-log', (event) => {
      setLogs((prev) => {
        const entry: LogEntry = {
          ...event.payload,
          level: parseLevel(event.payload.line),
          timestamp: Date.now(),
        };
        const next = [...prev, entry];
        return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Auto-scroll to bottom when new logs arrive (only if user is at bottom)
  useEffect(() => {
    if (isAtBottomRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs]);

  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  }, []);

  const handleClear = useCallback(() => {
    setLogs([]);
  }, []);

  const filteredLogs = logs.filter(
    (entry) => LEVEL_VALUE[entry.level] >= LEVEL_VALUE[filterLevel]
  );

  function levelLineClass(level: LogLevel): string {
    if (level === 'error') return `${styles.line} ${styles.lineError}`;
    if (level === 'warn') return `${styles.line} ${styles.lineWarn}`;
    return styles.line;
  }

  return (
    <div className={`${styles.wrapper} ${open ? styles.wrapperOpen : ''}`}>
      <div className={styles.inner}>
        <div className={styles.panel}>
          <div className={styles.header}>
            <span className={styles.title}>Server Logs</span>
            <div className={styles.filterGroup}>
              {LEVELS.map((lvl) => (
                <button
                  key={lvl}
                  className={`${styles.filterBtn} ${filterLevel === lvl ? styles.filterBtnActive : ''}`}
                  onClick={() => setFilterLevel(lvl)}
                >
                  {lvl}
                </button>
              ))}
            </div>
            <div className={styles.headerActions}>
              <button className={styles.headerBtn} onClick={handleClear} title="Clear">
                &#x2715;
              </button>
              <button className={styles.headerBtn} onClick={onClose} title="Close">
                &#x2013;
              </button>
            </div>
          </div>
          <div className={styles.body} ref={bodyRef} onScroll={handleScroll}>
            {filteredLogs.length === 0 ? (
              <div className={styles.empty}>No server logs yet.</div>
            ) : (
              filteredLogs.map((entry, i) => (
                <div key={i} className={levelLineClass(entry.level)}>
                  {entry.line}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
