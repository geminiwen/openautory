import { useState, type ReactNode } from 'react';
import styles from './CollapsiblePanel.module.css';

interface CollapsiblePanelProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  bodyClassName?: string;
}

export default function CollapsiblePanel({
  summary,
  children,
  defaultOpen = false,
  bodyClassName,
}: CollapsiblePanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={styles.panel}>
      <div className={styles.summary} onClick={() => setOpen((v) => !v)}>
        <span className={`${styles.arrow} ${open ? styles.arrowOpen : ''}`}>▸</span>
        {summary}
      </div>
      <div className={`${styles.bodyWrapper} ${open ? styles.bodyWrapperOpen : ''}`}>
        <div className={`${styles.body} ${open ? styles.bodyOpen : ''} ${bodyClassName ?? ''}`}>
          {children}
        </div>
      </div>
    </div>
  );
}
