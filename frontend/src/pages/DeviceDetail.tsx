import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api'
import type { CollectedKind, ConfigBackup, Device } from '../api'
import DataTable from '../components/DataTable'
import {
  Badge,
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
  VirtualBadge,
} from '../components/ui'
import { formatDateTime, timeAgo } from '../format'
import {
  isPresent,
  useCollect,
  useCollected,
  useConfig,
  useConfigDiff,
  useConfigs,
  useDevice,
  useLatestCompletedScan,
} from '../queries'

// Types the API allows collecting from: a scan's guess, or confirmed by a login.
const NETWORK_TYPES = ['network device', 'router', 'switch']

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
            <VirtualBadge platform={data.virtualization} />
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
              <Row
                label="Virtualization"
                value={
                  data.virtualization ? (
                    <>
                      <VirtualBadge platform={data.virtualization} />{' '}
                      <span className="text-slate-500">from the MAC prefix</span>
                    </>
                  ) : (
                    <span className="text-slate-500">None detected from the MAC address</span>
                  )
                }
              />
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
              <p className="flex flex-wrap items-center gap-2">
                <TypeBadge type={data.device_type} />
                {data.type_source === 'collected' ? (
                  <Badge tone="green">confirmed by login</Badge>
                ) : (
                  <Badge>guess from scan</Badge>
                )}
              </p>
              <div>
                <p className="text-xs font-medium tracking-wide text-slate-500 uppercase">Reason</p>
                <p className="mt-1 text-slate-800">{data.type_reason || 'No scan result yet.'}</p>
              </div>
              <p className="text-xs text-slate-500">
                {data.type_source === 'collected'
                  ? "The device reported this itself over an SSH login, so scans no longer change it."
                  : 'A rule-based guess from service banners and open ports. Whether the device is virtual is shown separately and does not decide the type.'}
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

        {NETWORK_TYPES.includes(data.device_type) && <Collected device={data} />}
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

const COMMON_TABS: { id: Tab; label: string }[] = [
  { id: 'interfaces', label: 'Interfaces' },
  { id: 'cdp-neighbors', label: 'CDP neighbors' },
  { id: 'arp', label: 'ARP' },
]
const SWITCH_TABS: { id: Tab; label: string }[] = [
  { id: 'vlans', label: 'VLANs' },
  { id: 'trunks', label: 'Trunks' },
  { id: 'spanning-tree', label: 'Spanning tree' },
  { id: 'mac-table', label: 'MAC table' },
]
const ROUTER_TABS: { id: Tab; label: string }[] = [
  { id: 'routes', label: 'Routing table' },
  { id: 'ospf-neighbors', label: 'OSPF neighbors' },
  { id: 'ospf-interfaces', label: 'OSPF interfaces' },
]

/** A router and a switch are asked different things, so they get different tabs. */
function tabsFor(deviceType: string): { id: Tab; label: string }[] {
  const specific = deviceType === 'switch' ? SWITCH_TABS : deviceType === 'router' ? ROUTER_TABS : []
  return [...COMMON_TABS, ...specific, { id: 'configs', label: 'Config backups' }]
}

