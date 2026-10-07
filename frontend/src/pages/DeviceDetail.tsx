import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api'
import type { CollectedKind, Device } from '../api'
import DataTable from '../components/DataTable'
import {
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  PageTitle,
  PresenceBadge,
  TableScroll,
  Td,
  Th,
  TypeBadge,
} from '../components/ui'
import { formatDateTime, timeAgo } from '../format'
import {
  isPresent,
  useCollect,
  useCollected,
  useConfig,
  useConfigs,
  useDevice,
  useLatestCompletedScan,
} from '../queries'

const NETWORK_DEVICE = 'network device'

export default function DeviceDetail() {
  const id = Number(useParams().id)
  if (!Number.isInteger(id)) return <EmptyState>That is not a valid device number.</EmptyState>
  // The key makes React start this part fresh for each device, so the open
  // tab and any collect message never carry over from the previous device.
  return <DeviceView key={id} id={id} />
}

function DeviceView({ id }: { id: number }) {
  const device = useDevice(id)
  const latestScan = useLatestCompletedScan()

  if (device.isPending) return <Loading label="Loading device..." />
  if (device.isError) return <ErrorBox error={device.error} onRetry={() => void device.refetch()} />

  const data = device.data
  const result = data.latest_result
  const ports = result?.open_ports ?? []

  return (
    <>
      <p className="mb-2 text-sm">
        <Link to="/devices" className="text-blue-700 hover:underline">
          Devices
        </Link>
        <span className="text-slate-400"> / </span>
        {data.last_ip}
      </p>
      <PageTitle
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{data.last_ip}</span>
            <TypeBadge type={data.device_type} />
            <PresenceBadge present={isPresent(data, latestScan?.id)} />
          </span>
        }
        subtitle={data.vendor}
      />

      <div className="space-y-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Device">
            <dl className="divide-y divide-slate-100 text-sm">
              <Row label="IP address" value={<span className="font-mono">{data.last_ip}</span>} />
              <Row label="MAC address" value={<span className="font-mono">{data.mac}</span>} />
              <Row label="Vendor" value={data.vendor} />
              <Row label="First seen" value={formatDateTime(data.first_seen)} />
              <Row
                label="Last seen"
                value={
                  <>
                    {formatDateTime(data.last_seen)}{' '}
                    <span className="text-slate-500">({timeAgo(data.last_seen)})</span>
                  </>
                }
              />
              {result && (
                <Row
                  label="Last scan"
                  value={
                    <Link to={`/scans/${result.scan_id}`} className="text-blue-700 hover:underline">
                      Scan #{result.scan_id}
                    </Link>
                  }
                />
              )}
            </dl>
          </Card>

          <Card title="Classification">
            <div className="space-y-3 p-4 text-sm">
              <p>
                <TypeBadge type={data.device_type} />
              </p>
              <div>
                <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Reason</p>
                <p className="mt-1 text-slate-800">{result?.reason ?? 'No scan result yet.'}</p>
              </div>
              <p className="text-xs text-slate-500">
                The type is a rule-based guess from service banners, open ports and the MAC
                vendor. It is not a certainty.
              </p>
            </div>
          </Card>
        </div>

        <Card title={`Open ports (${ports.length})`}>
          {ports.length === 0 ? (
            <EmptyState>No open ports were found among the common ports scanned.</EmptyState>
          ) : (
            <TableScroll>
              <thead>
                <tr>
                  <Th>Port</Th>
                  <Th>Service</Th>
                  <Th>Product</Th>
                  <Th>Version</Th>
                  <Th>Details</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ports.map((port) => (
                  <tr key={`${port.port}/${port.protocol}`} className="hover:bg-slate-50">
                    <Td className="font-mono font-medium whitespace-nowrap">
                      {port.port}/{port.protocol}
                    </Td>
                    <Td>{port.service || '-'}</Td>
                    <Td>{port.product || '-'}</Td>
                    <Td className="font-mono text-xs">{port.version || '-'}</Td>
                    <Td className="text-xs text-slate-600">
                      {[port.extra_info, port.os_type && `OS: ${port.os_type}`].filter(Boolean).join(' · ') || '-'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableScroll>
          )}
        </Card>

        {data.device_type === NETWORK_DEVICE && <Collected device={data} />}
      </div>
    </>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 px-4 py-2.5">
      <dt className="text-slate-500">{label}</dt>
      <dd className="text-right text-slate-900">{value}</dd>
    </div>
  )
}

type Tab = CollectedKind | 'configs'

const TABS: { id: Tab; label: string }[] = [
  { id: 'interfaces', label: 'Interfaces' },
  { id: 'vlans', label: 'VLANs' },
  { id: 'mac-table', label: 'MAC table' },
  { id: 'configs', label: 'Config backups' },
]

/** Collect button and tabs. Only rendered for network devices. */
function Collected({ device }: { device: Device }) {
  const [tab, setTab] = useState<Tab>('interfaces')
  const collect = useCollect(device.id)

  return (
    <Card
      title="Collected from the device"
      action={
        <Button onClick={() => collect.mutate()} busy={collect.isPending}>
          {collect.isPending ? 'Collecting...' : 'Collect from device'}
        </Button>
      }
    >
      <div className="space-y-3 px-4 pt-3">
        <p className="text-xs text-slate-500">
          Logs in over SSH and runs read-only show commands. Nothing on the device is changed.
        </p>
        {collect.isError && <ErrorBox error={collect.error} />}
        {collect.isSuccess && (
          <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">
            Collected {describeCount(collect.data.interfaces, 'interface')},{' '}
            {describeCount(collect.data.vlans, 'VLAN')} and{' '}
            {describeCount(collect.data.mac_table, 'MAC table entry', 'MAC table entries')}.{' '}
            {collect.data.config_changed
              ? 'The running config is new or has changed, so a backup was saved.'
              : 'The running config is unchanged since the last backup.'}
          </p>
        )}
      </div>

      <div className="mt-3 flex gap-1 overflow-x-auto border-b border-slate-200 px-3" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${
              tab === item.id
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'configs' ? <ConfigsTab deviceId={device.id} /> : <CollectedTab key={tab} deviceId={device.id} kind={tab} />}
      </div>
    </Card>
  )
}

function describeCount(count: number | null, singular: string, plural = `${singular}s`): string {
  if (count === null) return `the ${plural} as raw text`
  return `${count} ${count === 1 ? singular : plural}`
}

function NothingCollected() {
  return (
    <EmptyState>
      Nothing has been collected from this device yet. Use "Collect from device" above.
    </EmptyState>
  )
}

function CollectedTab({ deviceId, kind }: { deviceId: number; kind: CollectedKind }) {
  const collected = useCollected(deviceId, kind)

  if (collected.isPending) return <Loading />
  if (collected.isError) {
    // 404 is the API's way of saying "never collected", not a failure.
    if (collected.error instanceof ApiError && collected.error.status === 404) return <NothingCollected />
    return (
      <div className="p-4">
        <ErrorBox error={collected.error} onRetry={() => void collected.refetch()} />
      </div>
    )
  }
  return (
    <>
      <p className="px-4 pt-3 text-xs text-slate-500">
        Collected {formatDateTime(collected.data.collected_at)} ({timeAgo(collected.data.collected_at)})
      </p>
      <DataTable data={collected.data.data} />
    </>
  )
}

function ConfigsTab({ deviceId }: { deviceId: number }) {
  const configs = useConfigs(deviceId)
  const [chosen, setChosen] = useState<number>()
  // Show the newest backup until the user picks another.
  const selected = chosen ?? configs.data?.[0]?.id
  const config = useConfig(deviceId, selected)

  if (configs.isPending) return <Loading />
  if (configs.isError) {
    return (
      <div className="p-4">
        <ErrorBox error={configs.error} onRetry={() => void configs.refetch()} />
      </div>
    )
  }
  if (configs.data.length === 0) return <NothingCollected />

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[18rem_1fr]">
      <ul className="space-y-2">
        {configs.data.map((backup, index) => (
          <li key={backup.id}>
            <button
              type="button"
              onClick={() => setChosen(backup.id)}
              aria-pressed={backup.id === selected}
              className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                backup.id === selected
                  ? 'border-blue-500 bg-blue-50'
                  : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <span className="flex items-center justify-between gap-2 font-medium text-slate-900">
                {formatDateTime(backup.collected_at)}
                {index === 0 && <span className="text-xs font-normal text-emerald-700">current</span>}
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                {backup.lines} lines · unchanged as of {timeAgo(backup.last_seen_at)}
              </span>
              <span className="mt-0.5 block font-mono text-xs text-slate-400" title={backup.sha256}>
                sha256 {backup.sha256.slice(0, 12)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="min-w-0">
        {config.isPending ? (
          <Loading label="Loading config..." />
        ) : config.isError ? (
          <ErrorBox error={config.error} onRetry={() => void config.refetch()} />
        ) : (
          <>
            <p className="mb-2 text-xs text-slate-500">
              Passwords, SNMP communities and keys are masked by the API before the config is
              sent to the browser.
            </p>
            <pre className="max-h-[32rem] overflow-auto rounded-md bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100">
              {config.data.config}
            </pre>
          </>
        )}
      </div>
    </div>
  )
}
