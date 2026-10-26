import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { Health } from '../health'
import type { FlowNodeData } from './flow'

const ICON_COLOUR: Record<FlowNodeData['kind'], string> = {
  router: 'text-accent',
  switch: 'text-accent',
  host: 'text-fg-muted',
  unknown: 'text-fg-subtle',
  management: 'text-fg-subtle',
}

const HEALTH: Record<Health, { border: string; dot: string; label: string }> = {
  ok: { border: 'border-line-strong', dot: 'bg-ok', label: 'Healthy' },
  warn: { border: 'border-warn', dot: 'bg-warn', label: 'Warnings since the baseline' },
  crit: { border: 'border-crit', dot: 'bg-crit', label: 'Critical findings since the baseline' },
}

/** One device on the map. Links attach to invisible handles on its four sides. */
export default function DeviceNode({ data }: NodeProps) {
  const node = data as FlowNodeData
  const health = node.health ? HEALTH[node.health] : null
  const dashed = node.kind === 'unknown' || node.kind === 'management'
  const border = node.notCollected ? 'border-crit' : (health?.border ?? 'border-line-strong')
  return (
    <div
      className={`group relative flex h-full w-full items-center gap-2.5 rounded border bg-surface px-2.5 transition-[opacity,box-shadow,border-color] duration-200 ${border} ${
        dashed ? 'border-dashed' : ''
      } ${node.dimmed || node.faded ? 'opacity-25' : ''} ${
        node.selected ? 'shadow-[0_0_0_2px_var(--ns-accent)]' : node.changed ? 'shadow-[0_0_0_2px_var(--ns-warn)]' : ''
      } ${node.deviceId !== null ? 'cursor-pointer hover:bg-raised' : 'cursor-default'}`}
      data-node
      data-changed={node.changed || undefined}
      data-health={node.health ?? undefined}
    >
      <Handle id="top" type="target" position={Position.Top} className="!opacity-0" isConnectable={false} />
      <Handle id="left" type="target" position={Position.Left} className="!opacity-0" isConnectable={false} />
      <Handle id="bottom" type="source" position={Position.Bottom} className="!opacity-0" isConnectable={false} />
      <Handle id="right" type="source" position={Position.Right} className="!opacity-0" isConnectable={false} />
      <KindIcon kind={node.kind} className={`h-8 w-8 shrink-0 ${ICON_COLOUR[node.kind]}`} />
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-[13px] font-semibold text-fg">{node.name}</p>
        {node.subtitle && <p className="truncate font-mono text-[11px] text-fg-muted">{node.subtitle}</p>}
        {node.notCollected && <p className="text-[10px] font-medium text-crit">not reached this run</p>}
        {node.badge && !node.notCollected && <p className="truncate text-[10px] text-fg-subtle">{node.badge}</p>}
      </div>
      {health && (
        <span className={`absolute top-1.5 right-1.5 h-2 w-2 rounded-full ${health.dot}`} title={health.label}>
          <span className="sr-only">{health.label}</span>
        </span>
      )}
    </div>
  )
}

/**
 * The usual network-diagram symbols, drawn for this map: a router is a
 * cylinder seen from above with four arrows, a switch a box with arrows going
 * both ways, a host a monitor, and an unknown neighbour a dashed circle.
 */
export function KindIcon({ kind, className }: { kind: FlowNodeData['kind']; className?: string }) {
  const common = {
    className,
    viewBox: '0 0 32 32',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    role: 'img',
  }
  if (kind === 'router') {
    return (
      <svg {...common} aria-label="router">
        <circle cx="16" cy="16" r="13" fill="currentColor" fillOpacity="0.12" />
        <path d="M16 6.5v6M13.5 9l2.5-2.5L18.5 9M16 25.5v-6M13.5 23l2.5 2.5 2.5-2.5M6.5 16h6M9 13.5L6.5 16 9 18.5M25.5 16h-6M23 13.5l2.5 2.5-2.5 2.5" />
      </svg>
    )
  }
  if (kind === 'switch') {
    return (
      <svg {...common} aria-label="switch">
        <rect x="3" y="7.5" width="26" height="17" rx="2.5" fill="currentColor" fillOpacity="0.12" />
        <path d="M8 13h13M18 10.5l3 2.5-3 2.5M24 19H11M14 16.5L11 19l3 2.5" />
      </svg>
    )
  }
  if (kind === 'host') {
    return (
      <svg {...common} aria-label="host">
        <rect x="5" y="6" width="22" height="15" rx="1.5" fill="currentColor" fillOpacity="0.1" />
        <path d="M12 26h8M16 21v5" />
      </svg>
    )
  }
  if (kind === 'management') {
    return (
      <svg {...common} aria-label="management network">
        <path d="M4 16h24M9 16v-6M16 16v-6M23 16v-6M9 16v6M23 16v6" />
        <circle cx="9" cy="8" r="2" />
        <circle cx="16" cy="8" r="2" />
        <circle cx="23" cy="8" r="2" />
      </svg>
    )
  }
  return (
    <svg {...common} aria-label="unknown neighbour">
      <circle cx="16" cy="16" r="13" strokeDasharray="3.5 3" />
      <path d="M12.5 12.5a3.5 3.5 0 1 1 5 3.2c-1 .6-1.5 1.3-1.5 2.3M16 22.5v.5" />
    </svg>
  )
}
