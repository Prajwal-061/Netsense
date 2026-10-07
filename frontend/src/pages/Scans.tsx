import { Link, useNavigate } from 'react-router-dom'
import { Card, EmptyState, ErrorBox, Loading, PageTitle, ScanStatusBadge, TableScroll, Td, Th } from '../components/ui'
import { formatDateTime, formatDuration, timeAgo } from '../format'
import { useScans } from '../queries'

export default function Scans() {
  const scans = useScans()
  const navigate = useNavigate()

  return (
    <>
      <PageTitle title="Scans" subtitle="Scan history, newest first. Open a scan for its results and changes." />
      <Card>
        {scans.isPending ? (
          <Loading label="Loading scans..." />
        ) : scans.isError ? (
          <div className="p-4">
            <ErrorBox error={scans.error} onRetry={() => void scans.refetch()} />
          </div>
        ) : scans.data.length === 0 ? (
          <EmptyState>
            No scans yet. <Link to="/" className="font-medium text-blue-700 hover:underline">Start one</Link>{' '}
            from the overview.
          </EmptyState>
        ) : (
          <TableScroll>
            <thead>
              <tr>
                <Th>Scan</Th>
                <Th>Status</Th>
                <Th>Started</Th>
                <Th>Duration</Th>
                <Th>Subnet</Th>
                <Th className="text-right">Devices</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {scans.data.map((scan) => (
                <tr
                  key={scan.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => void navigate(`/scans/${scan.id}`)}
                >
                  <Td>
                    <Link
                      to={`/scans/${scan.id}`}
                      className="font-medium text-blue-700 hover:underline"
                      onClick={(event) => event.stopPropagation()}
                    >
                      #{scan.id}
                    </Link>
                  </Td>
                  <Td>
                    <ScanStatusBadge status={scan.status} />
                    {scan.error && (
                      <p className="mt-1 max-w-md text-xs break-words text-red-700">{scan.error}</p>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {formatDateTime(scan.started_at)}
                    <span className="block text-xs text-slate-500">{timeAgo(scan.started_at)}</span>
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {formatDuration(scan.started_at, scan.finished_at)}
                  </Td>
                  <Td className="font-mono text-xs whitespace-nowrap">{scan.subnet}</Td>
                  <Td className="text-right tabular-nums">
                    {scan.status === 'completed' ? scan.device_count : '-'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableScroll>
        )}
      </Card>
    </>
  )
}
