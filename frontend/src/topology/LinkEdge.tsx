import { EdgeLabelRenderer } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useState } from 'react'
import type { FlowEdgeData } from './flow'

/** A point on the curve from S to T with control point C, at fraction t. */
function along(t: number, s: number, c: number, e: number): number {
  return (1 - t) * (1 - t) * s + 2 * (1 - t) * t * c + t * t * e
}

/**
 * One link: a line (bent sideways when it is one of several between the same
 * two devices), the interface name near each end, an optional tag in the
 * middle, and the details on hover.
 */
export default function LinkEdge({ sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const link = data as FlowEdgeData
  const [hovered, setHovered] = useState(false)

  // Bend: move the control point sideways, at right angles to the line.
  const dx = targetX - sourceX
  const dy = targetY - sourceY
  const length = Math.hypot(dx, dy) || 1
  const controlX = (sourceX + targetX) / 2 + (-dy / length) * link.offset * 2
  const controlY = (sourceY + targetY) / 2 + (dx / length) * link.offset * 2
  const path = `M ${sourceX} ${sourceY} Q ${controlX} ${controlY} ${targetX} ${targetY}`
  const at = (t: number) => ({ x: along(t, sourceX, controlX, targetX), y: along(t, sourceY, controlY, targetY) })
  const middle = at(0.5)

  const label = (text: string, point: { x: number; y: number }) =>
    text && (
      <span
        className="pointer-events-none absolute rounded bg-white/90 px-1 font-mono text-[10px] leading-4 text-slate-700 ring-1 ring-slate-200"
        style={{ transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px)`, opacity: link.opacity }}
      >
        {text}
      </span>
    )

  return (
    <>
      <path d={path} fill="none" stroke={link.colour} strokeWidth={link.width} strokeDasharray={link.dash} opacity={link.opacity} />
      {/* A wide invisible copy of the line, so it is easy to point at. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        className="cursor-help"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <title>{link.details.join('\n')}</title>
      </path>
      <EdgeLabelRenderer>
        {label(link.sourceLabel, at(0.2))}
        {label(link.targetLabel, at(0.8))}
        {link.tag && (
          <span
            className="pointer-events-none absolute rounded-full px-1.5 text-[10px] leading-4 font-semibold text-white"
            style={{
              transform: `translate(-50%, -50%) translate(${middle.x}px, ${middle.y}px)`,
              backgroundColor: link.colour,
              opacity: link.opacity,
            }}
          >
            {link.tag}
          </span>
        )}
        {hovered && (
          <div
            className="pointer-events-none absolute z-50 w-max max-w-xs rounded-md bg-slate-900 px-3 py-2 text-xs text-slate-100 shadow-lg"
            style={{ transform: `translate(-50%, -100%) translate(${middle.x}px, ${middle.y - 14}px)` }}
            role="tooltip"
          >
            {link.details.map((line, index) => (
              <p key={index} className={index === 0 ? 'font-semibold' : 'text-slate-300'}>
                {line}
              </p>
            ))}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  )
}
