// The design system's building blocks (docs/ui-design.md). Pages use these
// and the colour tokens; they never name raw colours.

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { ApiError } from '../api'
import type { ScanStatus } from '../api'
import { formatDateTime, timeAgo } from '../format'
import { inputClass } from './controls'

// --- status --------------------------------------------------------------------

export type Status = 'ok' | 'warn' | 'crit' | 'unknown' | 'accent'

const DOT: Record<Status, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  crit: 'bg-crit',
  unknown: 'bg-unknown',
  accent: 'bg-accent',
}

/** An 8px dot in a status colour, always with text next to it. */
export function StatusDot({
  status,
  children,
  title,
  pulse = false,
}: {
  status: Status
  children?: ReactNode
  title?: string
  pulse?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={title}>
      <span aria-hidden="true" className="relative flex h-2 w-2 shrink-0">
        {pulse && <span className={`absolute inset-0 animate-ping rounded-full opacity-60 ${DOT[status]}`} />}
        <span className={`relative h-2 w-2 rounded-full ${DOT[status]}`} />
      </span>
      {children}
    </span>
  )
}

const SEVERITY_STATUS: Record<string, Status> = { critical: 'crit', warning: 'warn', info: 'unknown' }

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <StatusDot status={SEVERITY_STATUS[severity] ?? 'unknown'}>
      <span className="text-[11px] font-medium tracking-wide text-fg-muted uppercase">{severity}</span>
    </StatusDot>
  )
}

const SCAN_STATUS: Record<ScanStatus, Status> = { running: 'accent', completed: 'ok', failed: 'crit' }

export function ScanStatusBadge({ status }: { status: ScanStatus }) {
  return (
    <StatusDot status={SCAN_STATUS[status]} pulse={status === 'running'}>
      {status}
    </StatusDot>
  )
}

/** Whether the device answered in the most recent completed scan. */
export function PresenceBadge({ present }: { present: boolean }) {
  return <StatusDot status={present ? 'ok' : 'crit'}>{present ? 'Up' : 'Not seen'}</StatusDot>
}

// --- device type and virtualisation -----------------------------------------------

/** A device type with its glyph. Types are not colour-coded: colour is for status. */
export function TypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-fg">
      <DeviceGlyph type={type} className="h-3.5 w-3.5 text-fg-muted" />
      {type}
    </span>
  )
}

export function DeviceGlyph({ type, className = 'h-4 w-4' }: { type: string; className?: string }) {
  const common = {
    className,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  if (type === 'router') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.5v7M5.5 7L8 4.5 10.5 7M4.5 8h7" />
      </svg>
    )
  }
  if (type === 'switch' || type === 'network device') {
    return (
      <svg {...common}>
        <rect x="1.5" y="4.5" width="13" height="7" rx="1.5" />
        <path d="M4 8h3.5M10.5 8H12M4.5 6.5h.01M6.5 6.5h.01M8.5 6.5h.01" />
      </svg>
    )
  }
  if (type === 'server') {
    return (
      <svg {...common}>
        <rect x="3" y="2" width="10" height="5" rx="1" />
        <rect x="3" y="9" width="10" height="5" rx="1" />
        <path d="M5.5 4.5h.01M5.5 11.5h.01" />
      </svg>
    )
  }
  if (type === 'Linux/Unix host' || type === 'host') {
    return (
      <svg {...common}>
        <rect x="2" y="3" width="12" height="8" rx="1" />
        <path d="M6 14h4M8 11v3" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6" strokeDasharray="2.5 2" />
    </svg>
  )
}

/** How the device is hosted, e.g. "QEMU/KVM": a small outlined tag, never a type. */
export function VirtualBadge({ platform }: { platform: string | null | undefined }) {
  if (!platform) return null
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[2px] border border-line-strong px-1 font-mono text-[11px] leading-4 whitespace-nowrap text-fg-muted"
      title={`Virtual: the MAC address prefix belongs to ${platform}`}
    >
      <span aria-hidden="true" className="text-fg-subtle">
        VM
      </span>
      {platform}
    </span>
  )
}

