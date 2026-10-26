import { Link } from 'react-router-dom'
import { ApiError } from '../api'
import { useHealth, useScans, useStartScan } from '../queries'
import { Button, ErrorBox, MessageBar } from './ui'

type StartScan = ReturnType<typeof useStartScan>

/** "Start scan", hidden while a scan runs (the live console shows it instead). */
export function StartScanButton({ startScan, variant = 'primary' }: { startScan: StartScan; variant?: 'primary' | 'secondary' }) {
  const { data: scans } = useScans()
  if (scans?.some((scan) => scan.status === 'running')) return null
  return (
    <Button
      variant={variant}
      onClick={() => startScan.mutate()}
      busy={startScan.isPending}
      title="ARP discovery of the lab network, then an Nmap service scan of each device found"
    >
      Start scan
    </Button>
  )
}

/** Why a scan could not start, why the last one failed, or why the next one will. */
export function ScanMessages({ startScan }: { startScan: StartScan }) {
  const { data: scans } = useScans()
  const { data: health } = useHealth()
  const running = scans?.find((scan) => scan.status === 'running')
  const latest = scans?.[0]
  const conflict = startScan.error instanceof ApiError && startScan.error.status === 409

  const messages = [
    startScan.isError && !running && !conflict && <ErrorBox key="error" error={startScan.error} />,
    startScan.isError && conflict && (
      <MessageBar key="conflict" tone="warn" title="A scan is already running, so a second one was not started.">
        {startScan.error.message}
      </MessageBar>
    ),
    !running && latest?.status === 'failed' && (
      <MessageBar
        key="failed"
        tone="crit"
        title={
          <>
            The last scan (
            <Link to={`/scans/${latest.id}`} className="text-link hover:underline">
              #{latest.id}
            </Link>
            ) failed
          </>
        }
      >
        {latest.error}
      </MessageBar>
    ),
    health && !health.raw_sockets && (
      <MessageBar key="raw" tone="warn" title="Scans will fail at the ARP step">
        The API process cannot open raw sockets. Give the backend's Python the CAP_NET_RAW capability (see the
        README), or run the scan script with sudo.
      </MessageBar>
    ),
  ].filter(Boolean)

  return messages.length ? <div className="mb-3 space-y-2">{messages}</div> : null
}
