import type { CollectedRow } from '../api'
import { TableScroll, Td, Th } from './ui'

/**
 * Renders whatever the collector returned: a table when TextFSM produced
 * rows, or the raw CLI text when it could not parse the output.
 */
export default function DataTable({ data }: { data: CollectedRow[] | string }) {
  if (typeof data === 'string') {
    return (
      <div className="p-3">
        <pre
          className="max-h-96 overflow-auto rounded border border-line bg-canvas p-3 font-mono text-xs text-fg"
          title="This output could not be parsed into a table, so the raw CLI text is shown."
        >
          {data}
        </pre>
      </div>
    )
  }
  if (data.length === 0) {
    return <p className="px-3 py-5 text-fg-muted">No entries.</p>
  }

  // Columns are whatever keys the rows have, in first-seen order.
  const columns = [...new Set(data.flatMap((row) => Object.keys(row)))]
  return (
    <TableScroll maxHeight="max-h-[32rem]">
      <thead>
        <tr>
          {columns.map((column) => (
            <Th key={column}>{column.replaceAll('_', ' ')}</Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.map((row, index) => (
          <tr key={index}>
            {columns.map((column) => {
              const text = cellText(row[column])
              return (
                <Td key={column} className={`font-mono text-xs whitespace-nowrap ${stateColour(text)}`}>
                  {text || <span className="text-fg-subtle">–</span>}
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
  // Interface and VLAN states, spanning tree (FWD/BLK), trunks, OSPF adjacencies.
  if (
    ['up', 'active', 'connected', 'fwd', 'trunking'].includes(value) ||
    value.startsWith('full')
  ) {
    return 'font-medium text-ok-fg'
  }
  if (
    value.includes('down') ||
    value.includes('err-disabled') ||
    ['notconnect', 'blk', 'not-trunking', 'none'].includes(value)
  ) {
    return 'font-medium text-crit-fg'
  }
  if (['lrn', 'lis', 'altn', 'back'].includes(value) || value.startsWith('init') || value.startsWith('exstart')) {
    return 'font-medium text-warn-fg'
  }
  return 'text-fg'
}
