// The front panel of a router or switch, built from what was collected from
// it. Pure functions: rows from the API in, one entry per port out.
//
// Interface names come in two spellings ("Ethernet0/1" from show ip interface
// brief and CDP, "Et0/1" from the trunk, spanning-tree and MAC tables), so
// every name is shortened with shortInterface before it is compared.

import type { CollectedRow } from './api'

const PREFIXES: [string, string][] = [
  ['TenGigabitEthernet', 'Te'],
  ['GigabitEthernet', 'Gi'],
  ['FastEthernet', 'Fa'],
  ['Ethernet', 'Et'],
  ['Port-channel', 'Po'],
  ['Loopback', 'Lo'],
  ['Vlan', 'Vl'],
]

/** 'GigabitEthernet0/1' and 'Gi0/1' both become 'Gi0/1' (as the backend's short_interface). */
export function shortInterface(name: string): string {
  const trimmed = name.trim()
  for (const [long, short] of PREFIXES) {
    if (trimmed.startsWith(long)) return short + trimmed.slice(long.length)
  }
  return trimmed
}

const PHYSICAL = /^(Te|Gi|Fa|Et)\d+\/\d+$/

export type PortState = 'up' | 'down' | 'admin-down'

export interface Port {
  /** Short name, e.g. "Et0/1". */
  name: string
  /** Name as the device spells it, e.g. "Ethernet0/1". */
  fullName: string
  /** "0/1": what is printed under the port. */
  number: string
  /** Module/slot: ports are grouped by it, as on the real panel. */
  slot: string
  state: PortState
  protocolUp: boolean
  ip: string | null
  mode: 'access' | 'trunk' | 'routed' | 'unknown'
  /** Access VLAN, or the VLANs a trunk (or a router's subinterfaces) carries. */
  vlans: number[]
  /** On the port: the access VLAN, "T" for a trunk, "L3" for a routed port. */
  label: string
  neighbour: { name: string; port: string | null } | null
  /** MAC addresses learnt on the port (switch) or ARP entries on it (router). */
  macCount: number | null
  stp: { vlan: number; role: string; state: string }[]
  /** Spanning tree blocks the port in at least one VLAN. */
  blocking: boolean
  ospf: { area: string; state: string } | null
}

export interface VirtualInterface {
  name: string
  ip: string | null
  state: PortState
}

export interface Panel {
  ports: Port[]
  virtual: VirtualInterface[]
}

export interface PanelInput {
  interfaces: CollectedRow[]
  vlans?: CollectedRow[]
  trunks?: CollectedRow[]
  cdp?: CollectedRow[]
  macTable?: CollectedRow[]
  arp?: CollectedRow[]
  stp?: CollectedRow[]
  ospf?: CollectedRow[]
}

const text = (value: unknown): string => (Array.isArray(value) ? value.join(',') : value == null ? '' : String(value))
const list = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : value ? String(value).split(',') : [])

function stateOf(row: CollectedRow): { state: PortState; protocolUp: boolean } {
  const status = text(row.status).toLowerCase()
  const protocolUp = text(row.proto).toLowerCase() === 'up'
  if (status.startsWith('admin')) return { state: 'admin-down', protocolUp }
  return { state: status === 'up' && protocolUp ? 'up' : 'down', protocolUp }
}

function vlanList(value: string): number[] {
  const vlans: number[] = []
  for (const part of value.replace(/\s/g, '').split(',')) {
    const [first, last] = part.split('-')
    if (/^\d+$/.test(first) && last && /^\d+$/.test(last)) {
      for (let vlan = Number(first); vlan <= Number(last) && vlans.length < 4096; vlan++) vlans.push(vlan)
    } else if (/^\d+$/.test(part)) vlans.push(Number(part))
  }
  return vlans
}

