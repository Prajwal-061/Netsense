import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import type { FlowNodeData } from './flow'

const STYLES: Record<FlowNodeData['kind'], { box: string; icon: string }> = {
  router: { box: 'border-indigo-300 bg-indigo-50', icon: 'text-indigo-700' },
  switch: { box: 'border-blue-300 bg-blue-50', icon: 'text-blue-700' },
  host: { box: 'border-slate-300 bg-white', icon: 'text-slate-600' },
  unknown: { box: 'border-dashed border-amber-400 bg-amber-50', icon: 'text-amber-700' },
  management: { box: 'border-dashed border-slate-400 bg-slate-100', icon: 'text-slate-500' },
}

/** One device on the map. Links attach to invisible handles on its four sides. */
export default function DeviceNode({ data }: NodeProps) {
  const node = data as FlowNodeData
  const style = STYLES[node.kind]
  return (
    <div
      className={`flex h-full w-full items-center gap-2 rounded-lg border-2 px-2.5 shadow-sm transition-opacity ${style.box} ${
        node.dimmed ? 'opacity-30' : ''
      } ${node.deviceId !== null ? 'cursor-pointer hover:shadow-md' : 'cursor-default'}`}
      title={node.deviceId !== null ? `Open ${node.name}` : undefined}
    >
      <Handle id="top" type="target" position={Position.Top} className="!opacity-0" isConnectable={false} />
      <Handle id="left" type="target" position={Position.Left} className="!opacity-0" isConnectable={false} />
      <Handle id="bottom" type="source" position={Position.Bottom} className="!opacity-0" isConnectable={false} />
      <Handle id="right" type="source" position={Position.Right} className="!opacity-0" isConnectable={false} />
      <KindIcon kind={node.kind} className={`h-8 w-8 shrink-0 ${style.icon}`} />
      <div className="min-w-0 leading-tight">
        <p className="truncate text-sm font-semibold text-slate-900">{node.name}</p>
        {node.subtitle && <p className="truncate font-mono text-[11px] text-slate-600">{node.subtitle}</p>}
        {node.notCollected && <p className="text-[10px] font-medium text-red-700">not reached this run</p>}
        {node.badge && !node.notCollected && <p className="truncate text-[10px] text-slate-500">{node.badge}</p>}
      </div>
    </div>
  )
}

/** The usual network-diagram symbols, simplified. */
export function KindIcon({ kind, className }: { kind: FlowNodeData['kind']; className?: string }) {
  const common = { className, viewBox: '0 0 32 32', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, role: 'img' }
  if (kind === 'router') {
    // A circle with arrows in four directions.
    return (
      <svg {...common} aria-label="router">
        <circle cx="16" cy="16" r="13" />
        <path d="M16 7v7M13 10l3-3 3 3M16 25v-7M13 22l3 3 3-3M7 16h5M9 13l-2 3 2 3M25 16h-5M23 13l2 3-2 3" />
      </svg>
    )
  }
  if (kind === 'switch') {
    // A box with arrows going both ways.
    return (
      <svg {...common} aria-label="switch">
        <rect x="3" y="8" width="26" height="16" rx="3" />
        <path d="M8 13h12M17 10.5l3 2.5-3 2.5M24 19H12M15 16.5L12 19l3 2.5" />
      </svg>
    )
  }
  if (kind === 'host') {
    return (
      <svg {...common} aria-label="host">
        <rect x="5" y="6" width="22" height="15" rx="2" />
        <path d="M12 27h8M16 21v6" />
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
      <circle cx="16" cy="16" r="13" strokeDasharray="4 3" />
      <path d="M12.5 12.5a3.5 3.5 0 1 1 5 3.2c-1 .6-1.5 1.3-1.5 2.3M16 22.5v.5" />
    </svg>
  )
}
