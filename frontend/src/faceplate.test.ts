import { expect, test } from 'vitest'
import { buildPanel, describePort, shortInterface } from './faceplate'

test('interface names are shortened the same way as in the backend', () => {
  expect(['GigabitEthernet0/1', 'Gi0/1', 'Ethernet0/3', 'Vlan10', 'Loopback1', 'Port-channel1'].map(shortInterface)).toEqual([
    'Gi0/1',
    'Gi0/1',
    'Et0/3',
    'Vl10',
    'Lo1',
    'Po1',
  ])
})

// SW2 as collected from the lab: Et0/0 management (VLAN 10), two trunks to
// SW1 (one blocked by STP), Et0/3 to the Alpine host in VLAN 20.
const SW2 = buildPanel({
  interfaces: [
    { interface: 'Ethernet0/0', ip_address: 'unassigned', status: 'up', proto: 'up' },
    { interface: 'Ethernet0/1', ip_address: 'unassigned', status: 'up', proto: 'up' },
    { interface: 'Ethernet0/2', ip_address: 'unassigned', status: 'up', proto: 'up' },
    { interface: 'Ethernet0/3', ip_address: 'unassigned', status: 'down', proto: 'down' },
    { interface: 'Vlan10', ip_address: '192.168.17.11', status: 'up', proto: 'up' },
  ],
  vlans: [
    { vlan_id: '10', vlan_name: 'MGMT', interfaces: ['Et0/0'] },
    { vlan_id: '20', vlan_name: 'USERS', interfaces: ['Et0/3'] },
  ],
  trunks: [
    { interface: 'Et0/1', allowed_vlans: '20,30' },
    { interface: 'Et0/2', allowed_vlans: '20-21,30' },
  ],
  cdp: [{ neighbor_name: 'SW1', neighbor_interface: 'Ethernet0/2', local_interface: 'Ethernet0/1' }],
  macTable: [
    { destination_address: '000c.2923.56f6', vlan_id: '10', destination_port: ['Et0/0'] },
    { destination_address: '0050.56c0.0001', vlan_id: '10', destination_port: ['Et0/0'] },
    { destination_address: 'aabb.cc00.0120', vlan_id: '20', destination_port: ['Et0/1'] },
  ],
  stp: [
    { vlan_id: '20', interface: 'Et0/1', role: 'Root', status: 'FWD' },
    { vlan_id: '20', interface: 'Et0/2', role: 'Altn', status: 'BLK' },
  ],
})

test('a switch: access ports show their VLAN, trunks T, and the SVI is a virtual interface', () => {
  expect(SW2.ports.map((port) => [port.name, port.state, port.label])).toEqual([
    ['Et0/0', 'up', '10'],
    ['Et0/1', 'up', 'T'],
    ['Et0/2', 'up', 'T'],
    ['Et0/3', 'down', '20'],
  ])
  expect(SW2.virtual).toEqual([{ name: 'Vl10', ip: '192.168.17.11', state: 'up' }])
  expect(SW2.ports[2].vlans).toEqual([20, 21, 30])
})

test('a switch port knows its neighbour, MAC count and spanning-tree state', () => {
  const [mgmt, toSw1, blocked, host] = SW2.ports
  expect(toSw1.neighbour).toEqual({ name: 'SW1', port: 'Et0/2' })
  expect([mgmt.macCount, toSw1.macCount, host.macCount]).toEqual([2, 1, 0])
  expect([toSw1.blocking, blocked.blocking]).toEqual([false, true])
  expect(describePort(blocked)).toEqual([
    ['Status', 'up'],
    ['Trunk', 'VLANs 20, 21, 30'],
    ['MACs', '0'],
    ['STP', 'VLAN 20 Altn BLK'],
  ])
})

test('a router: subinterfaces make their parent a trunk, addressed ports are routed, ARP gives the count', () => {
  const r1 = buildPanel({
    interfaces: [
      { interface: 'GigabitEthernet0/0', ip_address: '192.168.17.3', status: 'up', proto: 'up' },
      { interface: 'GigabitEthernet0/1', ip_address: 'unassigned', status: 'up', proto: 'up' },
      { interface: 'GigabitEthernet0/1.20', ip_address: '10.1.20.1', status: 'up', proto: 'up' },
      { interface: 'GigabitEthernet0/1.30', ip_address: '10.1.30.1', status: 'up', proto: 'up' },
      { interface: 'GigabitEthernet0/2', ip_address: '10.0.12.1', status: 'up', proto: 'up' },
      { interface: 'GigabitEthernet0/3', ip_address: 'unassigned', status: 'administratively down', proto: 'down' },
      { interface: 'Loopback0', ip_address: '1.1.1.1', status: 'up', proto: 'up' },
    ],
    cdp: [{ neighbor_name: 'R2.netsense.local', neighbor_interface: 'GigabitEthernet0/1', local_interface: 'GigabitEthernet0/2' }],
    arp: [
      { ip_address: '10.0.12.1', age: '-', mac_address: '5254.00fa.5624', interface: 'GigabitEthernet0/2' },
      { ip_address: '10.0.12.2', age: '34', mac_address: '5254.0095.4d8f', interface: 'GigabitEthernet0/2' },
      { ip_address: '10.1.20.10', age: '3', mac_address: '5254.0068.dd64', interface: 'GigabitEthernet0/1.20' },
    ],
    ospf: [{ interface: 'Gi0/2', area: '0', state: 'BDR' }],
  })

  expect(r1.ports.map((port) => [port.name, port.state, port.label, port.mode])).toEqual([
    ['Gi0/0', 'up', 'L3', 'routed'],
    ['Gi0/1', 'up', 'T', 'trunk'],
    ['Gi0/2', 'up', 'L3', 'routed'],
    ['Gi0/3', 'admin-down', '', 'unknown'],
  ])
  expect(r1.ports[1].vlans).toEqual([20, 30])
  expect(r1.ports[1].macCount).toBe(1)
  expect(r1.ports[2]).toMatchObject({ neighbour: { name: 'R2', port: 'Gi0/1' }, macCount: 1, ospf: { area: '0', state: 'BDR' } })
  expect(r1.virtual).toEqual([{ name: 'Lo0', ip: '1.1.1.1', state: 'up' }])
})
