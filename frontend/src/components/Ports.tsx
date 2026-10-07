import type { Port } from '../api'

/** Open ports as compact chips: "22/tcp ssh". */
export function PortChips({ ports }: { ports: Port[] }) {
  if (ports.length === 0) return <span className="text-slate-400">None</span>
  return (
    <span className="flex flex-wrap gap-1">
      {ports.map((port) => (
        <span
          key={`${port.port}/${port.protocol}`}
          className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-slate-700"
          title={[port.product, port.version].filter(Boolean).join(' ') || undefined}
        >
          {port.port}/{port.protocol}
          {port.service && <span className="text-slate-500"> {port.service}</span>}
        </span>
      ))}
    </span>
  )
}
