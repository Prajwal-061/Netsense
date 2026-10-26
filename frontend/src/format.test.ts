// Times from the API are UTC; the dashboard shows them in the browser's own
// zone. These run in India (UTC+05:30), where reading UTC as local time puts
// every event five and a half hours in the future.

import { afterAll, beforeAll, expect, test, vi } from 'vitest'

vi.stubEnv('TZ', 'Asia/Kolkata')
// format.ts builds its formatters on import, so import it after the zone is set.
const { formatDateTime, formatDuration, parseTime, timeAgo } = await import('./format')

// 26 October 2026, 20:27:20 UTC = 27 October, 01:57:20 in India.
const NOW = Date.UTC(2026, 9, 26, 20, 27, 20)

beforeAll(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterAll(() => vi.useRealTimers())

test('the test really runs in UTC+05:30', () => {
  expect(new Date(NOW).getTimezoneOffset()).toBe(-330)
})

test('a scan from half an hour ago is "30 minutes ago", not in the future', () => {
  expect(timeAgo('2026-10-26T19:57:20.604724Z')).toBe('30 minutes ago')
})

test('a timestamp without a timezone is read as UTC, not as local time', () => {
  expect(parseTime('2026-10-26T19:57:20.604724')).toBe(parseTime('2026-10-26T19:57:20.604724Z'))
  expect(parseTime('2026-10-26 19:57:20')).toBe(Date.UTC(2026, 9, 26, 19, 57, 20))
  expect(timeAgo('2026-10-26T19:57:20')).toBe('30 minutes ago')
})

test('timestamps with an offset keep their instant', () => {
  expect(parseTime('2026-10-27T01:27:20+05:30')).toBe(Date.UTC(2026, 9, 26, 19, 57, 20))
})

test('the exact time is shown in the browser\'s local time', () => {
  const shown = formatDateTime('2026-10-26T19:57:20Z')
  // 19:57 UTC is 01:27 the next day in India.
  expect(shown).toMatch(/Oct 27, 2026/)
  expect(shown).toMatch(/1:27/)
})

test('durations do not depend on the zone', () => {
  expect(formatDuration('2026-10-26T19:57:20.604724Z', '2026-10-26T19:57:47.522266Z')).toBe('27s')
  expect(formatDuration('2026-10-26T19:57:20', '2026-10-26T19:58:47Z')).toBe('1m 27s')
})
