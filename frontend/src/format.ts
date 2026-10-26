// The API sends UTC with a "Z" (2026-10-26T19:57:20Z). A date and time with
// no zone would be read by the browser as its own local time, which in
// UTC+05:30 turns "a minute ago" into "in 5 hours", so one is taken as UTC.
const HAS_ZONE = /(Z|[+-]\d\d:?\d\d)$/i

/** Milliseconds since 1970 for an API timestamp. Displayed later in the browser's own zone. */
export function parseTime(iso: string): number {
  const text = iso.trim().replace(' ', 'T')
  return Date.parse(text.includes('T') && !HAS_ZONE.test(text) ? `${text}Z` : text)
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

/** "7 Oct 2026, 12:08" in the browser's own locale and time zone. */
export function formatDateTime(iso: string): string {
  return dateTime.format(parseTime(iso))
}

/** "5 minutes ago", "yesterday". */
export function timeAgo(iso: string): string {
  const seconds = Math.round((parseTime(iso) - Date.now()) / 1000)
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

/** "24s" or "1m 05s" between two timestamps. */
export function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return '-'
  const total = Math.max(0, Math.round((parseTime(endIso) - parseTime(startIso)) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

/** Numeric sort key for an IPv4 address, so .9 sorts before .10. */
export function ipSortKey(ip: string): number {
  return ip.split('.').reduce((total, octet) => total * 256 + Number(octet), 0)
}
