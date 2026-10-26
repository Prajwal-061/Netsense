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
export const REQUIRED_API_REVISION = 8

export class ApiError extends Error {
  /** HTTP status code, or null when no answer could be read. */
  status: number | null
  /**
   * True when the API is up but the browser would not let the page read its
   * answer (CORS). Only meaningful when status is null.
   */
  blocked: boolean

  constructor(status: number | null, message: string, blocked = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.blocked = blocked
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

/** Which step a running scan is on (GET /scans/{id}/progress). */
export interface ScanProgress {
  scan_id: number
  status: ScanStatus
  /** Null when the scan is not running, or was started from a script (another process). */
  step: 'discovery' | 'services' | 'saving' | null
  step_started_at: string | null
  hosts_found: number | null
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

export interface TopologyNode {
  /** Stable across runs: dev:<hostname>, host:<mac> or nbr:<name>. */
  id: string
  kind: 'router' | 'switch' | 'host' | 'unknown'
  name: string
  device_id: number | null
  ip: string | null
  mac: string | null
  vendor: string | null
  virtualization: string | null
  platform: string | null
  /** This run logged in to the device. */
  collected: boolean
}

export interface TopologyEnd {
  node: string
  interface: string | null
}

export interface TopologyStp {
  vlan: number
  state: 'forwarding' | 'blocking' | 'transitioning'
  blocked_at: string | null
  roles: Record<string, string>
}

export interface TopologyLink {
  id: string
  kind: 'cdp' | 'host'
  a: TopologyEnd
  b: TopologyEnd
  seen_from: string[]
  status: 'up' | 'down' | 'unknown'
  mode: 'trunk' | 'access' | 'routed' | 'unknown'
  vlans: number[]
  stp: TopologyStp[]
  stp_blocked: boolean
  ospf: boolean
  ospf_state: string | null
}

export interface Topology {
  collection_id: number
  collected_at: string
  version: number
  nodes: TopologyNode[]
  links: TopologyLink[]
  vlans: { id: number; name: string }[]
  /** In a router's ARP table, but in no switch's MAC table: known, but not located. */
  unplaced_hosts: { ip: string; mac: string; vendor: string | null; seen_by: string; interface: string }[]
  /** The out-of-band network NetSense reaches devices over. Not CDP links. */
  management: {
    network: string | null
    members: { node: string; ip: string; interface: string | null; vlan: number | null }[]
    hosts: TopologyNode[]
  }
}

export interface Baseline {
  id: number
  collection_id: number
  collected_at: string
  set_at: string
  note: string | null
  devices: { host: string; name: string | null; status: string }[]
}

export type Severity = 'critical' | 'warning' | 'info'

export interface DriftFinding {
  id: string
  device: string
  category: 'reachability' | 'config' | 'interface' | 'vlan' | 'trunk' | 'stp' | 'ospf' | 'route' | 'topology' | 'version'
  severity: Severity
  /** One plain sentence, e.g. "R2 lost OSPF neighbor R1 (10.0.12.1) on Gi0/1." */
  message: string
  details: string[]
  interfaces: string[]
  vlans: number[]
  links: string[]
  /** For a config change: the lines of that section, secrets masked. */
  diff: string | null
  /** Findings that probably caused this one. */
  caused_by: string[]
  /** Findings this one probably caused. */
  effects: string[]
}

export interface DriftSummary {
  critical: number
  warning: number
  info: number
  devices_compared: number
  devices_with_drift: number
}

export interface DriftReport {
  version: number
  baseline_collection_id: number | null
  collection_id: number | null
  summary: DriftSummary
  devices: {
    name: string
    device_id: number | null
    host: string | null
    status: 'unchanged' | 'changed' | 'unreachable' | 'new' | 'not in baseline'
    findings: string[]
  }[]
  findings: DriftFinding[]
  /** Each probable cause with everything it probably led to. */
  chains: { cause: string; effects: string[] }[]
  /** Whole-config diff per changed device, secrets masked. */
  config_diffs: Record<string, string>
  highlight: { nodes: string[]; links: string[] }
}

export interface DriftCheckSummary {
  id: number
  status: 'running' | 'completed' | 'failed'
  started_at: string
  finished_at: string | null
  error: string | null
  baseline_collection_id: number
  collection_id: number
  summary: DriftSummary | null
}

export interface DriftCheck extends DriftCheckSummary {
  report: DriftReport | null
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
    // "include": send the session cookie. The dashboard (port 5173) and the
    // API (port 8000) are different origins, and a browser only sends cookies
    // to another origin when the request asks for it.
    response = await fetch(API_URL + path, { ...init, credentials: 'include' })
  } catch {
    // fetch only rejects when no readable HTTP response arrived. The page is
    // not told why, so find out which of the two usual reasons it is.
    throw await whyNoAnswer(path, init?.method ?? 'GET')
  }
  if (!response.ok) {
    throw new ApiError(response.status, await errorDetail(response))
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

/**
 * A request got no readable answer: either the API is down, or it answered
 * and the browser hid the answer because of CORS (for example a method the
 * API does not allow from this page). A plain GET of /health tells them apart.
 */
async function whyNoAnswer(path: string, method: string): Promise<ApiError> {
  if (path !== '/health') {
    try {
      const probe = await fetch(API_URL + '/health', { credentials: 'include' })
      if (probe.ok) {
        return new ApiError(
          null,
          `The API at ${API_URL} is running, but the browser blocked its answer to ${method} ${path}. ` +
            "This usually means the API's CORS settings do not allow this request from this page " +
            '(the allowed origins in CORS_ORIGINS, or the allowed methods).',
          true,
        )
      }
    } catch {
      // The API is not answering at all.
    }
  }
  return new ApiError(null, `Cannot reach the NetSense API at ${API_URL}. Check that the backend is running.`)
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
export const getScanProgress = (id: number) => request<ScanProgress>(`/scans/${id}/progress`)
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
export const getTopology = (collectionId?: number) =>
  request<Topology>(collectionId === undefined ? '/topology' : `/topology?collection_id=${collectionId}`)
export interface Me {
  username: string
  expires_at: string
}

export const getMe = () => request<Me>('/auth/me')
export const login = (username: string, password: string) =>
  request<Me>('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
export const logout = () => request<void>('/auth/logout', { method: 'POST' })
export const getBaseline = () => request<Baseline>('/baseline')
export const setBaseline = (collectionId: number, note: string) =>
  request<Baseline>('/baseline', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collection_id: collectionId, note: note || null }),
  })
export const getDriftChecks = () => request<DriftCheckSummary[]>('/drift-checks')
export const getDriftCheck = (id: number) => request<DriftCheck>(`/drift-checks/${id}`)
export const startDriftCheck = () => request<DriftCheck>('/drift-checks', { method: 'POST' })
export const getConfigs = (id: number) => request<ConfigBackup[]>(`/devices/${id}/configs`)
export const getConfig = (id: number, backupId: number) =>
  request<ConfigBackupDetail>(`/devices/${id}/configs/${backupId}`)
export const getConfigDiff = (id: number, fromId: number, toId: number) =>
  request<ConfigDiff>(`/devices/${id}/configs/diff?from_id=${fromId}&to_id=${toId}`)
