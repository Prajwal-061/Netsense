import { useState } from 'react'
import type { Panel, Port } from '../faceplate'
import { describePort } from '../faceplate'

const JACK: Record<Port['state'], string> = {
  up: 'border-ok/70 bg-ok-soft text-ok-fg',
  down: 'border-crit/70 bg-crit-soft text-crit-fg',
  'admin-down': 'border-dashed border-line-strong bg-canvas text-fg-subtle',
}

/** The link LED above a port: green when up, amber when spanning tree blocks it, off otherwise. */
function ledClass(port: Port): string {
  if (port.state !== 'up') return 'bg-line-strong'
  return port.blocking ? 'bg-warn shadow-[0_0_6px_var(--ns-warn)]' : 'bg-ok shadow-[0_0_6px_var(--ns-ok)]'
}

/**
 * The front panel of a router or switch: one jack per physical port,
 * coloured by state, with the access VLAN, "T" (trunk) or "L3" (routed) on
 * it. Pointing at a port (or tabbing to it) shows what is known about it.
 */
export default function Faceplate({ panel, name, platform }: { panel: Panel; name: string; platform: string | null }) {
  const [hover, setHover] = useState<{ port: Port; x: number; y: number } | null>(null)
  const slots = [...new Set(panel.ports.map((port) => port.slot))]
  const show = (port: Port, element: HTMLElement) => {
    const box = element.getBoundingClientRect()
    setHover({ port, x: box.left + box.width / 2, y: box.bottom + 6 })
  }

  return (
    <div>
      <div className="overflow-x-auto p-3">
        <div
          role="group"
          aria-label={`${name} front panel`}
          className="inline-flex min-w-full items-stretch gap-4 rounded-md border border-line-strong bg-raised px-2 py-3 shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]"
        >
          <Ear />
          <div className="hidden w-32 shrink-0 flex-col justify-between border-r border-line pr-4 sm:flex">
            <div>
              <p className="font-semibold tracking-wide text-fg">{name}</p>
              {platform && <p className="truncate font-mono text-[10px] text-fg-muted">{platform}</p>}
            </div>
            <p className="flex items-center gap-1.5 font-mono text-[9px] tracking-widest text-fg-subtle">
              <span className="h-1.5 w-1.5 rounded-full bg-ok shadow-[0_0_6px_var(--ns-ok)]" aria-hidden="true" />
              SYS
            </p>
          </div>
          <div className="flex flex-1 flex-wrap items-end gap-x-6 gap-y-3">
            {slots.map((slot) => (
              <div key={slot}>
                <p className="mb-1 font-mono text-[9px] tracking-widest text-fg-subtle uppercase">Slot {slot}</p>
                <div className="flex gap-2">
                  {panel.ports
                    .filter((port) => port.slot === slot)
                    .map((port) => (
                      <button
                        key={port.name}
                        type="button"
                        data-port={port.name}
                        data-state={port.state}
                        aria-label={`${port.fullName}: ${describePort(port)
                          .map(([key, value]) => `${key} ${value}`)
                          .join(', ')}`}
                        onMouseEnter={(event) => show(port, event.currentTarget)}
                        onMouseLeave={() => setHover(null)}
                        onFocus={(event) => show(port, event.currentTarget)}
                        onBlur={() => setHover(null)}
                        className="group flex flex-col items-center gap-1 rounded-[3px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        <span aria-hidden="true" className={`h-1 w-3 rounded-full transition-colors duration-300 ${ledClass(port)}`} />
                        <span
                          aria-hidden="true"
                          className={`relative flex h-9 w-11 items-center justify-center rounded-[3px] border font-mono text-[11px] font-medium transition-transform duration-150 group-hover:-translate-y-px ${JACK[port.state]}`}
                        >
                          {port.label}
                          {/* The latch slot of an RJ45 jack. */}
                          <span className="absolute -bottom-px left-1/2 h-1.5 w-4 -translate-x-1/2 rounded-t-[2px] border border-b-0 border-inherit bg-raised" />
                        </span>
                        <span aria-hidden="true" className="font-mono text-[10px] text-fg-subtle">
                          {port.number}
                        </span>
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </div>
          <Summary ports={panel.ports} />
          <Ear />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-3 py-1.5 text-[11px] text-fg-muted">
        <Key className={JACK.up}>Up</Key>
        <Key className={JACK.down}>Down</Key>
        <Key className={JACK['admin-down']}>Admin down</Key>
        {/* Only the markings this panel can show: a router has no access VLANs or spanning tree. */}
        {panel.ports.some((port) => port.mode === 'access') && (
          <span>
            <span className="font-mono text-fg">{panel.ports.find((port) => port.mode === 'access')?.label}</span> access VLAN
          </span>
        )}
        {panel.ports.some((port) => port.mode === 'trunk') && (
          <span>
            <span className="font-mono text-fg">T</span> trunk
          </span>
        )}
        {panel.ports.some((port) => port.mode === 'routed') && (
          <span>
            <span className="font-mono text-fg">L3</span> routed
          </span>
        )}
        {panel.ports.some((port) => port.stp.length > 0) && (
          <span className="flex items-center gap-1.5">
            <span className="h-1 w-3 rounded-full bg-warn" aria-hidden="true" /> STP blocking
          </span>
        )}
        {panel.virtual.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
            {panel.virtual.map((item) => (
              <span
                key={item.name}
                className="inline-flex items-center gap-1.5 rounded-[2px] bg-raised px-1.5 font-mono leading-5 text-fg"
                title={`${item.name}: ${item.state === 'admin-down' ? 'administratively down' : item.state}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${item.state === 'up' ? 'bg-ok' : item.state === 'down' ? 'bg-crit' : 'bg-line-strong'}`} />
                {item.name}
                {item.ip && <span className="text-fg-muted">{item.ip}</span>}
              </span>
            ))}
          </span>
        )}
      </div>

      {hover && <PortCard port={hover.port} x={hover.x} y={hover.y} />}
    </div>
  )
}

function PortCard({ port, x, y }: { port: Port; x: number; y: number }) {
  // Keep the card on screen near the right edge.
  const left = Math.min(Math.max(8, x - 120), window.innerWidth - 248)
  return (
    <div role="tooltip" className="pointer-events-none fixed z-50 w-60 rounded border border-line-strong bg-surface shadow-float" style={{ left, top: y }}>
      <p className="flex items-center justify-between gap-2 border-b border-line px-2.5 py-1.5">
        <span className="font-mono font-medium text-fg">{port.fullName}</span>
        <span className={`h-2 w-2 rounded-full ${port.state === 'up' ? 'bg-ok' : port.state === 'down' ? 'bg-crit' : 'bg-line-strong'}`} />
      </p>
      <dl className="space-y-0.5 px-2.5 py-1.5 text-xs">
        {describePort(port).map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="w-16 shrink-0 text-fg-muted">{key}</dt>
            <dd className="min-w-0 font-mono text-[11px] break-words text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function Key({ className, children }: { className: string; children: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-3 w-3.5 rounded-[2px] border ${className}`} aria-hidden="true" />
      {children}
    </span>
  )
}

/** Port counts, like the status display on the right of a real panel. */
function Summary({ ports }: { ports: Port[] }) {
  const count = (test: (port: Port) => boolean) => ports.filter(test).length
  const rows: [string, number, string][] = [
    ['UP', count((port) => port.state === 'up'), 'text-ok-fg'],
    ['DOWN', count((port) => port.state === 'down'), 'text-crit-fg'],
    ['ADMIN', count((port) => port.state === 'admin-down'), 'text-fg-muted'],
    ['TRUNK', count((port) => port.mode === 'trunk'), 'text-fg'],
    ['ACCESS', count((port) => port.mode === 'access'), 'text-fg'],
    ['ROUTED', count((port) => port.mode === 'routed'), 'text-fg'],
  ]
  return (
    <dl className="hidden shrink-0 grid-cols-3 content-center gap-x-4 gap-y-1 rounded-[3px] border border-line bg-canvas px-3 py-2 font-mono text-[10px] md:grid">
      {rows.map(([label, value, colour]) => (
        <div key={label}>
          <dt className="tracking-widest text-fg-subtle">{label}</dt>
          <dd className={`tabular text-[13px] leading-4 ${value ? colour : 'text-fg-subtle'}`}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A rack-mount ear with two screw holes. */
function Ear() {
  return (
    <div aria-hidden="true" className="flex w-3 shrink-0 flex-col items-center justify-between py-1">
      <span className="h-2 w-2 rounded-full border border-line-strong bg-canvas" />
      <span className="h-2 w-2 rounded-full border border-line-strong bg-canvas" />
    </div>
  )
}
