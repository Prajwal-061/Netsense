import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api'
import type { Device, DriftCheckSummary, NetworkCollectionSummary, ScanSummary } from '../api'
import ChangeReportView from '../components/ChangeReport'
import LiveActivity from '../components/LiveActivity'
import { ScanMessages, StartScanButton } from '../components/ScanControl'
import Sparkline from '../components/Sparkline'
import type { Status } from '../components/ui'
import { Card, DeviceGlyph, EmptyState, ErrorBox, Loading, PageTitle, RelativeTime, StatusDot } from '../components/ui'
import { deviceHealth, networkScore, nodeHealth, scoreHealth } from '../health'
import {
  isPresent,
  useCollections,
  useDevices,
  useDriftChecks,
  useLatestCompletedScan,
  useLatestDriftReport,
  useScan,
  useScans,
  useStartScan,
  useTopology,
} from '../queries'
import TopologyMap from '../topology/TopologyMap'

/** How many past scans, collections and checks the sparklines show. */
const HISTORY = 20

export default function Overview() {
  const startScan = useStartScan()
  const devices = useDevices()
  const scans = useScans()
  const runs = useCollections()
  const checks = useDriftChecks()
  const drift = useLatestDriftReport()
  const latestCompleted = useLatestCompletedScan()
  const latestDetail = useScan(latestCompleted?.id)

  return (
    <>
      <PageTitle title="Overview" actions={<StartScanButton startScan={startScan} />} />
      <ScanMessages startScan={startScan} />
      <LiveActivity />

      <div className="space-y-3">
        <KpiStrip
          devices={devices.data}
          scans={scans.data}
          runs={runs.data}
          checks={checks.data}
          score={drift.report ? networkScore(drift.report) : null}
          latestScanId={latestCompleted?.id}
        />

        <div className="grid items-start gap-3 lg:grid-cols-3">
          <div className="space-y-3 lg:col-span-2">
            <MiniTopology />
            <Card
              title="Latest changes"
              action={
                latestCompleted && (
                  <Link to={`/scans/${latestCompleted.id}`} className="text-xs text-accent hover:underline">
                    Scan #{latestCompleted.id}, <RelativeTime iso={latestCompleted.started_at} />
                  </Link>
                )
              }
            >
              {latestDetail.isError ? (
                <div className="p-3">
                  <ErrorBox error={latestDetail.error} onRetry={() => void latestDetail.refetch()} />
                </div>
              ) : latestDetail.data?.changes ? (
                <ChangeReportView report={latestDetail.data.changes} />
              ) : scans.isPending || latestDetail.isLoading ? (
                <Loading />
              ) : (
                <EmptyState>No completed scan yet.</EmptyState>
              )}
            </Card>
            <Card
              title="Devices"
              action={
                <Link to="/devices" className="text-xs text-accent hover:underline">
                  View all
                </Link>
              }
            >
              {devices.isPending ? (
                <Loading />
              ) : devices.isError ? (
                <div className="p-3">
                  <ErrorBox error={devices.error} onRetry={() => void devices.refetch()} />
                </div>
              ) : (
                <DeviceTypes types={devices.data.map((device) => device.device_type)} />
              )}
            </Card>
          </div>
          <div className="space-y-3">
            <DeviceHealthCard />
            <Card title="Recent events">
              <Timeline scans={scans.data} runs={runs.data} checks={checks.data} devices={devices.data} />
            </Card>
          </div>
        </div>
      </div>
    </>
  )
}

// --- KPI strip ----------------------------------------------------------------------

