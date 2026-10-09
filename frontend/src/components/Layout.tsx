import { Link, NavLink, Outlet } from 'react-router-dom'
import { REQUIRED_API_REVISION } from '../api'
import { useCollections, useHealth, useRefreshWhenScanFinishes, useScans } from '../queries'
import { ErrorBox, Spinner } from './ui'

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/devices', label: 'Devices', end: false },
  { to: '/scans', label: 'Scans', end: false },
  { to: '/collections', label: 'Collections', end: false },
  { to: '/topology', label: 'Topology', end: false },
]

export default function Layout() {
  useRefreshWhenScanFinishes()
  const health = useHealth()
  const { data: scans } = useScans()
  const running = scans?.find((scan) => scan.status === 'running')
  const { data: collections } = useCollections()
  const collecting = collections?.find((run) => run.status === 'running')
  const backendRevision = health.data ? (health.data.api_revision ?? 0) : undefined
  const backendOutdated = backendRevision !== undefined && backendRevision < REQUIRED_API_REVISION

  return (
    <div className="min-h-screen">
      <header className="bg-slate-900 text-slate-100">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <img src="/favicon.svg" alt="" className="h-6 w-6" />
            NetSense
          </Link>
          <nav className="flex gap-1" aria-label="Main">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm font-medium ${
                    isActive ? 'bg-slate-700 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-4 text-xs">
            {running && (
              <Link to={`/scans/${running.id}`} className="flex items-center gap-1.5 text-sky-300 hover:underline">
                <Spinner className="h-3 w-3" />
                Scan #{running.id} running
              </Link>
            )}
            {collecting && (
              <Link to="/collections" className="flex items-center gap-1.5 text-sky-300 hover:underline">
                <Spinner className="h-3 w-3" />
                Collecting {collecting.device_count - collecting.pending}/{collecting.device_count}
              </Link>
            )}
            <span className="flex items-center gap-1.5 text-slate-300">
              <span
                className={`h-2 w-2 rounded-full ${
                  health.isError ? 'bg-red-500' : health.data ? 'bg-emerald-400' : 'bg-slate-500'
                }`}
              />
              {health.isError ? 'API offline' : health.data ? 'API connected' : 'Connecting...'}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {health.isError && (
          <div className="mb-5">
            <ErrorBox error={health.error} onRetry={() => void health.refetch()} />
          </div>
        )}
        {backendOutdated && (
          <div className="mb-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900" role="alert">
            <p className="font-semibold">The backend is running older code than this dashboard</p>
            <p className="mt-1">
              Parts of this page will fail or show wrong information until the backend is
              restarted. Stop it with Ctrl+C and start it again, then reload this page. (The
              dashboard needs API revision {REQUIRED_API_REVISION}; the backend reports{' '}
              {backendRevision || 'none'}.)
            </p>
          </div>
        )}
        <Outlet />
      </main>
    </div>
  )
}
