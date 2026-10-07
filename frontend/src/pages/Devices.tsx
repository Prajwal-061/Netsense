import { Link, useSearchParams } from 'react-router-dom'
import type { Device } from '../api'
import { PortChips } from '../components/Ports'
import {
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
import { formatDateTime, ipSortKey, timeAgo } from '../format'
import { isPresent, useDevices, useLatestCompletedScan } from '../queries'

export default function Devices() {
  const devices = useDevices()
  const latestScan = useLatestCompletedScan()
  // The search text and type filter live in the URL (?q=...&type=...), so a
  // filtered view can be bookmarked and survives a page reload.
  const [params, setParams] = useSearchParams()
  const search = params.get('q') ?? ''
  const type = params.get('type') ?? ''

  function setParam(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    setParams(next, { replace: true })
  }

  const all = devices.data ?? []
  const types = [...new Set(all.map((device) => device.device_type))].sort()
  const shown = all
    .filter((device) => !type || device.device_type === type)
    .filter((device) => matches(device, search))
    .sort((a, b) => ipSortKey(a.last_ip) - ipSortKey(b.last_ip))

  return (
    <>
      <PageTitle title="Devices" subtitle="Every device seen on the network, identified by MAC address." />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-3">
          <label className="min-w-48 flex-1">
            <span className="sr-only">Search devices</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setParam('q', event.target.value)}
              placeholder="Search IP, MAC, vendor or service"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Type
            <select
              value={type}
              onChange={(event) => setParam('type', event.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="">All types</option>
              {types.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm text-slate-500 tabular-nums">
            {shown.length} of {all.length}
          </p>
        </div>

        {devices.isPending ? (
          <Loading label="Loading devices..." />
        ) : devices.isError ? (
          <div className="p-4">
            <ErrorBox error={devices.error} onRetry={() => void devices.refetch()} />
          </div>
        ) : all.length === 0 ? (
          <EmptyState>
            No devices yet. <Link to="/" className="font-medium text-blue-700 hover:underline">Start a scan</Link>{' '}
            to discover the network.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState>No devices match the search and filter.</EmptyState>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>IP address</Th>
                <Th>Status</Th>
                <Th>Type</Th>
                <Th>Open ports</Th>
                <Th>MAC address</Th>
                <Th>Vendor</Th>
                <Th>Last seen</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map((device) => (
                <tr key={device.id} className="hover:bg-slate-50">
                  <Td>
                    <Link to={`/devices/${device.id}`} className="font-mono font-medium text-blue-700 hover:underline">
                      {device.last_ip}
                    </Link>
                  </Td>
                  <Td>
                    <PresenceBadge present={isPresent(device, latestScan?.id)} />
                  </Td>
                  <Td>
                    <TypeBadge type={device.device_type} />
                  </Td>
                  <Td>
                    <PortChips ports={device.latest_result?.open_ports ?? []} />
                  </Td>
                  <Td className="font-mono text-xs whitespace-nowrap text-slate-700">{device.mac}</Td>
                  <Td className="text-slate-700">{device.vendor}</Td>
                  <Td className="whitespace-nowrap text-slate-700">
                    <span title={formatDateTime(device.last_seen)}>{timeAgo(device.last_seen)}</span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Card>
    </>
  )
}

/** Case-insensitive match on everything a person might type to find a device. */
function matches(device: Device, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  const ports = device.latest_result?.open_ports ?? []
  return [
    device.last_ip,
    device.mac,
    device.vendor,
    device.device_type,
    ...ports.flatMap((port) => [String(port.port), port.service, port.product]),
  ].some((text) => text.toLowerCase().includes(needle))
}
