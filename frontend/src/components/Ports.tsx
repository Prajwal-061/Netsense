import type { Port } from '../api'

/** Open ports as compact chips: "22/tcp ssh". */
export function PortChips({ ports, wrap = true }: { ports: Port[]; wrap?: boolean }) {
  if (ports.length === 0) return <span className="text-fg-subtle">None</span>
  return (
    <span className={`flex gap-1 ${wrap ? 'flex-wrap' : ''}`}>
      {ports.map((port) => (
        <span
          key={`${port.port}/${port.protocol}`}
          className="rounded-[2px] bg-raised px-1.5 font-mono text-[11.5px] leading-5 whitespace-nowrap text-fg"
          title={[port.product, port.version].filter(Boolean).join(' ') || undefined}
        >
          {port.port}
          <span className="text-fg-subtle">/{port.protocol}</span>
          {port.service && <span className="text-fg-muted"> {port.service}</span>}
        </span>
      ))}
    </span>
  )
}
