import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { DeviceCollectionResult, NetworkCollectionSummary, ScanProgress, ScanSummary } from '../api'
import { useCollection, useCollections, useDriftChecks, useScanProgress, useScans } from '../queries'
import { clock, useNow } from './controls'
import { Spinner, StatusDot } from './ui'

/**
 * Whatever is running right now (a scan, a collection, a drift check), as a
 * slim live console: each step or device on its own row with a status icon.
 * Renders nothing when all is quiet.
 */
export default function LiveActivity({ show = ['scan', 'collection', 'drift'] }: { show?: ('scan' | 'collection' | 'drift')[] }) {
  const scans = useScans()
  const runs = useCollections()
  const checks = useDriftChecks()
  const scan = show.includes('scan') ? scans.data?.find((item) => item.status === 'running') : undefined
  const run = show.includes('collection') ? runs.data?.find((item) => item.status === 'running') : undefined
  const check = show.includes('drift') ? checks.data?.find((item) => item.status === 'running') : undefined
  if (!scan && !run && !check) return null

  // Recent durations, so a running job can say how long it usually takes.
  const typicalScan = typical((scans.data ?? []).filter((item) => item.status === 'completed'))
  const typicalRun = typical((runs.data ?? []).filter((item) => item.status === 'completed'))

  return (
    <div className="mb-3 space-y-2" aria-live="polite">
      {scan && <ScanConsole scan={scan} typicalSeconds={typicalScan} />}
      {run && <CollectionConsole run={run} typicalSeconds={typicalRun} />}
      {check && (
        <Console title={`Drift check #${check.id}`} startedAt={check.started_at} link={{ to: '/network-health', text: 'Network health' }}>
          <Row state="running" label={check.collection_id ? `Comparing collection #${check.collection_id} with the baseline` : 'Collecting, then comparing with the baseline'} />
        </Console>
      )}
    </div>
  )
}

/** The median duration in seconds of up to ten recent finished jobs. */
function typical(jobs: { started_at: string; finished_at: string | null }[]): number | null {
  const seconds = jobs
    .slice(0, 10)
    .filter((job) => job.finished_at)
    .map((job) => (Date.parse(job.finished_at!) - Date.parse(job.started_at)) / 1000)
    .sort((a, b) => a - b)
  return seconds.length ? Math.round(seconds[Math.floor(seconds.length / 2)]) : null
}

const SCAN_STEPS: { key: NonNullable<ScanProgress['step']>; label: string }[] = [
  { key: 'discovery', label: 'ARP discovery' },
  { key: 'services', label: 'Service scan (Nmap)' },
  { key: 'saving', label: 'Classify and save' },
]

function ScanConsole({ scan, typicalSeconds }: { scan: ScanSummary; typicalSeconds: number | null }) {
  const progress = useScanProgress(scan.id).data
  const now = useNow()
  const current = progress?.step ? SCAN_STEPS.findIndex((step) => step.key === progress.step) : -1
  const stepSeconds = progress?.step_started_at ? (now - Date.parse(progress.step_started_at)) / 1000 : null

  return (
    <Console
      title={`Scan #${scan.id} is running on ${scan.subnet}`}
      startedAt={scan.started_at}
      typicalSeconds={typicalSeconds}
      link={{ to: `/scans/${scan.id}`, text: 'Open scan' }}
    >
      {current === -1 ? (
        <Row state="running" label="Discovery, service scan, classification" detail="Steps are reported only for scans started from the dashboard" />
      ) : (
        SCAN_STEPS.map((step, index) => (
          <Row
            key={step.key}
            state={index < current ? 'done' : index === current ? 'running' : 'waiting'}
            label={step.label}
            detail={
              step.key === 'discovery' && index < current && progress?.hosts_found !== null
                ? `${progress?.hosts_found} ${progress?.hosts_found === 1 ? 'device' : 'devices'} answered`
                : step.key === 'services' && index === current && progress?.hosts_found !== null
                  ? `${progress?.hosts_found} ${progress?.hosts_found === 1 ? 'device' : 'devices'}`
                  : undefined
            }
            time={index === current && stepSeconds !== null ? clock(stepSeconds) : undefined}
          />
        ))
      )}
    </Console>
  )
}

