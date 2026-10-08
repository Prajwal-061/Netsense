import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api'
import type { DeviceCollectionResult, NetworkCollectionDetail } from '../api'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  PageTitle,
  Spinner,
  TableScroll,
  Td,
  Th,
  TypeBadge,
} from '../components/ui'
import { formatDateTime, formatDuration, ipSortKey, timeAgo } from '../format'
import { useCollection, useCollections, useStartCollection } from '../queries'

export default function Collections() {
  const runs = useCollections()
  const start = useStartCollection()
  const [chosen, setChosen] = useState<number>()
  const running = runs.data?.find((run) => run.status === 'running')
  // Show the running run, else the one picked from the history, else the newest.
  const selectedId = running?.id ?? chosen ?? runs.data?.[0]?.id
  const selected = useCollection(selectedId)

  return (
    <>
      <PageTitle
        title="Collections"
        subtitle="Log in to every router and switch and read its state. Show commands only; nothing on a device is changed."
      />
      <div className="space-y-5">
        <Card title="Collect from all devices">
          <div className="space-y-3 p-4">
            {running ? (
              <Progress run={selected.data?.id === running.id ? selected.data : running} />
            ) : (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button onClick={() => start.mutate()} busy={start.isPending}>
                  Collect from all devices
                </Button>
                <p className="text-sm text-slate-600">
                  Routers, switches and devices recognised as network devices by a scan. A few
                  devices are read at a time; one that fails does not stop the others.
                </p>
              </div>
            )}
            {start.isError && <StartError error={start.error} />}
          </div>
        </Card>

        {runs.isPending ? (
          <Card>
            <Loading label="Loading collections..." />
          </Card>
        ) : runs.isError ? (
          <ErrorBox error={runs.error} onRetry={() => void runs.refetch()} />
        ) : runs.data.length === 0 ? (
          <Card>
            <EmptyState>No collection has been run yet.</EmptyState>
          </Card>
        ) : (
          <>
            <Card
              title={selectedId !== undefined ? `Collection #${selectedId}: devices` : 'Devices'}
              action={
                selected.data && (
                  <span className="text-xs text-slate-500">
                    started {formatDateTime(selected.data.started_at)}
                  </span>
                )
              }
            >
              {selected.isPending ? (
                <Loading />
              ) : selected.isError ? (
                <div className="p-4">
                  <ErrorBox error={selected.error} onRetry={() => void selected.refetch()} />
                </div>
              ) : (
                <ResultsTable run={selected.data} />
              )}
            </Card>

            <Card title="History">
              <TableScroll>
                <thead>
                  <tr>
                    <Th>Run</Th>
                    <Th>Status</Th>
                    <Th>Started</Th>
                    <Th>Duration</Th>
                    <Th className="text-right">Succeeded</Th>
                    <Th className="text-right">Failed</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runs.data.map((run) => (
                    <tr
                      key={run.id}
                      className={`cursor-pointer hover:bg-slate-50 ${run.id === selectedId ? 'bg-blue-50/60' : ''}`}
                      onClick={() => setChosen(run.id)}
                    >
                      <Td>
                        <button
                          type="button"
                          className="font-medium text-blue-700 hover:underline"
                          aria-pressed={run.id === selectedId}
                          onClick={() => setChosen(run.id)}
                        >
                          #{run.id}
                        </button>
                      </Td>
                      <Td>
                        <Badge tone={run.status === 'running' ? 'blue' : run.status === 'failed' ? 'red' : 'green'}>
                          {run.status === 'running' && <Spinner className="h-3 w-3" />}
                          {run.status}
                        </Badge>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {formatDateTime(run.started_at)}
                        <span className="block text-xs text-slate-500">{timeAgo(run.started_at)}</span>
                      </Td>
                      <Td className="whitespace-nowrap tabular-nums">
                        {formatDuration(run.started_at, run.finished_at)}
                      </Td>
                      <Td className="text-right tabular-nums text-emerald-700">{run.succeeded}</Td>
                      <Td className={`text-right tabular-nums ${run.failed ? 'font-semibold text-red-700' : 'text-slate-400'}`}>
                        {run.failed}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            </Card>
          </>
        )}
      </div>
    </>
  )
}

function StartError({ error }: { error: unknown }) {
  // 409: a run is already going. 404: no network device is known yet. Both
  // are things to explain, not failures.
  if (error instanceof ApiError && (error.status === 409 || error.status === 404)) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status">
        {error.status === 409 ? 'A collection is already running, so a second one was not started. ' : ''}
        {error.message}
      </p>
    )
  }
  return <ErrorBox error={error} />
}