function KpiStrip({
  devices,
  scans,
  runs,
  checks,
  score,
  latestScanId,
}: {
  devices: Device[] | undefined
  scans: ScanSummary[] | undefined
  runs: NetworkCollectionSummary[] | undefined
  checks: DriftCheckSummary[] | undefined
  score: number | null
  latestScanId: number | undefined
}) {
  // History lists come newest first; sparklines read oldest first.
  const completedScans = (scans ?? []).filter((scan) => scan.status === 'completed').slice(0, HISTORY).reverse()
  const finishedRuns = (runs ?? []).filter((run) => run.status !== 'running').slice(0, HISTORY).reverse()
  const completedChecks = (checks ?? []).filter((check) => check.status === 'completed' && check.summary).slice(0, HISTORY).reverse()
  const latestRun = finishedRuns.at(-1)
  const latestCheck = completedChecks.at(-1)
  const up = (devices ?? []).filter((device) => isPresent(device, latestScanId)).length
  const findings = (check: DriftCheckSummary) => check.summary!.critical + check.summary!.warning + check.summary!.info
  const health = score === null ? null : scoreHealth(score)

  return (
    <section aria-label="Key figures" className="grid grid-cols-1 gap-px overflow-hidden rounded border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        label="Known devices"
        value={devices ? devices.length : '–'}
        sub={devices ? `${up} up in the last scan` : undefined}
        to="/devices"
        chart={<Sparkline values={completedScans.map((scan) => scan.device_count)} label="Devices found per scan" />}
      />
      <Kpi
        label="Network health"
        value={
          score === null ? (
            '–'
          ) : (
            <span className={health === 'ok' ? 'text-ok' : health === 'warn' ? 'text-warn' : 'text-crit'}>
              {score}
              <span className="text-[13px] font-normal text-fg-subtle"> / 100</span>
            </span>
          )
        }
        sub={latestCheck ? <>Drift check #{latestCheck.id}, <RelativeTime iso={latestCheck.started_at} /></> : 'No drift check yet'}
        to="/network-health"
        chart={
          score !== null && (
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-raised" role="img" aria-label={`Health score ${score} of 100`}>
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${health === 'ok' ? 'bg-ok' : health === 'warn' ? 'bg-warn' : 'bg-crit'}`}
                style={{ width: `${score}%` }}
              />
            </div>
          )
        }
      />
      <Kpi
        label="Findings"
        value={latestCheck ? findings(latestCheck) : '–'}
        sub={
          latestCheck ? (
            <span className="tabular">
              {latestCheck.summary!.critical} critical · {latestCheck.summary!.warning} warning · {latestCheck.summary!.info} info
            </span>
          ) : (
            'Since the baseline'
          )
        }
        to="/network-health"
        chart={
          <Sparkline
            values={completedChecks.map(findings)}
            label="Findings per drift check"
            tone={latestCheck?.summary!.critical ? 'crit' : latestCheck?.summary!.warning ? 'warn' : 'ok'}
          />
        }
      />
      <Kpi
        label="Last collection"
        value={
          latestRun ? (
            <span className="tabular">
              {latestRun.succeeded}
              <span className="text-[13px] font-normal text-fg-subtle"> / {latestRun.device_count} reached</span>
            </span>
          ) : (
            '–'
          )
        }
        sub={latestRun ? <>Collection #{latestRun.id}, <RelativeTime iso={latestRun.started_at} /></> : 'No collection yet'}
        to="/collections"
        chart={
          <Sparkline
            values={finishedRuns.map((run) => run.succeeded)}
            label="Devices reached per collection"
            tone={latestRun && latestRun.failed > 0 ? 'warn' : 'accent'}
          />
        }
      />
    </section>
  )
}

function Kpi({ label, value, sub, chart, to }: { label: string; value: ReactNode; sub?: ReactNode; chart?: ReactNode; to: string }) {
  return (
    <Link to={to} className="group flex min-w-0 flex-col gap-1 bg-surface px-4 py-3 transition-colors duration-150 hover:bg-raised">
      <span className="text-[11px] font-medium tracking-wide text-fg-muted uppercase">{label}</span>
      <span className="flex items-end justify-between gap-3">
        <span className="tabular text-[20px] leading-[26px] font-medium text-fg">{value}</span>
        {chart}
      </span>
      <span className="truncate text-xs text-fg-muted">{sub}</span>
    </Link>
  )
}

// --- topology preview and health ------------------------------------------------------------

function MiniTopology({ className = '' }: { className?: string }) {
  const topology = useTopology()
  const drift = useLatestDriftReport()
  const options = useMemo(() => ({ health: nodeHealth(drift.report) }), [drift.report])
  const noCollection = topology.error instanceof ApiError && topology.error.status === 404
  return (
    <Card
      className={className}
      title="Topology"
      action={
        <Link to="/topology" className="text-xs text-accent hover:underline">
          Open map
        </Link>
      }
    >
      {topology.isPending ? (
        <Loading />
      ) : noCollection ? (
        <EmptyState>
          No topology yet.{' '}
          <Link to="/collections" className="text-accent hover:underline">
            Collect from all devices
          </Link>
        </EmptyState>
      ) : topology.isError ? (
        <div className="p-3">
          <ErrorBox error={topology.error} onRetry={() => void topology.refetch()} />
        </div>
      ) : (
        <TopologyMap topology={topology.data} options={options} className="h-[340px] bg-canvas" compact />
      )}
    </Card>
  )
}

function DeviceHealthCard() {
  const drift = useLatestDriftReport()
  const rows = drift.report ? deviceHealth(drift.report).sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)) : []
  return (
    <Card
      title="Device health"
      action={
        <Link to="/network-health" className="text-xs text-accent hover:underline">
          Network health
        </Link>
      }
    >
      {drift.isPending ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState>No drift check yet.</EmptyState>
      ) : (
        <ul className="py-1">
          {rows.map((row) => (
            <li key={row.name} className="flex h-8 items-center gap-3 px-3">
              <span className="w-16 shrink-0 truncate font-medium text-fg">
                {row.deviceId !== null ? (
                  <Link to={`/devices/${row.deviceId}`} className="hover:text-accent">
                    {row.name}
                  </Link>
                ) : (
                  row.name
                )}
              </span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                <span className={`block h-full rounded-full ${HEALTH_BG[row.health]}`} style={{ width: `${Math.max(row.score, 2)}%` }} />
              </span>
              <span className="tabular w-7 text-right text-fg">{row.score}</span>
              <span className="tabular w-16 text-right text-xs text-fg-muted" title={`${row.critical} critical, ${row.warning} warning, ${row.info} info`}>
                {row.critical ? <span className="text-crit">{row.critical}C </span> : null}
                {row.warning ? <span className="text-warn">{row.warning}W </span> : null}
                {!row.critical && !row.warning ? 'clean' : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

const HEALTH_BG = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit' }

function DeviceTypes({ types }: { types: string[] }) {
  const counts = new Map<string, number>()
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1)
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (rows.length === 0) return <EmptyState>No devices yet. Start a scan.</EmptyState>
  return (
    <ul className="py-1">
      {rows.map(([type, count]) => (
        <li key={type}>
          <Link
            to={`/devices?type=${encodeURIComponent(type)}`}
            className="flex h-8 items-center gap-2.5 px-3 text-fg-muted transition-colors duration-150 hover:bg-raised hover:text-fg"
          >
            <DeviceGlyph type={type} />
            <span className="flex-1">{type}</span>
            <span className="tabular text-fg">{count}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

// --- timeline ---------------------------------------------------------------------------

interface Event {
  at: string
  status: Status
  kind: string
  text: ReactNode
  to: string
}

function Timeline({
  scans,
  runs,
  checks,
  devices,
}: {
  scans: ScanSummary[] | undefined
  runs: NetworkCollectionSummary[] | undefined
  checks: DriftCheckSummary[] | undefined
  devices: { id: number; first_seen: string; last_ip: string; vendor: string }[] | undefined
}) {
  if (!scans && !runs && !checks && !devices) return <Loading />
  const events: Event[] = [
    ...(scans ?? []).map((scan) => ({
      at: scan.started_at,
      status: (scan.status === 'completed' ? 'ok' : scan.status === 'failed' ? 'crit' : 'accent') as Status,
      kind: 'Scan',
      text:
        scan.status === 'completed' ? (
          <>
            Scan #{scan.id} found <span className="tabular">{scan.device_count}</span> devices
          </>
        ) : scan.status === 'failed' ? (
          <>Scan #{scan.id} failed</>
        ) : (
          <>Scan #{scan.id} running</>
        ),
      to: `/scans/${scan.id}`,
    })),
    ...(runs ?? []).map((run) => ({
      at: run.started_at,
      status: (run.status === 'running' ? 'accent' : run.failed > 0 ? 'warn' : run.succeeded > 0 ? 'ok' : 'crit') as Status,
      kind: 'Collection',
      text:
        run.status === 'running' ? (
          <>Collection #{run.id} running</>
        ) : (
          <>
            Collection #{run.id} reached <span className="tabular">{run.succeeded}/{run.device_count}</span> devices
          </>
        ),
      to: '/collections',
    })),
    ...(checks ?? []).map((check) => ({
      at: check.started_at,
      status: (check.status !== 'completed' ? (check.status === 'failed' ? 'crit' : 'accent') : check.summary?.critical ? 'crit' : check.summary?.warning ? 'warn' : 'ok') as Status,
      kind: 'Drift check',
      text:
        check.status === 'completed' && check.summary ? (
          <>
            Drift check #{check.id}: {check.summary.critical} critical, {check.summary.warning} warning
          </>
        ) : (
          <>
            Drift check #{check.id} {check.status}
          </>
        ),
      to: '/network-health',
    })),
    ...(devices ?? []).map((device) => ({
      at: device.first_seen,
      status: 'accent' as Status,
      kind: 'New device',
      text: (
        <>
          New device <span className="font-mono text-xs">{device.last_ip}</span>
          <span className="text-fg-muted"> {device.vendor}</span>
        </>
      ),
      to: `/devices/${device.id}`,
    })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 10)

  if (events.length === 0) return <EmptyState>Nothing has happened yet.</EmptyState>
  return (
    <ol className="py-1">
      {events.map((event, index) => (
        <li key={index}>
          <Link to={event.to} className="relative flex min-h-8 items-center gap-2.5 px-3 py-1 transition-colors duration-150 hover:bg-raised">
            <StatusDot status={event.status} title={event.kind} />
            <span className="min-w-0 flex-1 truncate text-fg">{event.text}</span>
            <RelativeTime iso={event.at} className="shrink-0 text-xs text-fg-subtle" />
          </Link>
        </li>
      ))}
    </ol>
  )
}
