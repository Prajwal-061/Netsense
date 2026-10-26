import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api'
import type { DriftFinding, Topology, TopologyLink, TopologyNode } from '../api'
import { EmptyState, ErrorBox, FieldLabel, KeyValueGrid, RelativeTime, Select, SeverityBadge, SkeletonRows, StatusDot } from '../components/ui'
import { formatDateTime } from '../format'
import { deviceHealth, nodeHealth } from '../health'
import type { Health } from '../health'
import { useCollections, useLatestDriftReport, useTopology } from '../queries'
import { KindIcon } from '../topology/DeviceNode'
import { COLOURS, summarise } from '../topology/flow'
import TopologyMap from '../topology/TopologyMap'

const HEALTH_LABEL: Record<Health, string> = { ok: 'Healthy', warn: 'Warnings', crit: 'Critical' }

export default function TopologyPage() {
  const runs = useCollections()
  const [collectionId, setCollectionId] = useState<number>()
  const [vlan, setVlan] = useState<number>()
  const [showManagement, setShowManagement] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const topology = useTopology(collectionId)
  const drift = useLatestDriftReport()
  const health = useMemo(() => nodeHealth(drift.report), [drift.report])
  const options = useMemo(() => ({ vlan, showManagement, health, selected }), [vlan, showManagement, health, selected])

  const finished = (runs.data ?? []).filter((run) => run.status !== 'running')
  const noCollection = topology.error instanceof ApiError && topology.error.status === 404
  const selectedNode = topology.data?.nodes.find((node) => node.id === selected)

  return (
    // The map takes the whole content area: undo the page padding of <main>.
    <div className="-mx-4 -my-3 flex h-[calc(100%+24px)] min-h-[520px] flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface px-4 py-2">
        <h1 className="text-[15px] leading-[22px] font-semibold text-fg">Topology</h1>
        <label className="flex items-center gap-2">
          <FieldLabel>Collection</FieldLabel>
          <Select
            value={collectionId ?? ''}
            onChange={(event) => {
              setCollectionId(event.target.value ? Number(event.target.value) : undefined)
              setSelected(null)
            }}
          >
            <option value="">Latest</option>
            {finished.map((run) => (
              <option key={run.id} value={run.id}>
                #{run.id} · {formatDateTime(run.started_at)}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2">
          <FieldLabel>Highlight VLAN</FieldLabel>
          <Select value={vlan ?? ''} onChange={(event) => setVlan(event.target.value ? Number(event.target.value) : undefined)}>
            <option value="">All VLANs</option>
            {(topology.data?.vlans ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                VLAN {item.id}
                {item.name ? ` ${item.name}` : ''}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex items-center gap-2 text-fg-muted">
          <input
            type="checkbox"
            checked={showManagement}
            onChange={(event) => setShowManagement(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--ns-accent)]"
          />
          Show management network
        </label>
        {topology.data && (
          <p className="text-fg-muted lg:ml-auto">
            <span className="tabular">{summarise(topology.data)}</span>
            <span className="text-fg-subtle">
              {' · '}Collection #{topology.data.collection_id}, <RelativeTime iso={topology.data.collected_at} />
            </span>
          </p>
        )}
      </div>

      {topology.isPending ? (
        <SkeletonRows label="Loading topology..." />
      ) : noCollection ? (
        <EmptyState>
          There is no topology yet.{' '}
          <Link to="/collections" className="text-accent hover:underline">
            Collect from all devices
          </Link>
        </EmptyState>
      ) : topology.isError ? (
        <div className="p-4">
          <ErrorBox error={topology.error} onRetry={() => void topology.refetch()} />
        </div>
      ) : topology.data.nodes.length === 0 ? (
        <EmptyState>This collection reached no devices, so there is nothing to draw.</EmptyState>
      ) : (
        <>
          <div className="relative min-h-0 flex-1">
            <TopologyMap topology={topology.data} options={options} className="absolute inset-0" onSelect={setSelected} />
            {vlan !== undefined && (
              <p className="pointer-events-none absolute top-3 left-3 rounded border border-accent/40 bg-surface px-2 py-1 text-xs text-fg-muted shadow-float">
                Links and devices carrying VLAN {vlan} are highlighted
              </p>
            )}
            {selectedNode && (
              <NodePanel
                node={selectedNode}
                topology={topology.data}
                findings={drift.report?.findings.filter((finding) => finding.device.toLowerCase() === selectedNode.name.toLowerCase()) ?? []}
                score={drift.report ? deviceHealth(drift.report).find((item) => item.name.toLowerCase() === selectedNode.name.toLowerCase())?.score : undefined}
                health={health[selectedNode.id]}
                onClose={() => setSelected(null)}
              />
            )}
          </div>
          {topology.data.unplaced_hosts.length > 0 && <UnplacedHosts topology={topology.data} />}
          <Legend showHealth={Object.keys(health).length > 0} className="border-t border-line bg-surface max-md:hidden" />
        </>
      )}
    </div>
  )
}

/** Details of the clicked node: facts, health from the latest drift check, and its links. */
function NodePanel({
  node,
  topology,
  findings,
  score,
  health,
  onClose,
}: {
  node: TopologyNode
  topology: Topology
  findings: DriftFinding[]
  score: number | undefined
  health: Health | undefined
  onClose: () => void
}) {
  const names = new Map(topology.nodes.map((item) => [item.id, item.name]))
  const links = topology.links
    .filter((link) => link.a.node === node.id || link.b.node === node.id)
    .map((link) => {
      const [near, far] = link.a.node === node.id ? [link.a, link.b] : [link.b, link.a]
      return { link, local: near.interface, remote: far.interface, neighbour: names.get(far.node) ?? far.node }
    })
    .sort((x, y) => (x.local ?? '').localeCompare(y.local ?? '', undefined, { numeric: true }))
  const facts: [ReactNode, ReactNode][] = [
    ['Type', <span key="type" className="capitalize">{node.kind === 'unknown' ? 'Unknown neighbour' : node.kind}</span>],
    ['IP', node.ip ? <span key="ip" className="font-mono">{node.ip}</span> : '–'],
    ['MAC', node.mac ? <span key="mac" className="font-mono">{node.mac}</span> : '–'],
  ]
  if (node.platform) facts.push(['Platform', <span key="platform" className="font-mono">{node.platform}</span>])
  if (node.vendor) facts.push(['Vendor', node.vendor])
  if (node.virtualization) facts.push(['Virtual', node.virtualization])
  if (node.kind === 'router' || node.kind === 'switch')
    facts.push(['This run', node.collected ? <StatusDot key="run" status="ok">Collected</StatusDot> : <StatusDot key="run" status="crit">Not reached</StatusDot>])

  return (
    <aside
      aria-label={`${node.name} details`}
      className="absolute z-10 flex flex-col overflow-hidden border border-line bg-surface shadow-float max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[60%] max-md:rounded-t md:top-3 md:right-3 md:bottom-3 md:w-80 md:rounded"
    >
      <header className="flex items-center gap-2.5 border-b border-line px-3 py-2">
        <KindIcon kind={node.kind} className="h-6 w-6 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-fg">{node.name}</h2>
          {health && (
            <p className="text-xs">
              <StatusDot status={health}>
                {HEALTH_LABEL[health]}
                {score !== undefined && <span className="tabular text-fg-muted"> · score {score}</span>}
              </StatusDot>
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="rounded p-1 text-fg-muted transition-colors hover:bg-raised hover:text-fg"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <KeyValueGrid items={facts} columns={1} />
        {findings.length > 0 && (
          <section className="border-t border-line">
            <h3 className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-fg-muted uppercase">
              Findings since the baseline
            </h3>
            <ul className="pb-2">
              {findings.slice(0, 6).map((finding) => (
                <li key={finding.id} className="flex items-start gap-2 px-3 py-1">
                  <SeverityBadge severity={finding.severity} />
                  <span className="min-w-0 text-xs leading-5 text-fg">{finding.message}</span>
                </li>
              ))}
              {findings.length > 6 && <li className="px-3 py-1 text-xs text-fg-muted">and {findings.length - 6} more</li>}
            </ul>
          </section>
        )}
        {links.length > 0 && (
          <section className="border-t border-line">
            <h3 className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-fg-muted uppercase">Links</h3>
            <ul className="pb-2">
              {links.map(({ link, local, remote, neighbour }) => (
                <li key={link.id} className="flex items-center gap-2 px-3 py-1 text-xs">
                  <StatusDot status={link.status === 'up' ? 'ok' : link.status === 'down' ? 'crit' : 'unknown'} title={`Link ${link.status}`} />
                  <span className="w-14 shrink-0 font-mono text-fg">{local ?? '–'}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-muted">
                    {neighbour}
                    {remote && <span className="font-mono"> {remote}</span>}
                  </span>
                  <LinkTag link={link} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {node.device_id !== null && (
        <footer className="border-t border-line px-3 py-2">
          <Link to={`/devices/${node.device_id}`} className="text-accent hover:underline">
            Open device page
          </Link>
        </footer>
      )}
    </aside>
  )
}

function LinkTag({ link }: { link: TopologyLink }) {
  const tag = link.stp_blocked ? 'STP blocked' : link.ospf ? 'OSPF' : link.mode === 'trunk' ? 'trunk' : link.mode === 'access' ? 'access' : null
  if (!tag) return null
  return (
    <span className={`shrink-0 rounded-sm border px-1 text-[10px] leading-[14px] ${link.stp_blocked ? 'border-warn/50 text-warn' : 'border-line-strong text-fg-muted'}`}>
      {tag}
    </span>
  )
}

/** Hosts in a router's ARP table that no switch's MAC table places. */
function UnplacedHosts({ topology }: { topology: Topology }) {
  return (
    <div className="max-h-32 overflow-auto border-t border-l-[3px] border-line border-l-warn bg-surface px-3 py-1.5 text-xs">
      <p
        className="font-medium text-fg"
        title="A switch forgets a MAC address after about five minutes without traffic, so a quiet host is in no MAC table and its port is not known. It appears on the map when it has sent traffic shortly before a collection."
      >
        Known hosts that could not be placed on the map
      </p>
      <ul className="text-fg-muted">
        {topology.unplaced_hosts.map((host) => (
          <li key={host.mac}>
            <span className="font-mono text-fg">{host.ip}</span> (<span className="font-mono">{host.mac}</span>
            {host.vendor ? `, ${host.vendor}` : ''}), in the ARP table of{' '}
            {topology.nodes.find((node) => node.id === host.seen_by)?.name ?? host.seen_by} on{' '}
            <span className="font-mono">{host.interface}</span>
          </li>
        ))}
      </ul>
      <p className="sr-only">
        A switch forgets a MAC address after about five minutes without traffic, so a quiet host is in no MAC table.
      </p>
    </div>
  )
}

export function Legend({
  showChanged = false,
  showHealth = false,
  className = '',
}: {
  showChanged?: boolean
  showHealth?: boolean
  className?: string
}) {
  const line = (colour: string, dash?: string, width = 1.5, opacity = 1) => (
    <svg width="26" height="8" aria-hidden="true" className="shrink-0">
      <line x1="1" y1="4" x2="25" y2="4" stroke={colour} strokeWidth={width} strokeDasharray={dash} opacity={opacity} />
    </svg>
  )
  const dot = (colour: string) => <span className="mx-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colour }} />
  const item = (symbol: ReactNode, text: string) => (
    <li className="flex items-center gap-1.5 whitespace-nowrap">
      {symbol}
      {text}
    </li>
  )
  return (
    <ul
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 text-[11px] text-fg-muted ${className}`}
      aria-label="Legend"
      title="Point at a link for details. Click a device for its details. Drag to rearrange."
    >
      {item(<KindIcon kind="router" className="h-4 w-4 text-accent" />, 'Router')}
      {item(<KindIcon kind="switch" className="h-4 w-4 text-accent" />, 'Switch')}
      {item(<KindIcon kind="host" className="h-4 w-4 text-fg-muted" />, 'Host')}
      {item(<KindIcon kind="unknown" className="h-4 w-4 text-fg-subtle" />, 'Unknown neighbour')}
      {showHealth && item(dot('var(--ns-ok)'), 'Healthy')}
      {showHealth && item(dot('var(--ns-warn)'), 'Warnings')}
      {showHealth && item(dot('var(--ns-crit)'), 'Critical findings')}
      {item(line(COLOURS.normal), 'Link')}
      {item(line(COLOURS.normal, '6 5', 1.5, 0.45), 'Blocked by spanning tree')}
      {item(line(COLOURS.down), 'Down')}
      {item(line(COLOURS.ospf, undefined, 2.25), 'OSPF neighbours')}
      {item(line(COLOURS.management, '2 5'), 'Management')}
      {showChanged && item(line(COLOURS.changed, undefined, 2.5), 'Changed since the baseline')}
    </ul>
  )
}
