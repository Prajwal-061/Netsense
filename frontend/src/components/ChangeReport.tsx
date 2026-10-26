import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ChangeReport, DeviceChange } from '../api'
import type { Status } from './ui'
import { StatusDot, TypeBadge } from './ui'

/** What changed between a scan and the one before it. */
export default function ChangeReportView({ report }: { report: ChangeReport }) {
  if (report.previous_scan_id === null) {
    return <p className="px-3 py-3 text-fg-muted">First scan of this subnet: the starting point for later comparisons.</p>
  }

  const previous = (
    <Link to={`/scans/${report.previous_scan_id}`} className="text-accent hover:underline">
      scan #{report.previous_scan_id}
    </Link>
  )
  const total = report.new_devices.length + report.missing_devices.length + report.ip_changes.length
  if (total === 0) {
    return (
      <p className="px-3 py-3">
        <StatusDot status="ok">
          <span className="text-fg-muted">No changes since {previous}.</span>
        </StatusDot>
      </p>
    )
  }

  return (
    <div>
      <p className="px-3 pt-2 text-xs text-fg-muted">Compared with {previous}</p>
      <div className="grid md:grid-cols-3 md:divide-x md:divide-line">
        <Group label="New devices" count={report.new_devices.length} tone="ok">
          {report.new_devices.map((device) => (
            <DeviceLine key={device.mac} device={device} />
          ))}
        </Group>
        <Group label="No longer seen" count={report.missing_devices.length} tone="crit">
          {report.missing_devices.map((device) => (
            <DeviceLine key={device.mac} device={device} />
          ))}
        </Group>
        <Group label="IP address changed" count={report.ip_changes.length} tone="warn">
          {report.ip_changes.map((change) => (
            <li key={change.mac} className="py-1.5">
              <p className="font-mono text-xs text-fg">
                {change.old_ip} <span className="font-sans text-fg-subtle">to</span> {change.new_ip}
              </p>
              <p className="truncate text-[11px] text-fg-muted">
                <span className="font-mono">{change.mac}</span> · {change.vendor}
              </p>
            </li>
          ))}
        </Group>
      </div>
    </div>
  )
}

function Group({ label, count, tone, children }: { label: string; count: number; tone: Status; children: ReactNode }) {
  const active = count > 0
  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium tracking-wide text-fg-muted uppercase">
          <StatusDot status={active ? tone : 'unknown'}>{label}</StatusDot>
        </h3>
        <span className={`tabular text-xs ${active ? 'text-fg' : 'text-fg-subtle'}`}>{count}</span>
      </div>
      {active ? <ul className="mt-1 divide-y divide-line">{children}</ul> : <p className="mt-1 text-xs text-fg-subtle">None</p>}
    </div>
  )
}

function DeviceLine({ device }: { device: DeviceChange }) {
  return (
    <li className="py-1.5">
      <p className="flex flex-wrap items-center gap-x-2">
        <span className="font-mono text-xs text-fg">{device.ip}</span>
        <span className="text-xs text-fg-muted">
          <TypeBadge type={device.type} />
        </span>
      </p>
      <p className="truncate text-[11px] text-fg-muted">
        <span className="font-mono">{device.mac}</span> · {device.vendor}
      </p>
    </li>
  )
}
