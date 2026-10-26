import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router-dom'
import { ApiError, REQUIRED_API_REVISION } from '../api'
import { currentTheme, setTheme } from '../theme'
import type { Theme } from '../theme'
import {
  useBaseline,
  useCollections,
  useDriftChecks,
  useHealth,
  useLogout,
  useMe,
  useRefreshWhenScanFinishes,
  useScans,
  useWatchForExpiredSession,
} from '../queries'
import CommandPalette from './CommandPalette'
import { useCommandPaletteShortcut } from './shortcuts'
import { LogoMark, Wordmark } from './Logo'
import { Loading, MessageBar, RelativeTime, Spinner, StatusDot } from './ui'
import type { Status } from './ui'

const NAV: { to: string; label: string; end: boolean; icon: IconName }[] = [
  { to: '/', label: 'Overview', end: true, icon: 'overview' },
  { to: '/topology', label: 'Topology', end: false, icon: 'topology' },
  { to: '/devices', label: 'Devices', end: false, icon: 'devices' },
  { to: '/scans', label: 'Scans', end: false, icon: 'scans' },
  { to: '/collections', label: 'Collections', end: false, icon: 'collections' },
  { to: '/network-health', label: 'Network health', end: false, icon: 'health' },
]

export default function Layout() {
  const me = useMe()
  const location = useLocation()
  useWatchForExpiredSession()

  if (me.isPending) return <Loading label="Checking login..." />
  if (me.data === null) {
    // Not logged in: go to the login page, and come back here afterwards.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }
  // me.isError means the API could not be asked; the status bar says so.
  return <Shell username={me.data?.username} />
}

function Shell({ username }: { username?: string }) {
  useRefreshWhenScanFinishes()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const openSearch = useCallback(() => setSearching(true), [])
  useCommandPaletteShortcut(openSearch)

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar className="hidden md:flex" />
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 h-full w-full bg-black/50"
            onClick={() => setDrawerOpen(false)}
          />
          {/* Following a link in the drawer closes it. */}
          <Sidebar className="relative z-10 flex h-full shadow-float" onNavigate={() => setDrawerOpen(false)} />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar username={username} onOpenNavigation={() => setDrawerOpen(true)} onSearch={openSearch} />
        <StatusBars />
        <main className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <Outlet />
        </main>
      </div>
      {searching && <CommandPalette onClose={() => setSearching(false)} />}
    </div>
  )
}

// --- sidebar -----------------------------------------------------------------

function Sidebar({ className, onNavigate }: { className: string; onNavigate?: () => void }) {
  return (
    <aside className={`${className} w-52 shrink-0 flex-col border-r border-line bg-surface`}>
      <Link to="/" className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <LogoMark size={20} />
        <Wordmark className="text-[15px]" />
      </Link>
      <nav aria-label="Main" className="flex flex-col py-2">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              `relative flex h-8 items-center gap-2.5 px-3.5 text-[13px] ${
                isActive
                  ? 'bg-raised font-medium text-fg before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent'
                  : 'text-fg-muted hover:bg-raised hover:text-fg'
              }`
            }
          >
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </aside>
  )
}

// --- top bar -------------------------------------------------------------------

function TopBar({
  username,
  onOpenNavigation,
  onSearch,
}: {
  username?: string
  onOpenNavigation: () => void
  onSearch: () => void
}) {
  const health = useHealth()
  const { data: collections } = useCollections()
  const collecting = collections?.find((run) => run.status === 'running')

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-3 text-[13px] sm:gap-5">
      <button
        type="button"
        onClick={onOpenNavigation}
        aria-label="Open navigation"
        className="-ml-1 rounded p-1 text-fg-muted hover:bg-raised hover:text-fg md:hidden"
      >
        <Icon name="menu" />
      </button>
      <LastScan />
      <BaselineStatus />
      <div className="ml-auto flex items-center gap-3 sm:gap-4">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search"
          title="Search devices and pages (Ctrl+K)"
          className="flex h-7 items-center gap-2 rounded border border-line px-2 text-fg-subtle hover:border-line-strong hover:text-fg-muted"
        >
          <Icon name="search" />
          <span className="hidden lg:inline">Search</span>
          <kbd className="hidden rounded-[2px] border border-line px-1 font-mono text-[10px] lg:inline">Ctrl K</kbd>
        </button>
        {collecting && (
          <Link to="/collections" className="flex items-center gap-1.5 whitespace-nowrap text-link hover:underline" title="Collection running">
            <Spinner className="h-3 w-3" />
            <span className="hidden sm:inline">Collecting</span> {collecting.device_count - collecting.pending}/{collecting.device_count}
          </Link>
        )}
        <span
          className="flex items-center"
          title={health.isError ? 'The API is not answering' : health.data ? 'Connected to the API' : 'Connecting to the API'}
        >
          <StatusDot status={health.isError ? 'crit' : health.data ? 'ok' : 'unknown'}>
            <span className="hidden text-fg-muted lg:inline">API</span>
          </StatusDot>
          <span className="sr-only">{health.isError ? 'API offline' : health.data ? 'API connected' : 'Connecting...'}</span>
        </span>
        <ThemeToggle />
        {username && <UserMenu username={username} />}
      </div>
    </header>
  )
}

