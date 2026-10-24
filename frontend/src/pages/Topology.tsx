import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError } from '../api'
import { Card, EmptyState, ErrorBox, Loading, PageTitle } from '../components/ui'
import { formatDateTime, timeAgo } from '../format'
import { useCollections, useTopology } from '../queries'
import { KindIcon } from '../topology/DeviceNode'
import { summarise } from '../topology/flow'
import TopologyMap from '../topology/TopologyMap'

export default function TopologyPage() {
  const runs = useCollections()
  const [collectionId, setCollectionId] = useState<number>()
  const [vlan, setVlan] = useState<number>()
  const [showManagement, setShowManagement] = useState(false)
  const topology = useTopology(collectionId)
  const options = useMemo(() => ({ vlan, showManagement }), [vlan, showManagement])

  const finished = (runs.data ?? []).filter((run) => run.status !== 'running')
  const noCollection = topology.error instanceof ApiError && topology.error.status === 404

  return (
    <>
      <PageTitle
        title="Topology"
        subtitle="Built from what the devices report: links from CDP, hosts from switch MAC tables."
      />
      <Card>
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3 border-b border-slate-200 p-3">
          <label className="text-xs font-medium text-slate-600">
            Collection
            <select
              value={collectionId ?? ''}
              onChange={(event) => setCollectionId(event.target.value ? Number(event.target.value) : undefined)}
              className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            >
              <option value="">Latest</option>
              {finished.map((run) => (
                <option key={run.id} value={run.id}>
                  #{run.id} · {formatDateTime(run.started_at)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Highlight VLAN
            <select
              value={vlan ?? ''}
              onChange={(event) => setVlan(event.target.value ? Number(event.target.value) : undefined)}
              className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
            >
              <option value="">All VLANs</option>
              {(topology.data?.vlans ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  VLAN {item.id}
                  {item.name ? ` ${item.name}` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 pb-1.5 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={showManagement}
              onChange={(event) => setShowManagement(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Show management network
          </label>
          {topology.data && (
            <p className="ml-auto pb-1.5 text-xs text-slate-500">
              Collection #{topology.data.collection_id}, {timeAgo(topology.data.collected_at)}
            </p>
          )}
        </div>

        {topology.isPending ? (
          <Loading label="Loading topology..." />
        ) : noCollection ? (
          <EmptyState>
            There is no topology yet: it is built from a collection.{' '}
            <Link to="/collections" className="font-medium text-blue-700 hover:underline">
              Collect from all devices
            </Link>{' '}
            first.
          </EmptyState>
        ) : topology.isError ? (
          <div className="p-4">
            <ErrorBox error={topology.error} onRetry={() => void topology.refetch()} />
          </div>
        ) : topology.data.nodes.length === 0 ? (
          <EmptyState>This collection reached no devices, so there is nothing to draw.</EmptyState>
        ) : (
          <>
            <p className="px-4 pt-3 text-sm text-slate-700">{summarise(topology.data)}</p>
            {vlan !== undefined && (
              <p className="px-4 pt-1 text-xs text-blue-800">
                Links and devices carrying VLAN {vlan} are highlighted. A dashed blue link carries it but
                spanning tree blocks it there.
              </p>
            )}
            {/* Tall enough to read, short enough for a laptop screen. */}
            <TopologyMap topology={topology.data} options={options} />
            <Legend />
            {topology.data.unplaced_hosts.length > 0 && (
              <div className="border-t border-slate-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
                <p className="font-semibold">Known hosts that could not be placed on the map</p>
                <ul className="mt-1 space-y-0.5">
                  {topology.data.unplaced_hosts.map((host) => (
                    <li key={host.mac}>
                      <span className="font-mono">{host.ip}</span> (<span className="font-mono">{host.mac}</span>
                      {host.vendor ? `, ${host.vendor}` : ''}), in the ARP table of{' '}
                      {topology.data.nodes.find((node) => node.id === host.seen_by)?.name ?? host.seen_by} on{' '}
                      <span className="font-mono">{host.interface}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-xs text-amber-800">
                  A switch forgets a MAC address after about five minutes without traffic, so a quiet host is
                  in no MAC table and its port is not known. It appears on the map when it has sent traffic
                  shortly before a collection.
                </p>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  )
}

export function Legend({ showChanged = false }: { showChanged?: boolean }) {
  const line = (colour: string, dash?: string, width = 2) => (
    <svg width="34" height="8" aria-hidden="true">
      <line x1="1" y1="4" x2="33" y2="4" stroke={colour} strokeWidth={width} strokeDasharray={dash} />
    </svg>
  )
  const item = (symbol: React.ReactNode, text: string) => (
    <li className="flex items-center gap-1.5 whitespace-nowrap">
      {symbol}
      {text}
    </li>
  )
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-slate-200 px-4 py-2.5 text-xs text-slate-600" aria-label="Legend">
      {item(<KindIcon kind="router" className="h-4 w-4 text-indigo-700" />, 'Router')}
      {item(<KindIcon kind="switch" className="h-4 w-4 text-blue-700" />, 'Switch')}
      {item(<KindIcon kind="host" className="h-4 w-4 text-slate-600" />, 'Host')}
      {item(<KindIcon kind="unknown" className="h-4 w-4 text-amber-700" />, 'Unknown neighbour')}
      {item(line('#64748b'), 'Link')}
      {item(line('#64748b', '7 6'), 'Blocked by spanning tree')}
      {item(line('#dc2626'), 'Down')}
      {item(line('#7c3aed', undefined, 3), 'OSPF neighbours')}
      {item(line('#94a3b8', '2 5', 1.5), 'Management')}
      {showChanged && item(line('#ea580c', undefined, 3.5), 'Changed since the baseline')}
      <li className="text-slate-500">Point at a link for details. Click a device to open it. Drag to rearrange.</li>
    </ul>
  )
}
