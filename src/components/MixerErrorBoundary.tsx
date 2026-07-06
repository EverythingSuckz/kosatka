/**
 * Error boundary for the mixer route. Catches anything thrown during
 * render/decode and shows a recoverable message rather than crashing the
 * whole TanStack Start shell.
 */

import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  err: Error | null
}

export class MixerErrorBoundary extends Component<Props, State> {
  state: State = { err: null }

  static getDerivedStateFromError(err: Error): State {
    return { err }
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    console.error('mixer error:', err, info)
  }

  render(): ReactNode {
    if (this.state.err) {
      return (
        <main className="mx-auto w-full max-w-[1280px] px-4 py-12">
          <h1 className="text-2xl font-normal uppercase tracking-[0.12em] text-[var(--color-danger)]">
            mixer crashed
          </h1>
          <pre className="mt-4 whitespace-pre-wrap border border-[var(--color-danger)] p-4 text-[var(--color-danger)]">
            {this.state.err.message}
          </pre>
          <p className="mt-4 text-xs text-[var(--color-fg-mute)]">
            check the browser console for the full stack trace. drop a different
            .awc to retry.
          </p>
        </main>
      )
    }
    return this.props.children
  }
}
