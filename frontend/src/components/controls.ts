// Non-component helpers shared by the UI components (kept apart so that
// component files only export components, which fast refresh needs).

import { useMemo, useState } from 'react'

export const inputClass =
  'h-7 rounded border border-line-strong bg-canvas px-2 text-[13px] text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none'


/** Sorting state for a table. sortBy(key) returns the props for that column's Th. */
export function useSort<K extends string>(initial: K, initialDirection: 'asc' | 'desc' = 'asc') {
  const [key, setKey] = useState<K>(initial)
  const [direction, setDirection] = useState(initialDirection)
  return useMemo(
    () => ({
      key,
      direction,
      sortBy: (column: K) => ({
        active: key === column,
        direction: key === column ? direction : 'asc',
        onToggle: () => {
          if (key === column) setDirection(direction === 'asc' ? 'desc' : 'asc')
          else {
            setKey(column)
            setDirection('asc')
          }
        },
      }),
      /** Sort rows by the value each column's accessor returns. */
      apply: <T,>(rows: T[], accessors: Record<K, (row: T) => string | number>) => {
        const get = accessors[key]
        const sign = direction === 'asc' ? 1 : -1
        return [...rows].sort((a, b) => {
          const x = get(a)
          const y = get(b)
          return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sign
        })
      },
    }),
    [key, direction],
  )
}
