import type { CollectedRow } from '../api'
import { TableScroll, Td, Th } from './ui'

/**
 * Renders whatever the collector returned: a table when TextFSM produced
 * rows, or the raw CLI text when it could not parse the output.
 */
export default function DataTable({ data }: { data: CollectedRow[] | string }) {
  if (typeof data === 'string') {
    return (
      <div className="p-4">
        <p className="mb-2 text-xs text-slate-500">
          This output could not be parsed into a table, so the raw CLI text is shown.
        </p>
        <pre className="max-h-96 overflow-auto rounded-md bg-slate-950 p-4 font-mono text-xs text-slate-100">
          {data}
        </pre>
      </div>
    )
  }
  if (data.length === 0) {
    return <p className="px-4 py-8 text-center text-sm text-slate-500">No entries.</p>
  }

  // Columns are whatever keys the rows have, in first-seen order.
  const columns = [...new Set(data.flatMap((row) => Object.keys(row)))]
  return (
    <TableScroll>
      <thead>
        <tr>
          {columns.map((column) => (
            <Th key={column}>{column.replaceAll('_', ' ')}</Th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {data.map((row, index) => (
          <tr key={index} className="hover:bg-slate-50">
            {columns.map((column) => {
              const text = cellText(row[column])
              return (
                <Td key={column} className={`font-mono text-xs ${stateColour(text)}`}>
                  {text || <span className="text-slate-300">-</span>}
                </Td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </TableScroll>
  )
}

function cellText(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  if (value === null || value === undefined) return ''
  return String(value)
}

/** Green for up/active, red for anything down, as on a switch's own LEDs. */
function stateColour(text: string): string {
  const value = text.toLowerCase()
  if (value === 'up' || value === 'active' || value === 'connected') {
    return 'font-semibold text-emerald-700'
  }
  if (value.includes('down') || value.includes('err-disabled') || value === 'notconnect') {
    return 'font-semibold text-red-700'
  }
  return 'text-slate-800'
}
