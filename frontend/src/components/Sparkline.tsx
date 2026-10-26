import type { Status } from './ui'

const TONE: Record<Status, string> = {
  ok: 'text-ok-fg',
  warn: 'text-warn-fg',
  crit: 'text-crit-fg',
  unknown: 'text-info-fg',
  accent: 'text-link',
}

/**
 * A small line chart of a history, oldest value first. Draws nothing for
 * fewer than two values: one point is not a trend.
 */
export default function Sparkline({
  values,
  label,
  tone = 'accent',
  width = 96,
  height = 28,
}: {
  values: number[]
  /** What the values are, for screen readers and the hover text. */
  label: string
  tone?: Status
  width?: number
  height?: number
}) {
  if (values.length < 2) return null
  const pad = 2.5
  const min = Math.min(...values)
  const max = Math.max(...values)
  const x = (index: number) => pad + (index / (values.length - 1)) * (width - 2 * pad)
  // A flat history is drawn as a line through the middle.
  const y = (value: number) => (max === min ? height / 2 : pad + (1 - (value - min) / (max - min)) * (height - 2 * pad))
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`)
  const line = `M${points.join('L')}`
  const area = `${line}L${x(values.length - 1).toFixed(1)},${height}L${x(0).toFixed(1)},${height}Z`
  const last = values[values.length - 1]
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`shrink-0 overflow-visible ${TONE[tone]}`}
      role="img"
      aria-label={`${label}: ${values.join(', ')}`}
    >
      <title>{`${label}, oldest to newest: ${values.join(', ')}`}</title>
      <path d={area} fill="currentColor" opacity={0.1} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(last)} r={2.25} fill="currentColor" />
    </svg>
  )
}