function CollectionConsole({ run, typicalSeconds }: { run: NetworkCollectionSummary; typicalSeconds: number | null }) {
  const detail = useCollection(run.id).data
  const results = detail?.results ?? []
  const done = results.filter((result) => result.status !== 'pending').length
  return (
    <Console
      title={`Collection #${run.id}: ${done} of ${results.length || run.device_count} devices done`}
      startedAt={run.started_at}
      typicalSeconds={typicalSeconds}
      fraction={results.length ? done / results.length : undefined}
      link={{ to: '/collections', text: 'Collections' }}
    >
      {results.length === 0 ? (
        <Row state="running" label="Starting" />
      ) : (
        results.map((result) => <DeviceRow key={result.id} result={result} />)
      )}
    </Console>
  )
}

function DeviceRow({ result }: { result: DeviceCollectionResult }) {
  const commands = Object.values(result.collected).filter((rows) => rows !== null).length
  return (
    <Row
      state={result.status === 'pending' ? 'running' : result.status === 'success' ? 'done' : 'failed'}
      label={
        <>
          <span className="text-fg">{result.hostname ?? result.host}</span>
          {result.hostname && <span className="ml-2 font-mono text-[11px] text-fg-muted">{result.host}</span>}
        </>
      }
      detail={
        result.status === 'pending'
          ? 'Logging in and collecting'
          : result.status === 'success'
            ? `${commands} ${commands === 1 ? 'command' : 'commands'} collected${result.config_changed ? ', config changed' : ''}`
            : (result.error ?? 'Failed')
      }
    />
  )
}

// --- building blocks ----------------------------------------------------------------

function Console({
  title,
  startedAt,
  typicalSeconds = null,
  fraction,
  link,
  children,
}: {
  title: string
  startedAt: string
  typicalSeconds?: number | null
  /** Share of the work done, when it is known (devices finished). */
  fraction?: number
  link: { to: string; text: string }
  children: ReactNode
}) {
  const now = useNow()
  const elapsed = (now - Date.parse(startedAt)) / 1000
  return (
    <section role="status" className="overflow-hidden rounded border border-line border-l-[3px] border-l-accent bg-surface">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5">
        <StatusDot status="accent" pulse />
        <h2 className="font-medium text-fg">{title}</h2>
        <span className="tabular font-mono text-xs text-fg-muted">
          {clock(elapsed)}
          {typicalSeconds !== null && <span className="text-fg-subtle"> · usually {clock(typicalSeconds)}</span>}
        </span>
        <Link to={link.to} className="ml-auto text-xs text-accent hover:underline">
          {link.text}
        </Link>
      </header>
      <ul className="border-t border-line py-1">{children}</ul>
      <div className="h-0.5 overflow-hidden bg-raised">
        {fraction === undefined ? (
          <div className="progress-indeterminate h-full w-1/4 bg-accent" />
        ) : (
          <div className="h-full bg-accent transition-[width] duration-500" style={{ width: `${Math.round(fraction * 100)}%` }} />
        )}
      </div>
    </section>
  )
}

type RowState = 'done' | 'running' | 'waiting' | 'failed'

const STATE_LABEL: Record<RowState, string> = { done: 'Done', running: 'Running', waiting: 'Waiting', failed: 'Failed' }

function Row({ state, label, detail, time }: { state: RowState; label: ReactNode; detail?: string; time?: string }) {
  return (
    <li className={`flex min-h-7 items-center gap-2.5 px-3 text-[13px] ${state === 'waiting' ? 'text-fg-subtle' : 'text-fg'}`}>
      <StateIcon state={state} />
      <span className="sr-only">{STATE_LABEL[state]}:</span>
      <span className="min-w-0 shrink-0">{label}</span>
      {detail && (
        <span className={`min-w-0 truncate text-xs ${state === 'failed' ? 'text-crit' : 'text-fg-muted'}`} title={detail}>
          {detail}
        </span>
      )}
      {time && <span className="tabular ml-auto font-mono text-xs text-fg-muted">{time}</span>}
    </li>
  )
}

function StateIcon({ state }: { state: RowState }) {
  if (state === 'running') return <Spinner className="h-3.5 w-3.5 shrink-0 text-accent" />
  const common = { className: 'h-3.5 w-3.5 shrink-0', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true as const }
  if (state === 'done')
    return (
      <svg {...common} className={`${common.className} text-ok`}>
        <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.15" />
        <path d="M4.8 8.2l2.1 2.1 4.3-4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  if (state === 'failed')
    return (
      <svg {...common} className={`${common.className} text-crit`}>
        <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.15" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  return (
    <svg {...common} className={`${common.className} text-fg-subtle`}>
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
    </svg>
  )
}
