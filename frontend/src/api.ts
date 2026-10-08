// Typed client for the NetSense API. The types mirror the backend's Pydantic
// schemas (backend/app/api/schemas.py).

export const API_URL: string = (
  import.meta.env.VITE_API_URL ?? 'http://192.168.17.132:8000'
).replace(/\/+$/, '')

export class ApiError extends Error {
  /** HTTP status code, or null when the API could not be reached at all. */
  status: number | null

  constructor(status: number | null, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export interface Health {
  status: string
  database: boolean
  raw_sockets: boolean
  scan_running: boolean
}

export interface Port {
  port: number
  protocol: string
  service: string
  product: string
  version: string
  extra_info: string
  os_type: string
}

export interface ScanResult {
  scan_id: number
  device_id: number
  ip: string
  mac: string
  vendor: string
  open_ports: Port[]
  device_type: string
  reason: string
  seen_at: string
}

export interface DeviceChange {
  mac: string
  ip: string
  vendor: string
  type: string
}

export interface IpChange {
  mac: string
  vendor: string
  old_ip: string
  new_ip: string
}

export interface ChangeReport {
  previous_scan_id: number | null
  new_devices: DeviceChange[]
  missing_devices: DeviceChange[]
  ip_changes: IpChange[]
}

export type ScanStatus = 'running' | 'completed' | 'failed'

export interface ScanSummary {
  id: number
  status: ScanStatus
  subnet: string
  started_at: string
  finished_at: string | null
  error: string | null
  device_count: number
}

export interface ScanDetail extends ScanSummary {
  results: ScanResult[]
  changes: ChangeReport | null
}

export interface Device {
  id: number
  mac: string
  first_seen: string
  last_seen: string
  last_ip: string
  vendor: string
  device_type: string
  latest_result: ScanResult | null
}

export interface ConfigBackup {
  id: number
  collected_at: string
  last_seen_at: string
  sha256: string
  lines: number
  /** Differs from the backup before it. Null for a device's first backup. */
  changed: boolean | null
  lines_added: number
  lines_removed: number
}

export interface ConfigDiff {
  device_id: number
  from_backup: ConfigBackup
  to_backup: ConfigBackup
  changed: boolean
  lines_added: number
  lines_removed: number
  /** Unified diff text, empty when nothing changed. */
  diff: string
}

export interface ConfigBackupDetail extends ConfigBackup {
  config: string
}

export interface CollectResult {
  device_id: number
  host: string
  collection_id: number
  collected_at: string
  interfaces: number | null
  vlans: number | null
  mac_table: number | null
  config_backup: ConfigBackup
  first_backup: boolean
  /** The config differs from the previous backup (false for a first backup). */
  config_changed: boolean
}

export type CollectedRow = Record<string, unknown>

export interface CollectedData {
  device_id: number
  collected_at: string
  /** Rows when TextFSM parsed the output, otherwise the raw CLI text. */
  data: CollectedRow[] | string
}

export type CollectedKind = 'interfaces' | 'vlans' | 'mac-table'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(API_URL + path, init)
  } catch {
    // fetch only rejects when no HTTP response arrived: server down, wrong
    // address, or the browser blocked the request (CORS).
    throw new ApiError(
      null,
      `Cannot reach the NetSense API at ${API_URL}. Check that the backend is running.`,
    )
  }
  if (!response.ok) {
    throw new ApiError(response.status, await errorDetail(response))
  }
  return (await response.json()) as T
}

/** FastAPI puts the reason in "detail": a string, or a list for validation errors. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const body = await response.json()
    if (typeof body.detail === 'string') return body.detail
    if (Array.isArray(body.detail)) {
      return body.detail.map((item: { msg?: string }) => item.msg ?? '').join('; ')
    }
  } catch {
    // Not JSON: fall through to the status text.
  }
  return `${response.status} ${response.statusText}`
}

export const getHealth = () => request<Health>('/health')
export const getScans = () => request<ScanSummary[]>('/scans')
export const getScan = (id: number) => request<ScanDetail>(`/scans/${id}`)
export const startScan = () => request<ScanSummary>('/scans', { method: 'POST' })
export const getDevices = () => request<Device[]>('/devices')
export const getDevice = (id: number) => request<Device>(`/devices/${id}`)
export const collectDevice = (id: number) =>
  request<CollectResult>(`/devices/${id}/collect`, { method: 'POST' })
export const getCollected = (id: number, kind: CollectedKind) =>
  request<CollectedData>(`/devices/${id}/${kind}`)
export const getConfigs = (id: number) => request<ConfigBackup[]>(`/devices/${id}/configs`)
export const getConfig = (id: number, backupId: number) =>
  request<ConfigBackupDetail>(`/devices/${id}/configs/${backupId}`)
export const getConfigDiff = (id: number, fromId: number, toId: number) =>
  request<ConfigDiff>(`/devices/${id}/configs/diff?from_id=${fromId}&to_id=${toId}`)