/** A small neutral tag, e.g. "22/tcp ssh". */
export function Chip({ children, title, mono = true }: { children: ReactNode; title?: string; mono?: boolean }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-[2px] bg-raised px-1.5 text-[11.5px] leading-5 whitespace-nowrap text-fg ${mono ? 'font-mono' : ''}`}
    >
      {children}
    </span>
  )
}

/** A generic neutral or status-tinted label. Kept for older call sites. */
export function Badge({ tone = 'slate', children }: { tone?: string; children: ReactNode }) {
  const status: Status | null =
    tone === 'green' ? 'ok' : tone === 'red' ? 'crit' : tone === 'amber' ? 'warn' : tone === 'blue' ? 'accent' : null
  return status ? <StatusDot status={status}>{children}</StatusDot> : <Chip mono={false}>{children}</Chip>
}

// --- time -------------------------------------------------------------------------

/** "12 min ago", with the exact local time on hover. */
export function RelativeTime({ iso, className = '' }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)} className={className}>
      {timeAgo(iso)}
    </time>
  )
}

// --- messages, loading, empty -------------------------------------------------------

const BAR: Record<'crit' | 'warn' | 'info' | 'ok', string> = {
  crit: 'border-l-crit',
  warn: 'border-l-warn',
  info: 'border-l-accent',
  ok: 'border-l-ok',
}

/** A one-line message with a coloured left edge. Replaces large alert boxes. */
export function MessageBar({
  tone,
  title,
  children,
  action,
  className = '',
}: {
  tone: 'crit' | 'warn' | 'info' | 'ok'
  title?: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      role={tone === 'crit' || tone === 'warn' ? 'alert' : 'status'}
      className={`flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border border-l-[3px] border-line bg-surface px-3 py-1.5 ${BAR[tone]} ${className}`}
    >
      {title && <span className="font-medium text-fg">{title}</span>}
      {children && <span className="min-w-0 break-words text-fg-muted">{children}</span>}
      {action && <span className="ml-auto">{action}</span>}
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error)
  const title =
    error instanceof ApiError
      ? error.status !== null
        ? `The API answered with an error (HTTP ${error.status})`
        : error.blocked
          ? 'Request blocked by the browser'
          : 'API not reachable'
      : 'Request failed'
  return (
    <MessageBar
      tone="crit"
      title={title}
      action={
        onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )
      }
    >
      {message}
    </MessageBar>
  )
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/** Placeholder bars the size of the content that is loading. */
export function SkeletonRows({ rows = 5, label = 'Loading...' }: { rows?: number; label?: string }) {
  return (
    <div role="status" className="divide-y divide-line">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-9 items-center gap-6 px-3">
          <span className="skeleton h-2.5 w-28 rounded-[2px] bg-raised" />
          <span className="skeleton h-2.5 w-20 rounded-[2px] bg-raised" />
          <span className="skeleton hidden h-2.5 w-40 rounded-[2px] bg-raised sm:block" />
          <span className="skeleton hidden h-2.5 w-16 rounded-[2px] bg-raised md:block" />
        </div>
      ))}
    </div>
  )
}

export function Loading({ label = 'Loading...' }: { label?: string }) {
  return <SkeletonRows rows={3} label={label} />
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-3 py-5 text-fg-muted">{children}</div>
}

// --- page structure ---------------------------------------------------------------

/** A page's title row: title, short meta text, actions on the right. */
export function PageTitle({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-8 flex-wrap items-center gap-x-4 gap-y-1">
      <h1 className="text-[15px] leading-[22px] font-semibold text-fg">{title}</h1>
      {subtitle && <p className="text-fg-muted">{subtitle}</p>}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  )
}

/**
 * One section of a page: a bordered panel with a title bar. Panels are never
 * nested; inside a panel, structure comes from 1px dividers.
 */
export function Card({
  title,
  action,
  children,
  className = '',
}: {
  title?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`overflow-hidden rounded border border-line bg-surface ${className}`}>
      {(title || action) && (
        <header className="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-1.5">
          <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export const Section = Card

/** Label / value pairs in columns: device facts, run details. */
export function KeyValueGrid({ items, columns = 3 }: { items: [ReactNode, ReactNode][]; columns?: 1 | 2 | 3 | 4 }) {
  const cols = { 1: '', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 lg:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' }[columns]
  return (
    <dl className={`grid grid-cols-1 gap-x-6 ${cols} px-3 py-2`}>
      {items.map(([label, value], index) => (
        <div key={index} className={`flex min-h-8 items-baseline gap-3 border-b border-line py-1.5 last:border-b-0 ${columns > 1 ? 'sm:[&:nth-last-child(-n+3)]:border-b-0' : ''}`}>
          <dt className="w-28 shrink-0 text-[11px] font-medium tracking-wide text-fg-muted uppercase">{label}</dt>
          <dd className="min-w-0 break-words text-fg">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

// --- controls -----------------------------------------------------------------------

export function Button({
  busy = false,
  variant = 'primary',
  size = 'md',
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean
  variant?: 'primary' | 'secondary' | 'ghost'
  size?: 'sm' | 'md'
}) {
  const look = {
    primary: 'bg-accent text-on-accent hover:brightness-110 disabled:bg-raised disabled:text-fg-subtle',
    secondary: 'border border-line-strong text-fg hover:bg-raised disabled:text-fg-subtle',
    ghost: 'text-fg-muted hover:bg-raised hover:text-fg',
  }[variant]
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={`inline-flex items-center justify-center gap-1.5 rounded font-medium whitespace-nowrap transition-[filter,background-color] duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed ${
        size === 'sm' ? 'h-6 px-2 text-[12px]' : 'h-7 px-3 text-[13px]'
      } ${look} ${className}`}
    >
      {busy && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  )
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${className}`} />
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${inputClass} pr-6 ${className}`}>
      {children}
    </select>
  )
}

/** A small field label above or beside a control. */
export function FieldLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`text-[11px] font-medium tracking-wide text-fg-muted uppercase ${className}`}>{children}</span>
}

// --- tables -------------------------------------------------------------------------

export function Th({
  children,
  className = '',
  sort,
}: {
  children?: ReactNode
  className?: string
  /** Makes the column sortable: the current sort state and a toggle for this column. */
  sort?: { active: boolean; direction: 'asc' | 'desc'; onToggle: () => void }
}) {
  return (
    <th
      scope="col"
      aria-sort={sort?.active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
      className={`sticky top-0 z-10 h-8 border-b border-line bg-surface px-3 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-fg-muted uppercase ${className}`}
    >
      {sort ? (
        <button
          type="button"
          onClick={sort.onToggle}
          className={`inline-flex items-center gap-1 uppercase hover:text-fg ${sort.active ? 'text-fg' : ''}`}
        >
          {children}
          <span aria-hidden="true" className={`text-[9px] ${sort.active ? 'opacity-100' : 'opacity-0'}`}>
            {sort.direction === 'asc' ? '▲' : '▼'}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  )
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`h-9 border-b border-line px-3 align-middle ${className}`}>{children}</td>
}

/** A table that scrolls inside its panel, with a sticky header row. */
export function TableScroll({ children, maxHeight }: { children: ReactNode; maxHeight?: string }) {
  return (
    <div className={`overflow-auto ${maxHeight ?? ''}`}>
      <table className="min-w-full border-separate border-spacing-0 text-[13px] [&_tbody_tr]:transition-colors [&_tbody_tr:hover]:bg-raised [&_tbody_tr:last-child_td]:border-b-0">
        {children}
      </table>
    </div>
  )
}

