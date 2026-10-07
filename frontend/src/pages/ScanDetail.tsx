import { Link, useParams } from 'react-router-dom'
import ChangeReportView from '../components/ChangeReport'
import { PortChips } from '../components/Ports'
import {
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  PageTitle,
  ScanStatusBadge,
  TableScroll,
  Td,
  Th,
  TypeBadge,
} from '../components/ui'
import { formatDateTime, formatDuration, ipSortKey } from '../format'
import { useScan } from '../queries'

export default function ScanDetail() {
  const id = Number(useParams().id)
  const scan = useScan(Number.isInteger(id) ? id : undefined)

  if (!Number.isInteger(id)) return <EmptyState>That is not a valid scan number.</EmptyState>
  if (scan.isPending) return <Loading label="Loading scan..." />
  if (scan.isError) return <ErrorBox error={scan.error} onRetry={() => void scan.refetch()} />

  const data = scan.data
  const results = [...data.results].sort((a, b) => ipSortKey(a.ip) - ipSortKey(b.ip))

  return (
    <>
      <p className="mb-2 text-sm">
        <Link to="/scans" className="text-blue-700 hover:underline">
          Scans
        </Link>
        <span className="text-slate-400"> / </span>#{data.id}
      </p>
      <PageTitle
        title={
          <span className="flex flex-wrap items-center gap-3">
            Scan #{data.id} <ScanStatusBadge status={data.status} />
          </span>
        }
        subtitle={
          <>
            <span className="font-mono">{data.subnet}</span> · started {formatDateTime(data.started_at)}
            {data.finished_at && <> · took {formatDuration(data.started_at, data.finished_at)}</>}
          </>
        }
      />

      <div className="space-y-5">
        {data.status === 'running' && (
          <Card>
            <Loading label="This scan is still running. The page updates by itself when it finishes." />
          </Card>
        )}
        {data.status === 'failed' && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900" role="alert">
            <p className="font-semibold">This scan failed, so it has no results.</p>
            <p className="mt-1 break-words">{data.error}</p>
          </div>
        )}

        {data.changes && (
          <Card title="Changes">
            <ChangeReportView report={data.changes} />
          </Card>
        )}

        {data.status === 'completed' && (
          <Card title={`Devices seen (${results.length})`}>
            {results.length === 0 ? (
              <EmptyState>No devices answered during this scan.</EmptyState>
            ) : (
              <TableScroll>
                <thead>
                  <tr>
                    <Th>IP address</Th>
                    <Th>Type</Th>
                    <Th>Open ports</Th>
                    <Th>MAC address</Th>
                    <Th>Vendor</Th>
                    <Th>Reason for the type</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.map((result) => (
                    <tr key={result.device_id} className="hover:bg-slate-50">
                      <Td>
                        <Link
                          to={`/devices/${result.device_id}`}
                          className="font-mono font-medium text-blue-700 hover:underline"
                        >
                          {result.ip}
                        </Link>
                      </Td>
                      <Td>
                        <TypeBadge type={result.device_type} />
                      </Td>
                      <Td>
                        <PortChips ports={result.open_ports} />
                      </Td>
                      <Td className="font-mono text-xs whitespace-nowrap text-slate-700">{result.mac}</Td>
                      <Td className="text-slate-700">{result.vendor}</Td>
                      <Td className="min-w-64 text-xs text-slate-600">{result.reason}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableScroll>
            )}
          </Card>
        )}
      </div>
    </>
  )
}
