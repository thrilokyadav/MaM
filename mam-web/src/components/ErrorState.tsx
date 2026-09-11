import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import './states.css';

interface ErrorStateProps {
  title?: string;
  message?: string;
  action?: ReactNode;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  action,
}: ErrorStateProps) {
  return (
    <div className="state-container state-error" role="alert">
      <div className="state-mark state-mark-error" aria-hidden="true">
        <AlertTriangle />
      </div>
      <div className="state-title">{title}</div>
      {message ? <div className="state-description">{message}</div> : null}
      {action ? <div className="state-action">{action}</div> : null}
    </div>
  );
}
