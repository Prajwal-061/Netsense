// Small building blocks shared by every page.

import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { ApiError } from '../api'
import type { ScanStatus } from '../api'

type Tone = 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'cyan' | 'slate'

const TONES: Record<Tone, string> = {
  green: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
  red: 'bg-red-50 text-red-800 ring-red-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  blue: 'bg-blue-50 text-blue-800 ring-blue-600/20',
  violet: 'bg-violet-50 text-violet-800 ring-violet-600/20',
  cyan: 'bg-cyan-50 text-cyan-800 ring-cyan-600/20',
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/20',
}

// One colour per device type, used everywhere the type is shown.
const TYPE_TONES: Record<string, Tone> = {
  'network device': 'blue',
  server: 'violet',
  'Linux/Unix host': 'amber',
  'VMware/virtual': 'cyan',
}

const SCAN_TONES: Record<ScanStatus, Tone> = {
  running: 'blue',
  completed: 'green',
  failed: 'red',
}

export function Badge({ tone = 'slate', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${TONES[tone]}`}
    >
      {children}
    </span>
  )
}

export function TypeBadge({ type }: { type: string }) {
  return <Badge tone={TYPE_TONES[type] ?? 'slate'}>{type}</Badge>
}

export function ScanStatusBadge({ status }: { status: ScanStatus }) {
  return (
    <Badge tone={SCAN_TONES[status]}>
      {status === 'running' && <Spinner className="h-3 w-3" />}
      {status}
    </Badge>
  )
}

/** Whether the device answered in the most recent completed scan. */
export function PresenceBadge({ present }: { present: boolean }) {
  return present ? (
    <Badge tone="green">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      Up
    </Badge>
  ) : (
    <Badge tone="red">
      <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
      Not seen
    </Badge>
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

export function Loading({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 px-4 py-8 text-sm text-slate-500" role="status">
      <Spinner />
      {label}
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const unreachable = error instanceof ApiError && error.status === null
  const message = error instanceof Error ? error.message : String(error)
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">
      <p className="font-semibold">{unreachable ? 'API not reachable' : 'Request failed'}</p>
      <p className="mt-1 break-words">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-red-900 ring-1 ring-red-300 hover:bg-red-100"
        >
          Try again
        </button>
      )}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="px-4 py-10 text-center text-sm text-slate-500">{children}</div>
}

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
    <section className={`rounded-lg border border-slate-200 bg-white shadow-sm ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

export function PageTitle({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
    </div>
  )
}

export function Button({
  busy = false,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={`inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 disabled:cursor-not-allowed disabled:bg-slate-300 ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  )
}

/** Table header and cell classes, shared so every table looks the same. */
export function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`bg-slate-50 px-4 py-2 text-left text-xs font-semibold tracking-wide whitespace-nowrap text-slate-600 uppercase ${className}`}
    >
      {children}
    </th>
  )
}

export function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 align-top text-sm ${className}`}>{children}</td>
}

/** Wraps a table so a wide one scrolls sideways inside its card on a narrow screen. */
export function TableScroll({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-slate-200">{children}</table>
    </div>
  )
}
