// Top-level error boundary. React render/lifecycle exceptions don't surface
// through window.onerror, so without this a crash silently blanks the UI with
// nothing in the log. componentDidCatch forwards the error + component stack to
// the log file (see lib/log) and renders a minimal fallback.
import React from 'react';
import { log } from '../lib/log';

interface Props {
  children: React.ReactNode;
}
interface State {
  failed: boolean;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    log.error('react render error:', error, info.componentStack ?? '');
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return (
        <div style={{ padding: 24, color: '#e6e6e6', fontFamily: 'sans-serif' }}>
          Something went wrong. Details were written to the log file.
        </div>
      );
    }
    return this.props.children;
  }
}
