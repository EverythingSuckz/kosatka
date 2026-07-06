import { Link, useRouterState } from '@tanstack/react-router'
import { GearSix } from '@phosphor-icons/react'

import { APP_NAME, APP_TAGLINE } from '../app-meta'
import { openSettings } from '../settings/ui'

/**
 * Global site header. the same 40px shell bar the mix editor uses (accent
 * wordmark + dim tagline + a settings gear), so home / explorer / editor read
 * as one app and settings is reachable everywhere.
 *
 * Hidden on the `/mix/*` editor routes. that page renders its own top bar
 * (with filename + its own gear) so the two don't stack.
 */
export default function Header() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  if (pathname.startsWith('/mix/')) return null
  return (
    <header className="border-b border-[var(--color-line)] bg-[var(--color-bg)]">
      <nav className="flex w-full items-center gap-3 px-3 h-10">
        <Link to="/" className="no-underline">
          <span className="font-bold uppercase tracking-[0.14em] text-[11px] text-[var(--color-accent)]">
            {APP_NAME}
          </span>
        </Link>
        <span className="uppercase tracking-[0.18em] text-[10px] text-[var(--color-fg-mute)]">
          {APP_TAGLINE}
        </span>
        <button
          type="button"
          onClick={() => openSettings()}
          aria-label="settings"
          title="Settings"
          className="ml-auto !border-0 !bg-transparent !p-1 text-[var(--color-fg-dim)] hover:text-[var(--color-fg)]"
        >
          <GearSix size={14} />
        </button>
      </nav>
    </header>
  )
}
