// A stand-in for the NetSense API: replaces fetch with a lookup table, so
// the real pages, hooks and API client run with no backend and no network.

import { vi } from 'vitest'
import { REQUIRED_API_REVISION } from '../api'
import type {
  CollectResult,
  ConfigBackup,
  ConfigDiff,
  Device,
  Health,
  Port,
  ScanDetail,
  ScanSummary,
} from '../api'

const SSH: Port = {
  port: 22,
  protocol: 'tcp',
  service: 'ssh',
  product: 'Cisco SSH',
  version: '1.25',
  extra_info: 'protocol 2.0',
  os_type: 'IOS',
}
const HTTP: Port = { ...SSH, port: 80, service: 'http', product: 'nginx', version: '1.24.0', os_type: '' }

function device(id: number, ip: string, mac: string, vendor: string, type: string, ports: Port[], scanId = 3): Device {
  return {
    id,
    mac,
    first_seen: '2026-10-07T06:20:53Z',
    last_seen: '2026-10-07T06:23:06Z',
    last_ip: ip,
    vendor,
    device_type: type,
    latest_result: {
      scan_id: scanId,
      device_id: id,
      ip,
      mac,
      vendor,
      open_ports: ports,
      device_type: type,
      reason: type === 'network device' ? "ssh banner on port 22 is 'Cisco SSH 1.25', OS IOS" : 'MAC prefix is VMware, Inc.',
      seen_at: '2026-10-07T06:23:06Z',
    },
  }
}

export const SWITCH = device(2, '192.168.17.10', 'aa:bb:cc:80:01:00', 'Locally administered', 'network device', [SSH])
export const HOST_PC = device(1, '192.168.17.1', '00:50:56:c0:00:01', 'VMware, Inc.', 'VMware/virtual', [])
export const WEB = device(3, '192.168.17.128', '00:0c:29:d6:6b:33', 'VMware, Inc.', 'server', [HTTP])
// Last seen in scan 2, so it is "not seen" in the latest scan (3).
export const GONE = device(4, '192.168.17.9', 'b8:27:eb:11:22:33', 'Raspberry Pi Foundation', 'unknown', [], 2)
export const DEVICES = [HOST_PC, SWITCH, WEB, GONE]

export function scan(id: number, status: ScanSummary['status'], extra: Partial<ScanSummary> = {}): ScanSummary {
  return {
    id,
    status,
    subnet: '192.168.17.0/24',
    started_at: '2026-10-07T06:23:06Z',
    finished_at: status === 'running' ? null : '2026-10-07T06:23:30Z',
    error: null,
    device_count: status === 'completed' ? 3 : 0,
    ...extra,
  }
}

export const SCAN_3: ScanDetail = {
  ...scan(3, 'completed'),
  results: [HOST_PC, SWITCH, WEB].map((item) => item.latest_result!),
  changes: {
    previous_scan_id: 2,
    new_devices: [{ mac: WEB.mac, ip: WEB.last_ip, vendor: WEB.vendor, type: WEB.device_type }],
    missing_devices: [{ mac: GONE.mac, ip: GONE.last_ip, vendor: GONE.vendor, type: GONE.device_type }],
    ip_changes: [{ mac: HOST_PC.mac, vendor: HOST_PC.vendor, old_ip: '192.168.17.77', new_ip: '192.168.17.1' }],
  },
}

export const HEALTH: Health = {
  status: 'ok',
  api_revision: REQUIRED_API_REVISION,
  database: true,
  raw_sockets: true,
  scan_running: false,
}

export const BACKUP: ConfigBackup = {
  id: 1,
  collected_at: '2026-10-07T19:23:35Z',
  last_seen_at: '2026-10-07T19:23:36Z',
  sha256: 'aefada55756be2df2b2dc9bcdca39a297f8db4e1404b7a0e5564a3f842399910',
  lines: 3,
  changed: null,
  lines_added: 0,
  lines_removed: 0,
}

/** A second backup, in which a VLAN was added and an interface moved into it. */
export const BACKUP_2: ConfigBackup = {
  id: 2,
  collected_at: '2026-10-08T09:00:00Z',
  last_seen_at: '2026-10-08T09:05:00Z',
  sha256: '5d2c1f0e9b8a7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d',
  lines: 6,
  changed: true,
  lines_added: 4,
  lines_removed: 1,
}

export const DIFF_1_TO_2: ConfigDiff = {
  device_id: 2,
  from_backup: BACKUP,
  to_backup: BACKUP_2,
  changed: true,
  lines_added: 4,
  lines_removed: 1,
  diff: [
    '--- backup #1 (2026-10-07 19:23 UTC)',
    '+++ backup #2 (2026-10-08 09:00 UTC)',
    '@@ -9,6 +9,9 @@',
    ' vlan 10',
    '  name USERS',
    ' !',
    '+vlan 20',
    '+ name SERVERS',
    '+!',
    ' interface Ethernet0/1',
    '- switchport access vlan 10',
    '+ switchport access vlan 20',
    '  switchport mode access',
  ].join('\n'),
}

export const COLLECT_RESULT: CollectResult = {
  device_id: 2,
  host: '192.168.17.10',
  collection_id: 1,
  collected_at: '2026-10-07T19:23:35Z',
  interfaces: 2,
  vlans: 1,
  mac_table: null,
  config_backup: BACKUP,
  first_backup: true,
  config_changed: false,
}

export const INTERFACES = {
  device_id: 2,
  collected_at: '2026-10-07T19:23:35Z',
  data: [
    { interface: 'Ethernet0/0', ip_address: 'unassigned', status: 'up', proto: 'up' },
    { interface: 'Ethernet0/1', ip_address: 'unassigned', status: 'administratively down', proto: 'down' },
  ],
}

/** A reply: a JSON body (status 200), [status, body], or a function returning either. */
type Reply = unknown | (() => unknown)

export class Failure {
  status: number
  detail: string
  constructor(status: number, detail: string) {
    this.status = status
    this.detail = detail
  }
}

export interface FakeApi {
  /** Replies by "METHOD /path". Change entries mid-test to change the API's state. */
  routes: Record<string, Reply>
  /** Every request made, as "METHOD /path", in order. */
  calls: string[]
  /** When true, every request fails as if the server were down. */
  offline: boolean
}

export function installFakeApi(overrides: Record<string, Reply> = {}): FakeApi {
  const api: FakeApi = {
    offline: false,
    calls: [],
    routes: {
      'GET /health': HEALTH,
      'GET /scans': [scan(3, 'completed'), scan(2, 'completed', { device_count: 2 }), scan(1, 'completed')],
      'GET /scans/3': SCAN_3,
      'GET /devices': DEVICES,
      ...Object.fromEntries(DEVICES.map((item) => [`GET /devices/${item.id}`, item])),
      ...overrides,
    },
  }

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const { pathname, search } = new URL(url)
    const key = `${init?.method ?? 'GET'} ${pathname}${search}`
    api.calls.push(key)
    if (api.offline) throw new TypeError('Failed to fetch')

    const route = api.routes[key]
    const reply = typeof route === 'function' ? (route as () => unknown)() : route
    if (reply === undefined) return json(404, { detail: `No fake route for ${key}` })
    if (reply instanceof Failure) return json(reply.status, { detail: reply.detail })
    return json(200, reply)
  })
  return api
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
