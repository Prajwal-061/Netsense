import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api'
import type { DriftCheck, DriftFinding, DriftReport } from '../api'
import DiffView from '../components/CodeView'
import { inputClass } from '../components/controls'
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Loading,
  MessageBar,
  PageTitle,
  SeverityBadge,
  StatusDot,
} from '../components/ui'
import { formatDateTime, timeAgo } from '../format'
import {
  useBaseline,
  useCollection,
  useCollections,
  useDriftCheck,
  useDriftChecks,
  useSetBaseline,
  useStartDriftCheck,
  useTopology,
} from '../queries'
import TopologyMap from '../topology/TopologyMap'
import { Legend } from './Topology'

export default function NetworkHealth() {
  const checks = useDriftChecks()
  const [chosen, setChosen] = useState<number>()
  const running = checks.data?.find((check) => check.status === 'running')
  const selectedId = running?.id ?? chosen ?? checks.data?.[0]?.id
  const check = useDriftCheck(selectedId)

  return (
    <>
      <PageTitle
        title="Network health"
        subtitle="Compare the network with a baseline taken while it was healthy, and see what changed, what broke, and what probably caused it."
      />
      <div className="space-y-5">
        <BaselineCard />
        <Card title="Drift check">
          <DriftControl running={running} />
          {checks.data && checks.data.length > 1 && !running && (
            <div className="border-t border-line px-4 py-3">
              <label className="text-[12px] font-medium text-fg-muted">
                Show an earlier check
                <select
                  value={selectedId ?? ''}
                  onChange={(event) => setChosen(Number(event.target.value))}
                  className={`mt-1 block ${inputClass}`}
                >
                  {checks.data.map((item) => (
                    <option key={item.id} value={item.id}>
                      Check #{item.id} · {formatDateTime(item.started_at)}
                      {item.summary ? ` · ${item.summary.critical} critical, ${item.summary.warning} warning` : ` · ${item.status}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </Card>

        {check.data && check.data.status !== 'running' && <Result check={check.data} />}
        {check.isError && <ErrorBox error={check.error} onRetry={() => void check.refetch()} />}
      </div>
    </>
  )
}

// --- baseline ----------------------------------------------------------------

function BaselineCard() {
  const baseline = useBaseline()
  const runs = useCollections()
  const setBaseline = useSetBaseline()
  const [choice, setChoice] = useState<number>()
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)

  const finished = (runs.data ?? []).filter((run) => run.status !== 'running' && run.succeeded > 0)
  const showForm = editing || baseline.data === null

  return (
    <Card
      title="Baseline"
      action={
        baseline.data && !editing ? (
          <button type="button" onClick={() => setEditing(true)} className="text-[12px] font-medium text-link hover:underline">
            Change baseline
          </button>
        ) : null
      }
    >
      <div className="space-y-3 p-4 text-[13px]">
        {baseline.isPending ? (
          <Loading />
        ) : baseline.isError ? (
          <ErrorBox error={baseline.error} onRetry={() => void baseline.refetch()} />
        ) : baseline.data ? (
          <div>
            <p className="text-fg">
              <span className="font-semibold">Collection #{baseline.data.collection_id}</span>, collected{' '}
              {formatDateTime(baseline.data.collected_at)} ({timeAgo(baseline.data.collected_at)})
            </p>
            {baseline.data.note && <p className="mt-0.5 text-fg">"{baseline.data.note}"</p>}
            <p className="mt-1 text-[12px] text-fg-muted">
              Set as baseline {formatDateTime(baseline.data.set_at)} · devices:{' '}
              {baseline.data.devices.map((device) => device.name ?? device.host).join(', ')}
              {baseline.data.devices.some((device) => device.status !== 'success') &&
                ' (some could not be collected then, and are not compared)'}
            </p>
          </div>
        ) : (
          <p className="text-fg">
            No baseline yet. Pick a collection taken while the network was working as intended; every drift
            check is then judged against it.
          </p>
        )}

        {showForm && (
          <form
            className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-canvas p-3"
            onSubmit={(event) => {
              event.preventDefault()
              const id = choice ?? finished[0]?.id
              if (id !== undefined)
                setBaseline.mutate({ collectionId: id, note }, { onSuccess: () => { setEditing(false); setNote('') } })
            }}
          >
            <label className="text-[12px] font-medium text-fg-muted">
              Collection
              <select
                value={choice ?? finished[0]?.id ?? ''}
                onChange={(event) => setChoice(Number(event.target.value))}
                className={`mt-1 block ${inputClass}`}
              >
                {finished.map((run) => (
                  <option key={run.id} value={run.id}>
                    #{run.id} · {formatDateTime(run.started_at)} · {run.succeeded}/{run.device_count} devices
                  </option>
                ))}
              </select>
            </label>
            <label className="min-w-48 flex-1 text-[12px] font-medium text-fg-muted">
              Note (optional)
              <input
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="e.g. Healthy lab before the OSPF work"
                maxLength={500}
                className={`mt-1 block w-full ${inputClass}`}
              />
            </label>
            <Button type="submit" busy={setBaseline.isPending} disabled={finished.length === 0}>
              Set as baseline
            </Button>
            {baseline.data && (
              <button type="button" onClick={() => setEditing(false)} className="pb-2 text-[12px] text-fg-muted hover:underline">
                Cancel
              </button>
            )}
            <p className="w-full text-[12px] text-fg-muted">
              {finished.length === 0
                ? 'There is no finished collection yet. Collect from all devices first.'
                : 'Only choose a collection from when the network was healthy. After an intentional change, set a new baseline so the change counts as normal.'}
            </p>
            {setBaseline.isError && <div className="w-full"><ErrorBox error={setBaseline.error} /></div>}
          </form>
        )}
      </div>
    </Card>
  )
}

// --- running a check ------------------------------------------------------------

function DriftControl({ running }: { running?: { id: number; collection_id: number } }) {
  const baseline = useBaseline()
  const start = useStartDriftCheck()
  const collection = useCollection(running?.collection_id)

  if (running) {
    const run = collection.data
    const done = run ? run.device_count - run.pending : 0
    const total = run?.device_count ?? 0
    return (
      <div className="p-4" role="status" aria-live="polite">
        <p className="text-[13px] font-semibold text-fg">
          Drift check #{running.id} is running: {run && run.pending === 0 ? 'comparing with the baseline' : `collecting, ${done} of ${total} devices done`}
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-raised">
          <div className="h-full rounded-full bg-accent transition-all" style={{ width: total ? `${(done / total) * 100}%` : '5%' }} />
        </div>
        <p className="mt-2 text-[13px] text-fg-muted">
          Every router and switch is read with show commands, then compared with the baseline. This page updates by itself.
        </p>
      </div>
    )
  }
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button onClick={() => start.mutate()} busy={start.isPending} disabled={!baseline.data}>
          Run drift check
        </Button>
        <p className="text-[13px] text-fg-muted">
          {baseline.data
            ? 'Collects from every device now and compares it with the baseline. Nothing on a device is changed.'
            : 'Set a baseline first.'}
        </p>
      </div>
      {start.isError && (
        start.error instanceof ApiError && start.error.status === 409 ? (
          <MessageBar tone="warn">{start.error.message}</MessageBar>
        ) : (
          <ErrorBox error={start.error} />
        )
      )}
    </div>
  )
}

// --- the result ----------------------------------------------------------------

function Result({ check }: { check: DriftCheck }) {
  if (check.status === 'failed' || !check.report) {
    return <ErrorBox error={new Error(check.error ?? 'The drift check failed.')} />
  }
  const report = check.report
  return (
    <>
      <Summary check={check} report={report} />
      {report.findings.length > 0 && (
        <>
          <Causes report={report} />
          <ChangedMap report={report} />
          <ByDevice report={report} />
        </>
      )}
    </>
  )
}

function Summary({ check, report }: { check: DriftCheck; report: DriftReport }) {
  // A count in its severity's colour. A zero is neutral: nothing to look at.
  const tile = (label: string, value: number, tone: 'crit' | 'warn' | 'info') => {
    const look = {
      crit: 'border-crit-border bg-crit-bg text-crit-fg',
      warn: 'border-warn-border bg-warn-bg text-warn-fg',
      info: 'border-info-border bg-info-bg text-info-fg',
    }[tone]
    return (
      <div className={`rounded border p-3 ${value ? look : 'border-line bg-surface text-fg-muted'}`}>
        <p className="text-[20px] leading-[26px] font-medium tabular-nums">{value}</p>
        <p className="text-[13px]">{label}</p>
      </div>
    )
  }
  const clean = report.findings.length === 0
  return (
    <Card title={`Check #${check.id}`} action={<span className="text-[12px] text-fg-muted">{formatDateTime(check.started_at)}</span>}>
      <div className="space-y-3 p-4">
        <p className="text-[13px] text-fg-muted">
          Collection #{check.collection_id} compared with baseline collection #{check.baseline_collection_id} ·{' '}
          {report.summary.devices_compared} devices compared, {report.summary.devices_with_drift} with drift
        </p>
        {clean ? (
          <MessageBar tone="ok" title={<StatusDot status="ok">No drift: the network matches the baseline.</StatusDot>} />
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {tile('Critical', report.summary.critical, 'crit')}
            {tile('Warning', report.summary.warning, 'warn')}
            {tile('Info', report.summary.info, 'info')}
          </div>
        )}
      </div>
    </Card>
  )
}

function FindingLink({ finding }: { finding: DriftFinding }) {
  return (
    <a href={`#finding-${finding.id}`} className="text-link hover:underline">
      {finding.message}
    </a>
  )
}

function Causes({ report }: { report: DriftReport }) {
  const byId = new Map(report.findings.map((finding) => [finding.id, finding]))
  if (report.chains.length === 0) return null
  return (
    <Card title="Probable causes">
      <ul className="divide-y divide-line">
        {report.chains.map((chain) => {
          const cause = byId.get(chain.cause)!
          return (
            <li key={chain.cause} className="p-4">
              <p className="flex flex-wrap items-start gap-2 text-[13px] font-medium text-fg">
                <SeverityBadge severity={cause.severity} />
                <FindingLink finding={cause} />
              </p>
              <p className="mt-2 text-[12px] font-medium tracking-wide text-fg-muted uppercase">Probably led to</p>
              <ul className="mt-1 space-y-1">
                {chain.effects.map((id) => {
                  const effect = byId.get(id)!
                  return (
                    <li key={id} className="flex flex-wrap items-start gap-2 text-[13px]">
                      <SeverityBadge severity={effect.severity} />
                      <FindingLink finding={effect} />
                    </li>
                  )
                })}
              </ul>
            </li>
          )
        })}
      </ul>
      <p className="border-t border-line px-4 py-2.5 text-[12px] text-fg-muted">
        A change is linked to an effect when they are in the same place: the same interface, the two ends of one
        link, or (for spanning tree) the same VLAN. This points at likely causes; it cannot prove them, and it
        cannot see causes outside NetSense's view, such as a cable or a device it does not manage.
      </p>
    </Card>
  )
}

function ChangedMap({ report }: { report: DriftReport }) {
  const topology = useTopology(report.collection_id ?? undefined)
  const options = useMemo(() => ({ changed: report.highlight }), [report.highlight])
  return (
    <Card title="Where it changed">
      {topology.isPending ? (
        <Loading label="Loading topology..." />
      ) : topology.isError ? (
        <div className="p-4"><ErrorBox error={topology.error} /></div>
      ) : (
        <>
          <TopologyMap topology={topology.data} options={options} className="h-[min(60vh,520px)] min-h-[360px]" />
          <Legend showChanged />
        </>
      )}
    </Card>
  )
}

const DEVICE_STATUS = {
  changed: <Badge tone="amber">changed</Badge>,
  unreachable: <Badge tone="red">unreachable</Badge>,
  unchanged: <Badge tone="green">unchanged</Badge>,
  new: <Badge tone="blue">new</Badge>,
  'not in baseline': <Badge>not in baseline</Badge>,
}

function ByDevice({ report }: { report: DriftReport }) {
  const byId = new Map(report.findings.map((finding) => [finding.id, finding]))
  const unchanged = report.devices.filter((device) => device.findings.length === 0)
  return (
    <div className="space-y-5">
      {report.devices
        .filter((device) => device.findings.length > 0)
        .map((device) => (
          <Card
            key={device.name}
            title={
              <span className="flex items-center gap-2">
                {device.device_id !== null ? (
                  <Link to={`/devices/${device.device_id}`} className="text-link hover:underline">
                    {device.name}
                  </Link>
                ) : (
                  device.name
                )}
                {device.host && <span className="font-mono text-[12px] font-normal text-fg-muted">{device.host}</span>}
                {DEVICE_STATUS[device.status]}
              </span>
            }
          >
            <ul className="divide-y divide-line">
              {device.findings.map((id) => (
                <FindingItem key={id} finding={byId.get(id)!} byId={byId} />
              ))}
            </ul>
            {report.config_diffs[device.name] && (
              <details className="border-t border-line px-4 py-3">
                <summary className="cursor-pointer text-[13px] font-medium text-link">
                  Full configuration diff for {device.name}
                </summary>
                <div className="mt-2">
                  <DiffView diff={report.config_diffs[device.name]} maxHeight="max-h-96" />
                </div>
              </details>
            )}
          </Card>
        ))}
      {unchanged.length > 0 && (
        <p className="text-[13px] text-fg-muted">
          Unchanged: {unchanged.map((device) => device.name).join(', ')}
        </p>
      )}
    </div>
  )
}

const CATEGORY_LABELS: Record<DriftFinding['category'], string> = {
  reachability: 'reachability',
  config: 'configuration',
  interface: 'interface',
  vlan: 'VLAN',
  trunk: 'trunk',
  stp: 'spanning tree',
  ospf: 'OSPF',
  route: 'routing',
  topology: 'topology',
  version: 'software',
}

function FindingItem({ finding, byId }: { finding: DriftFinding; byId: Map<string, DriftFinding> }) {
  return (
    <li id={`finding-${finding.id}`} className="scroll-mt-4 px-4 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="text-[12px] font-medium tracking-wide text-fg-muted uppercase">{CATEGORY_LABELS[finding.category]}</span>
      </div>
      <p className="mt-1 text-[13px] text-fg">{finding.message}</p>
      {finding.details.filter(Boolean).map((line, index) => (
        <p key={index} className="mt-0.5 text-[12px] text-fg-muted">
          {line}
        </p>
      ))}
      {finding.caused_by.length > 0 && (
        <p className="mt-1.5 text-[12px] text-fg">
          <span className="font-semibold">Probable cause:</span>{' '}
          {finding.caused_by.map((id, index) => (
            <span key={id}>
              {index > 0 && '; '}
              <FindingLink finding={byId.get(id)!} />
            </span>
          ))}
        </p>
      )}
      {finding.effects.length > 0 && (
        <p className="mt-1.5 text-[12px] text-fg">
          <span className="font-semibold">Probably led to {finding.effects.length} other finding{finding.effects.length > 1 ? 's' : ''}</span>, listed under Probable causes.
        </p>
      )}
      {finding.diff && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px] font-medium text-link">Show the configuration change</summary>
          <div className="mt-1.5">
            <DiffView diff={finding.diff} maxHeight="max-h-64" />
          </div>
        </details>
      )}
    </li>
  )
}