function LastScan() {
  const { data: scans } = useScans()
  const running = scans?.find((scan) => scan.status === 'running')
  const last = scans?.find((scan) => scan.status !== 'running')
  if (running) {
    return (
      <Link to={`/scans/${running.id}`} className="flex items-center gap-1.5 whitespace-nowrap text-link hover:underline">
        <Spinner className="h-3 w-3" />
        <span className="hidden sm:inline">Scan</span> #{running.id} <span className="hidden sm:inline">running</span>
      </Link>
    )
  }
  return (
    <span className="hidden items-center gap-1.5 whitespace-nowrap sm:flex">
      <span className="text-fg-muted">Last scan</span>
      {last ? (
        <Link to={`/scans/${last.id}`} className="text-fg hover:text-link">
          <RelativeTime iso={last.started_at} />
        </Link>
      ) : (
        <span className="text-fg-subtle">never</span>
      )}
    </span>
  )
}

function BaselineStatus() {
  const baseline = useBaseline()
  const checks = useDriftChecks()
  if (baseline.data === undefined) return null
  if (baseline.data === null) {
    return (
      <Link to="/network-health" className="hidden whitespace-nowrap text-fg-muted hover:text-fg sm:inline">
        <StatusDot status="unknown">No baseline</StatusDot>
      </Link>
    )
  }
  const date = new Date(baseline.data.collected_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const check = checks.data?.find(
    (item) => item.status === 'completed' && item.baseline_collection_id === baseline.data!.collection_id,
  )
  const summary = check?.summary
  let status: Status = 'unknown'
  let text = 'not checked'
  if (summary) {
    status = summary.critical ? 'crit' : summary.warning ? 'warn' : 'ok'
    text = summary.critical ? `${summary.critical} critical` : summary.warning ? `${summary.warning} warning` : '0 critical'
  }
  return (
    <Link
      to="/network-health"
      className="hidden whitespace-nowrap hover:text-link sm:inline"
      title={
        check
          ? `Latest drift check #${check.id} against the baseline (collection #${baseline.data.collection_id})`
          : `Baseline: collection #${baseline.data.collection_id}. No drift check against it yet.`
      }
    >
      <StatusDot status={status}>
        <span className="text-fg-muted">Baseline</span> {date} · {text}
      </StatusDot>
    </Link>
  )
}

function ThemeToggle() {
  const [theme, setCurrent] = useState<Theme>(currentTheme)
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      onClick={() => {
        setTheme(next)
        setCurrent(next)
      }}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="rounded p-1 text-fg-muted hover:bg-raised hover:text-fg"
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  )
}

function UserMenu({ username }: { username: string }) {
  const [open, setOpen] = useState(false)
  const logout = useLogout()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="User menu"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-fg hover:bg-raised"
      >
        <span>{username}</span>
        <Icon name="chevron" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-1 w-44 rounded border border-line bg-surface py-1 shadow-float">
          <p className="px-3 py-1 text-[11px] text-fg-subtle">Signed in as {username}</p>
          <button
            type="button"
            role="menuitem"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="block w-full px-3 py-1.5 text-left text-fg hover:bg-raised"
          >
            Log out
          </button>
        </div>
      )}
    </div>
  )
}

// --- status bars under the top bar --------------------------------------------------

function StatusBars() {
  const health = useHealth()
  const revision = health.data ? (health.data.api_revision ?? 0) : undefined
  const outdated = revision !== undefined && revision < REQUIRED_API_REVISION
  const error = health.error
  return (
    <>
      {health.isError && (
        <MessageBar
          tone="crit"
          title={error instanceof ApiError && error.blocked ? 'Request blocked by the browser' : 'API not reachable'}
          action={<BarButton onClick={() => void health.refetch()}>Retry</BarButton>}
        >
          {error instanceof Error ? error.message : String(error)}
        </MessageBar>
      )}
      {outdated && (
        <MessageBar tone="warn" title="The backend is running older code than this dashboard">
          Restart the backend, then reload. Needs API revision {REQUIRED_API_REVISION}, backend reports{' '}
          {revision || 'none'}; it has not been restarted since the last update.
        </MessageBar>
      )}
    </>
  )
}

function BarButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded border border-line-strong px-2 py-0.5 text-[12px] text-fg hover:bg-raised">
      {children}
    </button>
  )
}

// --- icons (16px, stroke) ---------------------------------------------------------

type IconName = 'search' | 'overview' | 'topology' | 'devices' | 'scans' | 'collections' | 'health' | 'menu' | 'sun' | 'moon' | 'chevron'

const PATHS: Record<IconName, ReactNode> = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  overview: <path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" />,
  topology: (
    <>
      <circle cx="8" cy="3.5" r="1.75" />
      <circle cx="3.5" cy="12.5" r="1.75" />
      <circle cx="12.5" cy="12.5" r="1.75" />
      <path d="M7 5L4.5 11M9 5l2.5 6M5.25 12.5h5.5" />
    </>
  ),
  devices: (
    <>
      <rect x="2" y="3" width="12" height="4" rx="1" />
      <rect x="2" y="9" width="12" height="4" rx="1" />
      <path d="M4.5 5h.01M4.5 11h.01" />
    </>
  ),
  scans: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 8l4-4" />
    </>
  ),
  collections: <path d="M2.5 3.5h11v9h-11zM5 7l2 1.5L5 10M8.5 10.5H11" />,
  health: <path d="M1.5 8.5h3l1.5-4 3 8 1.5-4h4" />,
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" />,
  chevron: <path d="M4.5 6.5L8 10l3.5-3.5" />,
}

function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}
