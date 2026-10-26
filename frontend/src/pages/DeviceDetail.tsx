import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ApiError } from '../api'
import type { CollectedKind, CollectedRow, ConfigBackup, Device } from '../api'
import DiffView, { ConfigView } from '../components/CodeView'
import DataTable from '../components/DataTable'
import Faceplate from '../components/Faceplate'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  FieldLabel,
  KeyValueGrid,
  Loading,
  MessageBar,
  PageTitle,
  PresenceBadge,
  RelativeTime,
  Select,
  StatusDot,
  TableScroll,
  Td,
  Th,
  TypeBadge,
  VirtualBadge,
} from '../components/ui'
import { buildPanel } from '../faceplate'
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
  useTopology,
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
  const topology = useTopology()
  const collect = useCollect(id)

  if (device.isPending) return <Loading label="Loading device..." />
  if (device.isError) return <ErrorBox error={device.error} onRetry={() => void device.refetch()} />

  const data = device.data
  const result = data.latest_result
  const ports = result?.open_ports ?? []
  const node = topology.data?.nodes.find((item) => item.device_id === data.id)
  const network = NETWORK_TYPES.includes(data.device_type)

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-1 text-xs text-fg-muted">
        <Link to="/devices" className="hover:text-accent">
          Devices
        </Link>
        <span className="text-fg-subtle"> / </span>
        <span className="font-mono">{data.last_ip}</span>
      </nav>
      <PageTitle
        title={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {node ? node.name : <span className="font-mono">{data.last_ip}</span>}
            {node && <span className="font-mono text-[13px] font-normal text-fg-muted">{data.last_ip}</span>}
            <span className="text-[13px] font-normal">
              <TypeBadge type={data.device_type} />
            </span>
            <VirtualBadge platform={data.virtualization} />
            <span className="text-[13px] font-normal">
              <PresenceBadge present={isPresent(data, latestScan?.id)} />
            </span>
          </span>
        }
        actions={
          network && (
            <Button
              onClick={() => collect.mutate()}
              busy={collect.isPending}
              title="Logs in over SSH and runs read-only show commands. Nothing on the device is changed."
            >
              {collect.isPending ? 'Collecting...' : 'Collect from device'}
            </Button>
          )
        }
      />

      {collect.isError && (
        <div className="mb-3">
          <ErrorBox error={collect.error} />
        </div>
      )}
      {collect.isSuccess && (
        <MessageBar tone={collect.data.config_changed ? 'warn' : 'ok'} className="mb-3">
          Collected {Object.keys(collect.data.collected).length} kinds of data. Confirmed as a {collect.data.device_type}.{' '}
          {collect.data.first_backup
            ? "This is the device's first config backup."
            : collect.data.config_changed
              ? `The running config has changed since the last backup (${changeSize(collect.data.config_backup)}).`
              : 'The running config is unchanged since the last backup.'}
          {collect.data.note && <span className="ml-1 text-warn">{collect.data.note}</span>}
        </MessageBar>
      )}

      <div className="space-y-3">
        {network && <FrontPanel device={data} name={node?.name ?? data.last_ip} platform={node?.platform ?? null} />}

        <div className="grid items-start gap-3 lg:grid-cols-3">
          <Card title="Device" className="lg:col-span-2">
            <KeyValueGrid
              columns={2}
              items={[
                ['IP address', <span key="ip" className="font-mono">{data.last_ip}</span>],
                ['MAC address', <span key="mac" className="font-mono">{data.mac}</span>],
                ['Vendor', data.vendor],
                [
                  'Virtualization',
                  data.virtualization ? (
                    <span key="virtual" className="inline-flex flex-wrap items-center gap-2">
                      <VirtualBadge platform={data.virtualization} />
                      <span className="text-xs text-fg-muted">from the MAC prefix</span>
                    </span>
                  ) : (
                    <span key="virtual" className="text-fg-muted">None detected</span>
                  ),
                ],
                ['First seen', <RelativeTime key="first" iso={data.first_seen} />],
                ['Last seen', <RelativeTime key="last" iso={data.last_seen} />],
                ...(node?.platform ? [['Platform', <span key="platform" className="font-mono text-xs">{node.platform}</span>] as [ReactNode, ReactNode]] : []),
                ...(result
                  ? [
                      [
                        'Last scan',
                        <Link key="scan" to={`/scans/${result.scan_id}`} className="text-accent hover:underline">
                          Scan #{result.scan_id}
                        </Link>,
                      ] as [ReactNode, ReactNode],
                    ]
                  : []),
              ]}
            />
          </Card>

          <Card title="Classification">
            <div className="space-y-2 px-3 py-2.5">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <TypeBadge type={data.device_type} />
                {data.type_source === 'collected' ? (
                  <StatusDot status="ok" title="The device reported this itself over an SSH login, so scans no longer change it.">
                    <span className="text-fg-muted">confirmed by login</span>
                  </StatusDot>
                ) : (
                  <StatusDot
                    status="unknown"
                    title="A rule-based guess from service banners and open ports. Whether the device is virtual does not decide the type."
                  >
                    <span className="text-fg-muted">guess from scan</span>
                  </StatusDot>
                )}
              </p>
              <div>
                <FieldLabel>Reason</FieldLabel>
                <p className="mt-0.5 text-fg">{data.type_reason || 'No scan result yet.'}</p>
              </div>
            </div>
          </Card>
        </div>

        <Card title={<>Open ports <span className="tabular font-normal text-fg-muted">{ports.length}</span></>}>
          {ports.length === 0 ? (
            <EmptyState>No open ports among the common ports scanned.</EmptyState>
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
              <tbody>
                {ports.map((port) => (
                  <tr key={`${port.port}/${port.protocol}`}>
                    <Td className="font-mono text-xs font-medium whitespace-nowrap">
                      {port.port}/{port.protocol}
                    </Td>
                    <Td>{port.service || '–'}</Td>
                    <Td>{port.product || '–'}</Td>
                    <Td className="font-mono text-xs">{port.version || '–'}</Td>
                    <Td className="text-xs text-fg-muted">
                      {[port.extra_info, port.os_type && `OS: ${port.os_type}`].filter(Boolean).join(' · ') || '–'}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </TableScroll>
          )}
        </Card>

        {network && <Collected device={data} />}
      </div>
    </>
  )
}

/** Rows of one kind of collected data, or undefined while unknown or never collected. */
function useRows(id: number, kind: CollectedKind, wanted: boolean) {
  const query = useCollected(id, kind, wanted)
  return { rows: wanted && Array.isArray(query.data?.data) ? (query.data.data as CollectedRow[]) : undefined, query }
}

/** The faceplate, built from the interface, VLAN, trunk, CDP, MAC/ARP, STP and OSPF data. */
function FrontPanel({ device, name, platform }: { device: Device; name: string; platform: string | null }) {
  const isSwitch = device.device_type === 'switch'
  const isRouter = device.device_type === 'router'
  const interfaces = useRows(device.id, 'interfaces', true)
  const vlans = useRows(device.id, 'vlans', isSwitch)
  const trunks = useRows(device.id, 'trunks', isSwitch)
  const macTable = useRows(device.id, 'mac-table', isSwitch)
  const stp = useRows(device.id, 'spanning-tree', isSwitch)
  const cdp = useRows(device.id, 'cdp-neighbors', true)
  const arp = useRows(device.id, 'arp', !isSwitch)
  const ospf = useRows(device.id, 'ospf-interfaces', isRouter)
  const panel = useMemo(
    () =>
      interfaces.rows
        ? buildPanel({
            interfaces: interfaces.rows,
            vlans: vlans.rows,
            trunks: trunks.rows,
            cdp: cdp.rows,
            macTable: macTable.rows,
            arp: arp.rows,
            stp: stp.rows,
            ospf: ospf.rows,
          })
        : null,
    [interfaces.rows, vlans.rows, trunks.rows, cdp.rows, macTable.rows, arp.rows, stp.rows, ospf.rows],
  )
  const collectedAt = interfaces.query?.data?.collected_at
  const neverCollected = interfaces.query?.error instanceof ApiError && interfaces.query.error.status === 404

  return (
    <Card
      title="Front panel"
      action={collectedAt && <span className="text-xs text-fg-muted">Collected <RelativeTime iso={collectedAt} /></span>}
    >
      {interfaces.query?.isPending ? (
        <Loading />
      ) : neverCollected ? (
        <EmptyState>No ports to draw yet: collect from the device first.</EmptyState>
      ) : interfaces.query?.isError ? (
        <div className="p-3">
          <ErrorBox error={interfaces.query.error} onRetry={() => void interfaces.query?.refetch()} />
        </div>
      ) : panel && panel.ports.length > 0 ? (
        <Faceplate panel={panel} name={name} platform={platform} />
      ) : (
        <EmptyState>The interface list has no physical ports.</EmptyState>
      )}
    </Card>
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

/** Tabs of collected data and config backups. Only rendered for network devices. */
function Collected({ device }: { device: Device }) {
  const [chosenTab, setTab] = useState<Tab>('interfaces')
  const tabs = tabsFor(device.device_type)
  // The tabs change when a collection confirms the device as a router or switch.
  const tab = tabs.some((item) => item.id === chosenTab) ? chosenTab : 'interfaces'

  return (
    <Card>
      <div className="flex gap-1 overflow-x-auto border-b border-line px-2" role="tablist" aria-label="Collected data">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            className={`-mb-px h-9 border-b-2 px-2.5 whitespace-nowrap transition-colors duration-150 ${
              tab === item.id ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg'
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
    <EmptyState>Nothing has been collected from this device yet. Use "Collect from device" above.</EmptyState>
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
      <div className="p-3">
        <ErrorBox error={collected.error} onRetry={() => void collected.refetch()} />
      </div>
    )
  }
  return (
    <>
      <DataTable data={collected.data.data} />
      <p className="border-t border-line px-3 py-1.5 text-xs text-fg-subtle">
        Collected <RelativeTime iso={collected.data.collected_at} />
        {Array.isArray(collected.data.data) && <span className="tabular"> · {collected.data.data.length} rows</span>}
      </p>
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
      <div className="p-3">
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
    <div className="space-y-3 p-3">
      {latest.changed && (
        <MessageBar
          tone="warn"
          title="Config changed since last backup"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setChosenFrom(backups[1].id)
                setChosenTo(latest.id)
                setMode('compare')
              }}
            >
              Show what changed
            </Button>
          }
        >
          {changeSize(latest)}, collected {formatDateTime(latest.collected_at)}.
        </MessageBar>
      )}

      <div className="grid gap-3 lg:grid-cols-[16rem_1fr]">
        <ul className="divide-y divide-line self-start overflow-hidden rounded border border-line" aria-label="Config backups">
          {backups.map((backup, index) => (
            <li key={backup.id}>
              <button
                type="button"
                onClick={() => {
                  setChosen(backup.id)
                  setMode('view')
                }}
                aria-pressed={mode === 'view' && backup.id === selected}
                className={`w-full border-l-2 px-3 py-2 text-left transition-colors duration-150 ${
                  mode === 'view' && backup.id === selected ? 'border-l-accent bg-raised' : 'border-l-transparent hover:bg-raised'
                }`}
              >
                <span className="flex items-center justify-between gap-2 text-fg">
                  {formatDateTime(backup.collected_at)}
                  {index === 0 && <span className="text-xs text-ok">current</span>}
                </span>
                <span className="mt-1 flex flex-wrap items-center gap-2">
                  {/* Only say what the API actually reported. A missing value
                      (older backend) shows no badge, not a guessed "no change". */}
                  {backup.changed === null && <Badge>first backup</Badge>}
                  {backup.changed === true && <Badge tone="amber">changed {changeSize(backup)}</Badge>}
                  {backup.changed === false && <Badge>no change</Badge>}
                  <span className="font-mono text-xs text-fg-subtle">#{backup.id}</span>
                </span>
                <span className="mt-1 block text-xs text-fg-muted">
                  {backup.lines} lines · unchanged as of {timeAgo(backup.last_seen_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="min-w-0">
          <div className="mb-2 inline-flex rounded border border-line-strong p-px" role="group" aria-label="Config view">
            {(['view', 'compare'] as const).map((item) => (
              <button
                key={item}
                type="button"
                aria-pressed={mode === item}
                onClick={() => setMode(item)}
                className={`rounded-[3px] px-2.5 leading-6 transition-colors duration-150 ${
                  mode === item ? 'bg-raised text-fg' : 'text-fg-muted hover:text-fg'
                }`}
              >
                {item === 'view' ? 'View config' : 'Compare backups'}
              </button>
            ))}
          </div>

          {mode === 'view' ? (
            <ConfigText deviceId={deviceId} backupId={selected} />
          ) : backups.length < 2 ? (
            <p className="rounded border border-line px-3 py-5 text-fg-muted">
              There is only one backup so far. A second one is stored when a collection finds that the config has
              changed.
            </p>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-3">
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
    <label className="flex items-center gap-2">
      <FieldLabel>{label}</FieldLabel>
      <Select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {backups.map((backup) => (
          <option key={backup.id} value={backup.id}>
            #{backup.id} · {formatDateTime(backup.collected_at)}
          </option>
        ))}
      </Select>
    </label>
  )
}

function ConfigText({ deviceId, backupId }: { deviceId: number; backupId: number }) {
  const config = useConfig(deviceId, backupId)

  if (config.isPending) return <Loading label="Loading config..." />
  if (config.isError) return <ErrorBox error={config.error} onRetry={() => void config.refetch()} />
  return <ConfigView text={config.data.config} label="Running config" />
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
      <p className="rounded border border-line px-3 py-5 text-fg-muted">
        {fromId === toId
          ? 'The same backup is selected on both sides.'
          : 'These two backups have the same configuration. Timestamp lines are ignored.'}
      </p>
    )
  }
  return (
    <>
      <p className="mb-2 flex flex-wrap items-center gap-3 text-xs" title="Timestamp lines are ignored and secrets are masked.">
        <span className="tabular font-mono text-ok">+{data.lines_added} added</span>
        <span className="tabular font-mono text-crit">-{data.lines_removed} removed</span>
      </p>
      <DiffView diff={data.diff} />
    </>
  )
}