function Progress({ run }: { run: { id: number; device_count: number; pending: number; failed: number } }) {
  const done = run.device_count - run.pending
  const percent = run.device_count ? Math.round((done / run.device_count) * 100) : 0
  return (
    <div role="status" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">Collection #{run.id} is running</p>
        <p className="text-sm text-slate-600 tabular-nums">
          {done} of {run.device_count} devices done
          {run.failed > 0 && <span className="text-red-700"> ({run.failed} failed)</span>}
        </p>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={run.device_count}
        aria-valuenow={done}
      >
        <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-2 text-sm text-slate-600">
        Each device appears below as soon as it has answered. This page updates by itself.
      </p>
    </div>
  )
}

function ResultsTable({ run }: { run: NetworkCollectionDetail }) {
  const results = [...run.results].sort((a, b) => ipSortKey(a.host) - ipSortKey(b.host))
  if (results.length === 0) return <EmptyState>This run had no devices.</EmptyState>
  return (
    <TableScroll>
      <thead>
        <tr>
          <Th>Device</Th>
          <Th>Status</Th>
          <Th>Type</Th>
          <Th>Collected</Th>
          <Th>Config</Th>
          <Th>Details</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {results.map((result) => (
          <tr key={result.id} className="hover:bg-slate-50">
            <Td>
              <DeviceName result={result} />
            </Td>
            <Td>
              <StatusBadge status={result.status} />
            </Td>
            <Td>{result.device_type ? <TypeBadge type={result.device_type} /> : '-'}</Td>
            <Td className="text-slate-700">
              {result.status === 'success' ? <CollectedSummary collected={result.collected} /> : '-'}
            </Td>
            <Td>
              {result.status !== 'success' ? (
                '-'
              ) : result.config_changed ? (
                <Badge tone="amber">changed</Badge>
              ) : (
                <span className="text-slate-500">unchanged</span>
              )}
            </Td>
            <Td className="max-w-md min-w-48 text-xs break-words">
              {result.error && <span className="text-red-700">{result.error}</span>}
              {result.note && <span className="text-amber-800">{result.note}</span>}
            </Td>
          </tr>
        ))}
      </tbody>
    </TableScroll>
  )
}

function DeviceName({ result }: { result: DeviceCollectionResult }) {
  const label = (
    <>
      {result.hostname && <span className="font-medium">{result.hostname} </span>}
      <span className="font-mono">{result.host}</span>
    </>
  )
  return result.device_id !== null ? (
    <Link to={`/devices/${result.device_id}`} className="text-blue-700 hover:underline">
      {label}
    </Link>
  ) : (
    label
  )
}

function StatusBadge({ status }: { status: DeviceCollectionResult['status'] }) {
  if (status === 'pending') {
    return (
      <Badge tone="blue">
        <Spinner className="h-3 w-3" />
        collecting
      </Badge>
    )
  }
  return status === 'success' ? <Badge tone="green">success</Badge> : <Badge tone="red">failed</Badge>
}

/** "7 kinds of data", with the kinds and their row counts on hover. */
function CollectedSummary({ collected }: { collected: Record<string, number | null> }) {
  const kinds = Object.entries(collected)
  const detail = kinds
    .map(([kind, rows]) => `${kind.replaceAll('_', ' ')}: ${rows === null ? 'raw text' : rows}`)
    .join('\n')
  return (
    <span title={detail} className="cursor-help underline decoration-dotted underline-offset-2">
      {kinds.length} kinds of data
    </span>
  )
}