/** Collect button and tabs. Only rendered for network devices. */
function Collected({ device }: { device: Device }) {
  const [chosenTab, setTab] = useState<Tab>('interfaces')
  const collect = useCollect(device.id)
  const tabs = tabsFor(device.device_type)
  // The tabs change when a collection confirms the device as a router or switch.
  const tab = tabs.some((item) => item.id === chosenTab) ? chosenTab : 'interfaces'

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
            Collected {Object.keys(collect.data.collected).length} kinds of data. Confirmed as a{' '}
            {collect.data.device_type}.{' '}
            {collect.data.first_backup
              ? "This is the device's first config backup."
              : collect.data.config_changed
                ? `The running config has changed since the last backup (${changeSize(collect.data.config_backup)}).`
                : 'The running config is unchanged since the last backup.'}
            {collect.data.note && <span className="mt-1 block text-amber-800">{collect.data.note}</span>}
          </p>
        )}
        {device.device_type === 'network device' && !collect.isPending && (
          <p className="text-xs text-slate-500">
            Collect once to confirm whether this is a router or a switch. Routing and switching
            tabs appear after that.
          </p>
        )}
      </div>

      <div className="mt-3 flex gap-1 overflow-x-auto border-b border-slate-200 px-3" role="tablist">
        {tabs.map((item) => (
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
    // 404 is the API's way of saying "never collected" (or "not collected
    // from this kind of device"), not a failure.
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

/** "+4 / -1 lines": how much a backup differs from the one before it. */
function changeSize(backup: ConfigBackup): string {
  return `+${backup.lines_added} / -${backup.lines_removed} lines`
}

function ConfigsTab({ deviceId }: { deviceId: number }) {
  const configs = useConfigs(deviceId)
  const [mode, setMode] = useState<'view' | 'compare'>('view')
  const [chosen, setChosen] = useState<number>()
  const [chosenFrom, setChosenFrom] = useState<number>()
  const [chosenTo, setChosenTo] = useState<number>()

  if (configs.isPending) return <Loading />
  if (configs.isError) {
    return (
      <div className="p-4">
        <ErrorBox error={configs.error} onRetry={() => void configs.refetch()} />
      </div>
    )
  }
  const backups = configs.data // newest first
  if (backups.length === 0) return <NothingCollected />

  const latest = backups[0]
  // Until the user picks something: view the newest backup, and compare the
  // previous backup with the newest.
  const selected = chosen ?? latest.id
  const fromId = chosenFrom ?? backups[1]?.id
  const toId = chosenTo ?? latest.id

  return (
    <div className="space-y-4 p-4">
      {latest.changed && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <Badge tone="amber">Config changed since last backup</Badge>
          <span>
            {changeSize(latest)}, collected {formatDateTime(latest.collected_at)}.
          </span>
          <button
            type="button"
            className="font-medium text-blue-700 hover:underline"
            onClick={() => {
              setChosenFrom(backups[1].id)
              setChosenTo(latest.id)
              setMode('compare')
            }}
          >
            Show what changed
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <ul className="space-y-2" aria-label="Config backups">
          {backups.map((backup, index) => (
            <li key={backup.id}>
              <button
                type="button"
                onClick={() => {
                  setChosen(backup.id)
                  setMode('view')
                }}
                aria-pressed={mode === 'view' && backup.id === selected}
                className={`w-full rounded-md border px-3 py-2 text-left text-sm ${
                  mode === 'view' && backup.id === selected
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'
                }`}
              >
                <span className="flex items-center justify-between gap-2 font-medium text-slate-900">
                  {formatDateTime(backup.collected_at)}
                  {index === 0 && <span className="text-xs font-normal text-emerald-700">current</span>}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-2">
                  {/* Only say what the API actually reported. A missing value
                      (older backend) shows no badge, not a guessed "no change". */}
                  {backup.changed === null && <Badge>first backup</Badge>}
                  {backup.changed === true && <Badge tone="amber">changed {changeSize(backup)}</Badge>}
                  {backup.changed === false && <Badge>no change</Badge>}
                  <span className="text-xs text-slate-500">#{backup.id}</span>
                </span>
                <span className="mt-1 block text-xs text-slate-500">
                  {backup.lines} lines · unchanged as of {timeAgo(backup.last_seen_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="min-w-0">
          <div className="mb-3 inline-flex rounded-md border border-slate-300 p-0.5 text-sm" role="group" aria-label="Config view">
            {(['view', 'compare'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={mode === item}
                onClick={() => setMode(item)}
                className={`rounded px-3 py-1 font-medium ${
                  mode === item ? 'bg-slate-800 text-white' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {item === 'view' ? 'View config' : 'Compare backups'}
              </button>
            ))}
          </div>

          {mode === 'view' ? (
            <ConfigText deviceId={deviceId} backupId={selected} />
          ) : backups.length < 2 ? (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-600">
              There is only one backup so far. A second one is stored when a collection finds
              that the config has changed, and then the two can be compared.
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-end gap-3">
                <BackupSelect label="From (older)" backups={backups} value={fromId!} onChange={setChosenFrom} />
                <BackupSelect label="To (newer)" backups={backups} value={toId} onChange={setChosenTo} />
              </div>
              <ConfigComparison deviceId={deviceId} fromId={fromId!} toId={toId} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function BackupSelect({
  label,
  backups,
  value,
  onChange,
}: {
  label: string
  backups: ConfigBackup[]
  value: number
  onChange: (id: number) => void
}) {
  return (
    <label className="text-xs font-medium text-slate-600">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-blue-500 focus:outline-none"
      >
        {backups.map((backup) => (
          <option key={backup.id} value={backup.id}>
            #{backup.id} · {formatDateTime(backup.collected_at)}
          </option>
        ))}
      </select>
    </label>
  )
}

function ConfigText({ deviceId, backupId }: { deviceId: number; backupId: number }) {
  const config = useConfig(deviceId, backupId)

  if (config.isPending) return <Loading label="Loading config..." />
  if (config.isError) return <ErrorBox error={config.error} onRetry={() => void config.refetch()} />
  return (
    <>
      <p className="mb-2 text-xs text-slate-500">
        Passwords, SNMP communities and keys are masked by the API before the config is sent to
        the browser.
      </p>
      <pre className="max-h-[32rem] overflow-auto rounded-md bg-slate-950 p-4 font-mono text-xs leading-relaxed text-slate-100">
        {config.data.config}
      </pre>
    </>
  )
}

function ConfigComparison({ deviceId, fromId, toId }: { deviceId: number; fromId: number; toId: number }) {
  const comparison = useConfigDiff(deviceId, fromId, toId)

  if (comparison.isPending) return <Loading label="Comparing..." />
  if (comparison.isError) {
    return <ErrorBox error={comparison.error} onRetry={() => void comparison.refetch()} />
  }
  const data = comparison.data
  if (!data.changed) {
    return (
      <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-600">
        {fromId === toId
          ? 'The same backup is selected on both sides.'
          : 'These two backups have the same configuration. Timestamp lines are ignored.'}
      </p>
    )
  }
  return (
    <>
      <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone="green">+{data.lines_added} added</Badge>
        <Badge tone="red">-{data.lines_removed} removed</Badge>
        <span className="text-xs text-slate-500">
          Timestamp lines are ignored and secrets are masked.
        </span>
      </p>
      <DiffView diff={data.diff} />
    </>
  )
}

/** A unified diff in monospace: added lines green, removed lines red. */
function DiffView({ diff }: { diff: string }) {
  return (
    <div className="max-h-[32rem] overflow-auto rounded-md bg-slate-950 py-3 font-mono text-xs leading-relaxed">
      {/* min-w-max keeps each line's background colour as wide as the longest line. */}
      <div className="min-w-max">
        {diff.split('\n').map((line, index) => (
          <div key={index} className={`px-4 whitespace-pre ${diffLineColour(line)}`}>
            {line || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}

function diffLineColour(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'font-semibold text-slate-400'
  if (line.startsWith('@@')) return 'text-sky-400'
  if (line.startsWith('+')) return 'bg-emerald-500/15 text-emerald-300'
  if (line.startsWith('-')) return 'bg-red-500/15 text-red-300'
  return 'text-slate-300'
}
