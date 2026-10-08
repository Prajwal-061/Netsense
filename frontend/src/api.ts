// Typed client for the NetSense API. The types mirror the backend's Pydantic
// schemas (backend/app/api/schemas.py).

export const API_URL: string = (
  import.meta.env.VITE_API_URL ?? 'http://192.168.17.132:8000'
).replace(/\/+$/, '')

/**
 * The API contract this dashboard was written for. Must equal API_REVISION in
 * backend/app/api/health.py. A backend reporting a lower number (or none) is
 * running older code, usually because it was not restarted after an update.
 */
export const REQUIRED_API_REVISION = 4

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
  /** Missing on backends from before revisions were introduced. */
  api_revision?: number
  database: boolean
  raw_sockets: boolean
  scan_running: boolean
  collection_running?: boolean
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
  /** Virtualisation platform from the MAC prefix, e.g. "QEMU/KVM". Not a device type. */
  virtualization: string | null
  device_type: string
  /** "collected": confirmed by logging in to the device. "scan": a guess from scan results. */
  type_source: 'scan' | 'collected'
  type_reason: string
  latest_result: ScanResult | null
}

export interface ConfigBackup {
  id: number
  collected_at: string
  last_seen_at: string
  sha256: string
  lines: number
  /**
   * Differs from the backup before it. Null for a device's first backup.
   * Undefined if the backend is too old to report it.
   */
  changed?: boolean | null
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
  /** router or switch, as confirmed by this login. */
  device_type: string
  type_reason: string
  collection_id: number
  collected_at: string
  /** Rows parsed per kind of data, or null where raw text was stored. */
  collected: Record<string, number | null>
  /** Something to be aware of, such as legacy SSH algorithms. */
  note: string | null
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

/** The last part of GET /devices/{id}/<kind>. */
export type CollectedKind =
  | 'interfaces'
  | 'cdp-neighbors'
  | 'arp'
  | 'vlans'
  | 'trunks'
  | 'spanning-tree'
  | 'mac-table'
  | 'routes'
  | 'ospf-neighbors'
  | 'ospf-interfaces'

export type CollectionStatus = 'running' | 'completed' | 'failed'

/** One device's part in a collection run. */
export interface DeviceCollectionResult {
  id: number
  device_id: number | null
  host: string
  hostname: string | null
  device_type: string | null
  status: 'pending' | 'success' | 'failed'
  error: string | null
  note: string | null
  collected_at: string
  collected: Record<string, number | null>
  config_changed: boolean | null
}

export interface NetworkCollectionSummary {
  id: number
  status: CollectionStatus
  started_at: string
  finished_at: string | null
  device_count: number
  succeeded: number
  failed: number
  pending: number
}

export interface NetworkCollectionDetail extends NetworkCollectionSummary {
  results: DeviceCollectionResult[]
}

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
export const getCollections = () => request<NetworkCollectionSummary[]>('/collections')
export const getCollection = (id: number) =>
  request<NetworkCollectionDetail>(`/collections/${id}`)
export const startCollection = () =>
  request<NetworkCollectionDetail>('/collections', { method: 'POST' })
export const getConfigs = (id: number) => request<ConfigBackup[]>(`/devices/${id}/configs`)
export const getConfig = (id: number, backupId: number) =>
  request<ConfigBackupDetail>(`/devices/${id}/configs/${backupId}`)
export const getConfigDiff = (id: number, fromId: number, toId: number) =>
  request<ConfigDiff>(`/devices/${id}/configs/diff?from_id=${fromId}&to_id=${toId}`)
