// A stand-in for the NetSense API: replaces fetch with a lookup table, so
// the real pages, hooks and API client run with no backend and no network.

import { vi } from 'vitest'
import { REQUIRED_API_REVISION } from '../api'
import driftReport from './driftReport.json'
import type {
  CollectResult,
  ConfigBackup,
  ConfigDiff,
  Device,
  DeviceCollectionResult,
  NetworkCollectionDetail,
  Baseline,
  DriftCheck,
  DriftReport,
  Topology,
  TopologyLink,
  TopologyNode,
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

function device(
  id: number,
  ip: string,
  mac: string,
  vendor: string,
  type: string,
  ports: Port[],
  virtualization: string | null = null,
  scanId = 3,
): Device {
  const reason =
    type === 'network device'
      ? "ssh banner on port 22 is 'Cisco SSH 1.25', OS IOS"
      : `no open ports found, and MAC vendor '${vendor}' does not indicate a device type`
  return {
    id,
    mac,
    first_seen: '2026-10-07T06:20:53Z',
    last_seen: '2026-10-07T06:23:06Z',
    last_ip: ip,
    vendor,
    virtualization,
    device_type: type,
    type_source: 'scan',
    type_reason: reason,
    latest_result: {
      scan_id: scanId,
      device_id: id,
      ip,
      mac,
      vendor,
      open_ports: ports,
      device_type: type,
      reason,
      seen_at: '2026-10-07T06:23:06Z',
    },
  }
}

export const SWITCH = device(2, '192.168.17.10', 'aa:bb:cc:80:01:00', 'Locally administered', 'network device', [SSH])
export const HOST_PC = device(1, '192.168.17.1', '00:50:56:c0:00:01', 'VMware, Inc.', 'unknown', [], 'VMware')
export const WEB = device(3, '192.168.17.128', '00:0c:29:d6:6b:33', 'VMware, Inc.', 'server', [HTTP], 'VMware')
// Last seen in scan 2, so it is "not seen" in the latest scan (3).
export const GONE = device(4, '192.168.17.9', 'b8:27:eb:11:22:33', 'Raspberry Pi Foundation', 'unknown', [], null, 2)
// An IOSv router: a QEMU/KVM MAC address, recognised by its Cisco SSH banner.
export const ROUTER = device(5, '192.168.17.3', '52:54:00:12:33:67', 'QEMU/KVM', 'network device', [SSH], 'QEMU/KVM')
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

export const ME = { username: 'admin', expires_at: '2026-10-26T15:00:00Z' }

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
  device_type: 'switch',
  type_reason: "confirmed by login: show version reports software image 'X86_64BI_LINUX_L2-ADVENTERPRISEK9-M', a switch image",
  collection_id: 1,
  collected_at: '2026-10-07T19:23:35Z',
  collected: { version: 1, interfaces: 2, cdp_neighbors: 2, arp: 7, vlans: 8, trunks: 3, spanning_tree: 7, mac_table: null },
  note: null,
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

function result(
  id: number,
  host: string,
  status: DeviceCollectionResult['status'],
  extra: Partial<DeviceCollectionResult> = {},
): DeviceCollectionResult {
  return {
    id,
    device_id: id,
    host,
    hostname: null,
    device_type: 'network device',
    status,
    error: null,
    note: null,
    collected_at: '2026-10-08T07:30:00Z',
    collected: {},
    config_changed: null,
    ...extra,
  }
}

/** A collection run over the lab's four devices, in three stages. */
export function collectionRun(stage: 'started' | 'halfway' | 'finished'): NetworkCollectionDetail {
  const r1 = { hostname: 'R1', device_type: 'router', collected: { version: 1, routes: 10, ospf_neighbors: 1 }, config_changed: false, note: 'Connected with legacy SSH (ssh-rsa host key, SHA-1): this device offers nothing stronger.' }
  const sw1 = { hostname: 'SW1', device_type: 'switch', collected: { version: 1, vlans: 8, trunks: 3 }, config_changed: true }
  const sw2 = { hostname: 'SW2', device_type: 'switch', collected: { version: 1, vlans: 8, trunks: 2 }, config_changed: false }
  const r2Failed = { error: 'Authentication failed: 192.168.17.4 rejected the login.' }
  const results = {
    started: [result(11, '192.168.17.3', 'pending'), result(12, '192.168.17.4', 'pending'), result(13, '192.168.17.10', 'pending'), result(14, '192.168.17.11', 'pending')],
    halfway: [result(11, '192.168.17.3', 'success', r1), result(12, '192.168.17.4', 'failed', r2Failed), result(13, '192.168.17.10', 'pending'), result(14, '192.168.17.11', 'pending')],
    finished: [result(11, '192.168.17.3', 'success', r1), result(12, '192.168.17.4', 'failed', r2Failed), result(13, '192.168.17.10', 'success', sw1), result(14, '192.168.17.11', 'success', sw2)],
  }[stage]
  const count = (status: string) => results.filter((item) => item.status === status).length
  return {
    id: 7,
    status: stage === 'finished' ? 'completed' : 'running',
    started_at: '2026-10-08T07:30:00Z',
    finished_at: stage === 'finished' ? '2026-10-08T07:30:21Z' : null,
    device_count: results.length,
    succeeded: count('success'),
    failed: count('failed'),
    pending: count('pending'),
    results,
  }
}

/** A route reply that makes fetch fail for that request only, as a CORS block does. */
export const BLOCKED = Symbol('blocked by the browser')

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
  /** The JSON body of the last request to each "METHOD /path". */
  bodies: Record<string, unknown>
}

