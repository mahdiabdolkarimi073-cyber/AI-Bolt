import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

/**
 * Development-friendly error boundary that catches rendering exceptions
 * and shows a recoverable error message instead of a blank screen.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const stack = info.componentStack ?? null;
    this.setState({ componentStack: stack });
    console.error('[ERROR-BOUNDARY]', {
      label: this.props.label,
      error: error.message,
      stack: error.stack,
      componentStack: stack,
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, componentStack: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="rounded-lg border border-error-500/30 bg-error-500/10 px-4 py-3">
            <p className="text-xs font-semibold text-error-400">
              {this.props.label ?? 'Component'} crashed
            </p>
            <p className="mt-1 max-w-md text-2xs text-surface-300">
              {this.state.error?.message ?? 'Unknown rendering error'}
            </p>
            {this.state.componentStack && (
              <pre className="mt-2 max-h-40 overflow-auto text-left text-2xs text-surface-400">
                {this.state.componentStack.slice(0, 800)}
              </pre>
            )}
          </div>
          <button
            onClick={this.handleReset}
            className="rounded-md border border-surface-600 bg-surface-800 px-3 py-1.5 text-2xs text-surface-200 hover:bg-surface-750"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
