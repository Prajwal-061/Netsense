import { Link } from 'react-router-dom'
import ChangeReportView from '../components/ChangeReport'
import ScanControl from '../components/ScanControl'
import { Card, ErrorBox, Loading, PageTitle, ScanStatusBadge, TypeBadge } from '../components/ui'
import { formatDateTime, formatDuration, timeAgo } from '../format'
import { isPresent, useDevices, useLatestCompletedScan, useScan, useScans } from '../queries'

export default function Overview() {
  const devices = useDevices()
  const scans = useScans()
  const latestCompleted = useLatestCompletedScan()
  const latestDetail = useScan(latestCompleted?.id)
  const lastScan = scans.data?.[0]

  // Count devices per type, most common first.
  const byType = new Map<string, number>()
  for (const device of devices.data ?? []) {
    byType.set(device.device_type, (byType.get(device.device_type) ?? 0) + 1)
  }
  const types = [...byType.entries()].sort((a, b) => b[1] - a[1])
  const up = (devices.data ?? []).filter((device) => isPresent(device, latestCompleted?.id)).length

  return (
    <>
      <PageTitle title="Overview" subtitle="Devices on the network and what changed in the last scan." />
      <div className="space-y-5">
        <Card title="Scan">
          <ScanControl />
          {lastScan && (
            <dl className="grid gap-x-6 gap-y-2 border-t border-slate-200 px-4 py-3 text-sm sm:grid-cols-4">
              <Fact label="Last scan">
                <Link to={`/scans/${lastScan.id}`} className="font-medium text-blue-700 hover:underline">
                  #{lastScan.id}
                </Link>{' '}
                <ScanStatusBadge status={lastScan.status} />
              </Fact>
              <Fact label="Started">
                <span title={formatDateTime(lastScan.started_at)}>{timeAgo(lastScan.started_at)}</span>
                <span className="block text-xs text-slate-500">{formatDateTime(lastScan.started_at)}</span>
              </Fact>
              <Fact label="Duration">{formatDuration(lastScan.started_at, lastScan.finished_at)}</Fact>
              <Fact label="Devices found">{lastScan.status === 'completed' ? lastScan.device_count : '-'}</Fact>
            </dl>
          )}
          {scans.data?.length === 0 && (
            <p className="border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
              No scans yet. Start one to discover the network.
            </p>
          )}
        </Card>

        <Card
          title="Latest changes"
          action={
            latestCompleted && (
              <Link to={`/scans/${latestCompleted.id}`} className="text-xs font-medium text-blue-700 hover:underline">
                Scan #{latestCompleted.id}, {timeAgo(latestCompleted.started_at)}
              </Link>
            )
          }
        >
          {latestDetail.isError ? (
            <div className="p-4">
              <ErrorBox error={latestDetail.error} onRetry={() => void latestDetail.refetch()} />
            </div>
          ) : latestDetail.data?.changes ? (
            <ChangeReportView report={latestDetail.data.changes} />
          ) : scans.isPending || latestDetail.isLoading ? (
            <Loading />
          ) : (
            <p className="px-4 py-4 text-sm text-slate-600">
              No completed scan yet, so there is nothing to compare.
            </p>
          )}
        </Card>

        <Card
          title="Devices"
          action={
            <Link to="/devices" className="text-xs font-medium text-blue-700 hover:underline">
              View all
            </Link>
          }
        >
          {devices.isPending ? (
            <Loading />
          ) : devices.isError ? (
            <div className="p-4">
              <ErrorBox error={devices.error} onRetry={() => void devices.refetch()} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
              <Tile value={devices.data.length} label="Known devices" to="/devices" />
              <Tile value={up} label="Up in the last scan" to="/devices" tone="text-emerald-700" />
              {types.map(([type, count]) => (
                <Tile
                  key={type}
                  value={count}
                  label={<TypeBadge type={type} />}
                  to={`/devices?type=${encodeURIComponent(type)}`}
                />
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className="mt-0.5 text-slate-900">{children}</dd>
    </div>
  )
}

function Tile({
  value,
  label,
  to,
  tone = 'text-slate-900',
}: {
  value: number
  label: React.ReactNode
  to: string
  tone?: string
}) {
  return (
    <Link to={to} className="rounded-lg border border-slate-200 p-3 hover:border-blue-300 hover:bg-blue-50/40">
      <p className={`text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      <p className="mt-1 text-sm text-slate-600">{label}</p>
    </Link>
  )
}
