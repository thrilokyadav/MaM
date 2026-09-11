import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import './states.css';

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  Icon?: LucideIcon;
}

export function EmptyState({ title, description, action, Icon = Inbox }: EmptyStateProps) {
  return (
    <div className="state-container state-empty" role="status">
      <div className="state-mark" aria-hidden="true">
        <Icon />
      </div>
      <div className="state-title">{title}</div>
      {description ? <div className="state-description">{description}</div> : null}
      {action ? <div className="state-action">{action}</div> : null}
    </div>
  );
}