export function installFakeApi(overrides: Record<string, Reply> = {}): FakeApi {
  const api: FakeApi = {
    offline: false,
    calls: [],
    bodies: {},
    routes: {
      'GET /health': HEALTH,
      'GET /auth/me': ME,
      'GET /scans': [scan(3, 'completed'), scan(2, 'completed', { device_count: 2 }), scan(1, 'completed')],
      'GET /scans/3': SCAN_3,
      'GET /collections': [],
      'GET /devices': DEVICES,
      ...Object.fromEntries(DEVICES.map((item) => [`GET /devices/${item.id}`, item])),
      ...overrides,
    },
  }

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const { pathname, search } = new URL(url)
    const key = `${init?.method ?? 'GET'} ${pathname}${search}`
    api.calls.push(key)
    if (typeof init?.body === 'string') api.bodies[key] = JSON.parse(init.body)
    // The session cookie only travels when a request asks for it.
    if (init?.credentials !== 'include') throw new Error(`${key} was sent without credentials: 'include'`)
    if (api.offline) throw new TypeError('Failed to fetch')

    const route = api.routes[key]
    const reply = typeof route === 'function' ? (route as () => unknown)() : route
    if (reply === BLOCKED) throw new TypeError('Failed to fetch')
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


function topologyNode(id: string, kind: TopologyNode['kind'], name: string, extra: Partial<TopologyNode> = {}): TopologyNode {
  return { id, kind, name, device_id: null, ip: null, mac: null, vendor: null, virtualization: null, platform: null, collected: kind === 'router' || kind === 'switch', ...extra }
}

function topologyLink(a: [string, string | null], b: [string, string | null], extra: Partial<TopologyLink> = {}): TopologyLink {
  return {
    id: `${a[0]}|${a[1] ?? ''}--${b[0]}|${b[1] ?? ''}`,
    kind: 'cdp',
    a: { node: a[0], interface: a[1] },
    b: { node: b[0], interface: b[1] },
    seen_from: [a[0], b[0]],
    status: 'up',
    mode: 'trunk',
    vlans: [20, 30],
    stp: [],
    stp_blocked: false,
    ospf: false,
    ospf_state: null,
    ...extra,
  }
}

const forwarding = (vlan: number) => ({ vlan, state: 'forwarding' as const, blocked_at: null, roles: { 'dev:sw1': 'Desg', 'dev:sw2': 'Root' } })
const blocking = (vlan: number) => ({ vlan, state: 'blocking' as const, blocked_at: 'dev:sw2', roles: { 'dev:sw1': 'Desg', 'dev:sw2': 'Altn' } })

/** The lab as the backend's topology builder reports it. */
export const TOPOLOGY: Topology = {
  collection_id: 7,
  collected_at: '2026-10-08T07:30:21Z',
  version: 1,
  nodes: [
    topologyNode('dev:r1', 'router', 'R1', { device_id: 5, ip: '192.168.17.3' }),
    topologyNode('dev:r2', 'router', 'R2', { device_id: 8, ip: '192.168.17.4' }),
    topologyNode('dev:sw1', 'switch', 'SW1', { device_id: 2, ip: '192.168.17.10' }),
    topologyNode('dev:sw2', 'switch', 'SW2', { device_id: 9, ip: '192.168.17.11' }),
    topologyNode('host:52:54:00:68:dd:64', 'host', '10.1.20.10', { device_id: 4, ip: '10.1.20.10', mac: '52:54:00:68:dd:64', vendor: 'QEMU/KVM', virtualization: 'QEMU/KVM' }),
  ],
  links: [
    topologyLink(['dev:r1', 'Gi0/1'], ['dev:sw1', 'Et0/1'], { stp: [forwarding(20), forwarding(30)] }),
    topologyLink(['dev:r1', 'Gi0/2'], ['dev:r2', 'Gi0/1'], { mode: 'routed', vlans: [], ospf: true, ospf_state: 'FULL' }),
    topologyLink(['dev:sw1', 'Et0/2'], ['dev:sw2', 'Et0/1'], { stp: [forwarding(20), forwarding(30)] }),
    topologyLink(['dev:sw1', 'Et0/3'], ['dev:sw2', 'Et0/2'], { stp: [blocking(20), blocking(30)], stp_blocked: true }),
    topologyLink(['dev:sw2', 'Et0/3'], ['host:52:54:00:68:dd:64', null], { kind: 'host', mode: 'access', vlans: [20], seen_from: ['dev:sw2'], stp: [{ ...forwarding(20), roles: { 'dev:sw2': 'Desg' } }] }),
  ],
  vlans: [
    { id: 20, name: 'USERS' },
    { id: 30, name: 'SERVERS' },
  ],
  unplaced_hosts: [],
  management: {
    network: '192.168.17.0/24',
    members: [
      { node: 'dev:r1', ip: '192.168.17.3', interface: 'Gi0/0', vlan: null },
      { node: 'dev:r2', ip: '192.168.17.4', interface: 'Gi0/0', vlan: null },
      { node: 'dev:sw1', ip: '192.168.17.10', interface: 'Et0/0', vlan: 10 },
      { node: 'dev:sw2', ip: '192.168.17.11', interface: 'Et0/0', vlan: 10 },
    ],
    hosts: [topologyNode('host:00:0c:29:23:56:f6', 'host', '192.168.17.132', { ip: '192.168.17.132', vendor: 'VMware, Inc.' })],
  },
}


export const BASELINE: Baseline = {
  id: 1,
  collection_id: 3,
  collected_at: '2026-10-09T07:07:46Z',
  set_at: '2026-10-24T08:51:26Z',
  note: 'Healthy lab, 9 October',
  devices: [
    { host: '192.168.17.3', name: 'R1', status: 'success' },
    { host: '192.168.17.4', name: 'R2', status: 'success' },
    { host: '192.168.17.10', name: 'SW1', status: 'success' },
    { host: '192.168.17.11', name: 'SW2', status: 'success' },
  ],
}

/** The report the backend produces for the five changes made to the lab on 24 October. */
export const DRIFT_REPORT = driftReport as DriftReport

export function driftCheck(status: DriftCheck['status'], report: DriftReport | null = DRIFT_REPORT): DriftCheck {
  return {
    id: 3,
    status,
    started_at: '2026-10-24T09:00:00Z',
    finished_at: status === 'running' ? null : '2026-10-24T09:00:05Z',
    error: null,
    baseline_collection_id: 3,
    collection_id: 7,
    summary: status === 'completed' && report ? report.summary : null,
    report: status === 'completed' ? report : null,
  }
}