/** The device's ports and virtual interfaces, with everything known about each. */
export function buildPanel(input: PanelInput): Panel {
  const ports: Port[] = []
  const virtual: VirtualInterface[] = []
  const subinterfaces = new Map<string, number[]>()

  for (const row of input.interfaces) {
    const fullName = text(row.interface)
    const name = shortInterface(fullName)
    const ip = text(row.ip_address)
    const address = ip && ip !== 'unassigned' ? ip : null
    const { state, protocolUp } = stateOf(row)
    const sub = name.match(/^(.+)\.(\d+)$/)
    if (sub) {
      // Router-on-a-stick: Gi0/1.20 carries VLAN 20 (by convention the
      // subinterface number is the 802.1Q tag).
      subinterfaces.set(sub[1], [...(subinterfaces.get(sub[1]) ?? []), Number(sub[2])])
      continue
    }
    if (!PHYSICAL.test(name)) {
      virtual.push({ name, ip: address, state })
      continue
    }
    const [slot, number] = name.replace(/^[A-Za-z]+/, '').split('/')
    ports.push({
      name,
      fullName,
      number: `${slot}/${number}`,
      slot,
      state,
      protocolUp,
      ip: address,
      mode: address ? 'routed' : 'unknown',
      vlans: [],
      label: address ? 'L3' : '',
      neighbour: null,
      macCount: null,
      stp: [],
      blocking: false,
      ospf: null,
    })
  }

  const byName = new Map(ports.map((port) => [port.name, port]))
  const port = (value: unknown) => byName.get(shortInterface(text(value)))

  for (const [parent, vlans] of subinterfaces) {
    const target = byName.get(parent)
    if (target) Object.assign(target, { mode: 'trunk', vlans: vlans.sort((a, b) => a - b), label: 'T' })
  }
  for (const row of input.vlans ?? []) {
    const vlan = Number(text(row.vlan_id))
    for (const member of list(row.interfaces)) {
      const target = port(member)
      if (target && target.mode !== 'trunk') Object.assign(target, { mode: 'access', vlans: [vlan], label: String(vlan) })
    }
  }
  for (const row of input.trunks ?? []) {
    const target = port(row.interface)
    if (target) Object.assign(target, { mode: 'trunk', vlans: vlanList(text(row.allowed_vlans)), label: 'T' })
  }
  for (const row of input.cdp ?? []) {
    const target = port(row.local_interface)
    // CDP names can carry the domain: "R2.netsense.local".
    if (target) target.neighbour = { name: text(row.neighbor_name).split('.')[0], port: row.neighbor_interface ? shortInterface(text(row.neighbor_interface)) : null }
  }
  if (input.macTable) {
    for (const target of ports) target.macCount = 0
    for (const row of input.macTable) {
      for (const member of list(row.destination_port)) {
        const target = port(member)
        if (target) target.macCount = (target.macCount ?? 0) + 1
      }
    }
  } else if (input.arp) {
    for (const target of ports) target.macCount = 0
    for (const row of input.arp) {
      // Age "-" is the router's own address on that interface.
      if (text(row.age) === '-') continue
      const target = port(text(row.interface).split('.')[0])
      if (target) target.macCount = (target.macCount ?? 0) + 1
    }
  }
  for (const row of input.stp ?? []) {
    const target = port(row.interface)
    if (!target) continue
    const entry = { vlan: Number(text(row.vlan_id)), role: text(row.role), state: text(row.status) }
    target.stp.push(entry)
    if (entry.state.toUpperCase().startsWith('BLK')) target.blocking = true
  }
  for (const row of input.ospf ?? []) {
    const target = port(row.interface)
    if (target) target.ospf = { area: text(row.area), state: text(row.state) }
  }

  ports.sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true }) || a.number.localeCompare(b.number, undefined, { numeric: true }))
  return { ports, virtual }
}

/** One line per fact, for a port's hover card and its accessible name. */
export function describePort(port: Port): [string, string][] {
  const lines: [string, string][] = [
    ['Status', port.state === 'admin-down' ? 'administratively down' : port.state === 'up' ? 'up' : port.protocolUp ? 'down' : 'down (no link)'],
  ]
  if (port.mode === 'access') lines.push(['VLAN', `${port.vlans[0]} (access)`])
  if (port.mode === 'trunk') lines.push(['Trunk', port.vlans.length ? `VLANs ${port.vlans.join(', ')}` : 'no VLANs allowed'])
  if (port.ip) lines.push(['IP', port.ip])
  if (port.neighbour) lines.push(['Neighbor', port.neighbour.port ? `${port.neighbour.name} ${port.neighbour.port}` : port.neighbour.name])
  if (port.macCount !== null) lines.push(['MACs', String(port.macCount)])
  if (port.stp.length) lines.push(['STP', port.stp.map((entry) => `VLAN ${entry.vlan} ${entry.role} ${entry.state}`).join(', ')])
  if (port.ospf) lines.push(['OSPF', `area ${port.ospf.area}, ${port.ospf.state}`])
  return lines
}
