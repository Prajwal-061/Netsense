import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api'
import type { ScanSummary } from '../api'
import { useHealth, useScans, useStartScan } from '../queries'
import { Button, ErrorBox } from './ui'

/** The "Start scan" button, with progress while a scan runs. */
export default function ScanControl() {
  const { data: scans } = useScans()
  const { data: health } = useHealth()
  const startScan = useStartScan()
  const running = scans?.find((scan) => scan.status === 'running')
  const latest = scans?.[0]

  return (
    <div className="space-y-3 p-4">
      {running ? (
        <ScanProgress scan={running} />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button onClick={() => startScan.mutate()} busy={startScan.isPending}>
            Start scan
          </Button>
          <p className="text-sm text-slate-600">
            Discovers devices with ARP, then checks their open ports with Nmap. Takes about half
            a minute.
          </p>
        </div>
      )}

      {/* 409 means a scan is already running; the progress panel above shows it. */}
      {startScan.isError && !running && !isConflict(startScan.error) && (
        <ErrorBox error={startScan.error} />
      )}
      {startScan.isError && isConflict(startScan.error) && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
          A scan is already running, so a second one was not started. {startScan.error.message}
        </p>
      )}

      {!running && latest?.status === 'failed' && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900" role="alert">
          <p className="font-semibold">
            The last scan (
            <Link to={`/scans/${latest.id}`} className="underline">
              #{latest.id}
            </Link>
            ) failed
          </p>
          <p className="mt-0.5 break-words">{latest.error}</p>
        </div>
      )}

      {health && !health.raw_sockets && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          The API process cannot open raw sockets, so a scan started here will fail at the ARP
          step. Give the backend's Python the CAP_NET_RAW capability (see the README), or run
          the scan script with sudo.
        </p>
      )}
    </div>
  )
}

function isConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409
}

function ScanProgress({ scan }: { scan: ScanSummary }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsed = Math.max(0, Math.round((now - Date.parse(scan.started_at)) / 1000))

  return (
    <div role="status" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">
          Scan #{scan.id} is running on {scan.subnet}
        </p>
        <p className="font-mono text-sm text-slate-600">{elapsed}s elapsed</p>
      </div>
      {/* The API reports no percentage, so the bar only shows activity. */}
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100">
        <div className="progress-indeterminate h-full w-1/4 rounded-full bg-blue-600" />
      </div>
      <p className="mt-2 text-sm text-slate-600">
        ARP discovery, then an Nmap service scan of each device found. This page updates by
        itself when the scan finishes.
      </p>
    </div>
  )
}
