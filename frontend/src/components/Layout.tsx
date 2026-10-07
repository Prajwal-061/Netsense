import { Link, NavLink, Outlet } from 'react-router-dom'
import { useHealth, useRefreshWhenScanFinishes, useScans } from '../queries'
import { ErrorBox, Spinner } from './ui'

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/devices', label: 'Devices', end: false },
  { to: '/scans', label: 'Scans', end: false },
]

export default function Layout() {
  useRefreshWhenScanFinishes()
  const health = useHealth()
  const { data: scans } = useScans()
  const running = scans?.find((scan) => scan.status === 'running')

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
        <Outlet />
      </main>
    </div>
  )
}
