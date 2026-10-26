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
  // The tag sits just off the line (on the outside of a bend), so it never
  // covers the interface labels of a short link.
  const side = link.offset < 0 ? -1 : 1
  const tagAt = { x: middle.x + (-dy / length) * 12 * side, y: middle.y + (dx / length) * 12 * side }

  const label = (text: string, point: { x: number; y: number }) =>
    text && (
      <span
        className="pointer-events-none absolute rounded-sm border border-line bg-canvas px-1 font-mono text-[10px] leading-[14px] text-fg-muted transition-opacity duration-200"
        style={{ transform: `translate(-50%, -50%) translate(${point.x}px, ${point.y}px)`, opacity: link.labelOpacity }}
      >
        {text}
      </span>
    )

  return (
    <>
      <path
        d={path}
        fill="none"
        stroke={link.colour}
        strokeWidth={link.width}
        strokeDasharray={link.dash}
        opacity={link.opacity}
        className="transition-opacity duration-200"
      />
      {/* Healthy links: a faint stream of dashes moving along the line. */}
      {link.animated && (
        <path
          d={path}
          fill="none"
          stroke="var(--ns-ok)"
          strokeWidth={link.width}
          strokeDasharray="2 10"
          strokeLinecap="round"
          opacity={link.opacity * 0.7}
          className="link-flow pointer-events-none transition-opacity duration-200"
        />
      )}
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
            className="pointer-events-none absolute rounded-sm border bg-canvas px-1 text-[10px] leading-[14px] font-medium transition-opacity duration-200"
            style={{
              transform: `translate(-50%, -50%) translate(${tagAt.x}px, ${tagAt.y}px)`,
              borderColor: link.colour,
              color: link.tagText,
              opacity: link.labelOpacity,
            }}
          >
            {link.tag}
          </span>
        )}
        {hovered && (
          <div
            className="pointer-events-none absolute z-50 w-max max-w-xs rounded border border-line-strong bg-raised px-2.5 py-1.5 text-xs text-fg shadow-float"
            style={{ transform: `translate(-50%, -100%) translate(${middle.x}px, ${middle.y - 14}px)` }}
            role="tooltip"
          >
            {link.details.map((line, index) => (
              <p key={index} className={index === 0 ? 'font-semibold' : 'font-mono text-[11px] text-fg-muted'}>
                {line}
              </p>
            ))}
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  )
}
