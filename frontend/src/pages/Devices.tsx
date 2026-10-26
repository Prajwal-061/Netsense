import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Device } from '../api'
import { useSort } from '../components/controls'
import { PortChips } from '../components/Ports'
import {
  EmptyState,
  ErrorBox,
  FieldLabel,
  PageTitle,
  PresenceBadge,
  RelativeTime,
  Select,
  SkeletonRows,
  TableScroll,
  Td,
  TextInput,
  Th,
  TypeBadge,
  VirtualBadge,
} from '../components/ui'
import { ipSortKey, parseTime } from '../format'
import { isPresent, useDevices, useLatestCompletedScan, useTopology } from '../queries'

type Column = 'ip' | 'name' | 'status' | 'type' | 'mac' | 'vendor' | 'seen'

export default function Devices() {
  const devices = useDevices()
  const latestScan = useLatestCompletedScan()
  const topology = useTopology()
  // Hostnames are only known for devices NetSense has logged in to.
  const names = useMemo(
    () => new Map((topology.data?.nodes ?? []).filter((node) => node.device_id !== null).map((node) => [node.device_id!, node.name])),
    [topology.data],
  )
  const sort = useSort<Column>('ip')
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
  const up = (device: Device) => isPresent(device, latestScan?.id)
  const shown = sort.apply(
    all.filter((device) => !type || device.device_type === type).filter((device) => matches(device, search, names.get(device.id))),
    {
      ip: (device) => ipSortKey(device.last_ip),
      name: (device) => names.get(device.id) ?? '~',
      status: (device) => (up(device) ? 0 : 1),
      type: (device) => device.device_type,
      mac: (device) => device.mac,
      vendor: (device) => device.vendor,
      seen: (device) => parseTime(device.last_seen),
    },
  )
  const upCount = all.filter(up).length

  return (
    <>
      <PageTitle
        title="Devices"
        subtitle={
          devices.data && (
            <span className="tabular">
              {all.length} known · {upCount} up in the last scan
            </span>
          )
        }
      />
      <section className="overflow-hidden rounded border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-3 py-2">
          <label className="min-w-48 flex-1 sm:max-w-sm">
            <span className="sr-only">Search devices</span>
            <TextInput
              type="search"
              value={search}
              onChange={(event) => setParam('q', event.target.value)}
              placeholder="Search IP, name, MAC, vendor, service"
              className="w-full"
            />
          </label>
          <label className="flex items-center gap-2">
            <FieldLabel>Type</FieldLabel>
            <Select value={type} onChange={(event) => setParam('type', event.target.value)}>
              <option value="">All types</option>
              {types.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </label>
          <p className="tabular ml-auto text-xs text-fg-muted">
            {shown.length} of {all.length}
          </p>
        </div>

        {devices.isPending ? (
          <SkeletonRows rows={8} label="Loading devices..." />
        ) : devices.isError ? (
          <div className="p-3">
            <ErrorBox error={devices.error} onRetry={() => void devices.refetch()} />
          </div>
        ) : all.length === 0 ? (
          <EmptyState>
            No devices yet.{' '}
            <Link to="/" className="text-link hover:underline">
              Start a scan
            </Link>
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState>No devices match the search and filter.</EmptyState>
        ) : (
          <TableScroll maxHeight="max-h-[calc(100vh-170px)]">
            <thead>
              <tr>
                <Th sort={sort.sortBy('ip')}>IP address</Th>
                <Th sort={sort.sortBy('name')}>Name</Th>
                <Th sort={sort.sortBy('status')}>Status</Th>
                <Th sort={sort.sortBy('type')}>Type</Th>
                <Th>Open ports</Th>
                <Th sort={sort.sortBy('mac')}>MAC address</Th>
                <Th sort={sort.sortBy('vendor')}>Vendor</Th>
                <Th sort={sort.sortBy('seen')} className="text-right">
                  Last seen
                </Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((device) => (
                <tr key={device.id}>
                  <Td>
                    <Link to={`/devices/${device.id}`} className="font-mono text-[12.5px] text-link hover:underline">
                      {device.last_ip}
                    </Link>
                  </Td>
                  <Td className="font-medium whitespace-nowrap">{names.get(device.id) ?? <span className="text-fg-subtle">–</span>}</Td>
                  <Td>
                    <PresenceBadge present={up(device)} />
                  </Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <TypeBadge type={device.device_type} />
                      <VirtualBadge platform={device.virtualization} />
                    </span>
                  </Td>
                  <Td>
                    <PortChips ports={device.latest_result?.open_ports ?? []} wrap={false} />
                  </Td>
                  <Td className="font-mono text-xs whitespace-nowrap text-fg-muted">{device.mac}</Td>
                  <Td className="max-w-36 truncate text-fg-muted">
                    <span title={device.vendor}>{device.vendor}</span>
                  </Td>
                  <Td className="text-right whitespace-nowrap text-fg-muted">
                    <RelativeTime iso={device.last_seen} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </section>
    </>
  )
}

/** Case-insensitive match on everything a person might type to find a device. */
function matches(device: Device, search: string, name: string | undefined): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  const ports = device.latest_result?.open_ports ?? []
  return [
    name ?? '',
    device.last_ip,
    device.mac,
    device.vendor,
    device.device_type,
    device.virtualization ?? '',
    ...ports.flatMap((port) => [String(port.port), port.service, port.product]),
  ].some((text) => text.toLowerCase().includes(needle))
}
