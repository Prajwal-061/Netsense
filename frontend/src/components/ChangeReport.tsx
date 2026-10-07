import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ChangeReport, DeviceChange } from '../api'
import { TypeBadge } from './ui'

/** What changed between a scan and the one before it. */
export default function ChangeReportView({ report }: { report: ChangeReport }) {
  if (report.previous_scan_id === null) {
    return (
      <p className="px-4 py-4 text-sm text-slate-600">
        This was the first scan of this subnet, so it is the baseline. Changes are reported from
        the next scan onwards.
      </p>
    )
  }

  const previous = (
    <Link to={`/scans/${report.previous_scan_id}`} className="font-medium text-blue-700 hover:underline">
      scan #{report.previous_scan_id}
    </Link>
  )
  const total =
    report.new_devices.length + report.missing_devices.length + report.ip_changes.length
  if (total === 0) {
    return (
      <p className="flex items-center gap-2 px-4 py-4 text-sm text-emerald-800">
        <span className="h-2 w-2 rounded-full bg-emerald-500" />
        <span>No changes since {previous}.</span>
      </p>
    )
  }

  return (
    <div>
      <p className="px-4 pt-3 text-xs text-slate-500">Compared with {previous}</p>
      <div className="grid gap-3 p-4 md:grid-cols-3">
        <Group label="New devices" count={report.new_devices.length} tone="green">
          {report.new_devices.map((device) => (
            <DeviceLine key={device.mac} device={device} />
          ))}
        </Group>
        <Group label="No longer seen" count={report.missing_devices.length} tone="red">
          {report.missing_devices.map((device) => (
            <DeviceLine key={device.mac} device={device} />
          ))}
        </Group>
        <Group label="IP address changed" count={report.ip_changes.length} tone="amber">
          {report.ip_changes.map((change) => (
            <li key={change.mac} className="py-2">
              <p className="font-mono text-sm">
                {change.old_ip} <span className="text-slate-400">to</span> {change.new_ip}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                <span className="font-mono">{change.mac}</span> · {change.vendor}
              </p>
            </li>
          ))}
        </Group>
      </div>
    </div>
  )
}

const GROUP_TONES = {
  green: { box: 'border-emerald-200 bg-emerald-50/60', count: 'bg-emerald-600' },
  red: { box: 'border-red-200 bg-red-50/60', count: 'bg-red-600' },
  amber: { box: 'border-amber-200 bg-amber-50/60', count: 'bg-amber-500' },
}

function Group({
  label,
  count,
  tone,
  children,
}: {
  label: string
  count: number
  tone: keyof typeof GROUP_TONES
  children: ReactNode
}) {
  const active = count > 0
  return (
    <div className={`rounded-lg border p-3 ${active ? GROUP_TONES[tone].box : 'border-slate-200 bg-slate-50'}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">{label}</h3>
        <span
          className={`min-w-6 rounded-full px-2 py-0.5 text-center text-xs font-semibold text-white ${
            active ? GROUP_TONES[tone].count : 'bg-slate-400'
          }`}
        >
          {count}
        </span>
      </div>
      {active ? (
        <ul className="mt-1 divide-y divide-slate-200/70">{children}</ul>
      ) : (
        <p className="mt-2 text-xs text-slate-500">None</p>
      )}
    </div>
  )
}

function DeviceLine({ device }: { device: DeviceChange }) {
  return (
    <li className="py-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{device.ip}</span>
        <TypeBadge type={device.type} />
      </p>
      <p className="mt-0.5 text-xs text-slate-500">
        <span className="font-mono">{device.mac}</span> · {device.vendor}
      </p>
    </li>
  )
}
