// The map's layout and styling rules, tested without rendering anything.

import { expect, test } from 'vitest'
import type { Topology } from '../api'
import { TOPOLOGY } from '../test/fakeApi'
import { isBlocked, layout, MANAGEMENT_NODE_ID, summarise, toFlow } from './flow'

const node = (flow: ReturnType<typeof toFlow>, id: string) => flow.nodes.find((item) => item.id === id)!
const edge = (flow: ReturnType<typeof toFlow>, a: string, b: string) =>
  flow.edges.filter((item) => item.id.includes(`${a}|`) && item.id.includes(`${b}|`))

test('routers are placed at the top, switches below them, hosts at the bottom', () => {
  const positions = layout(TOPOLOGY.nodes, TOPOLOGY.links)
  const y = (id: string) => positions.get(id)!.y

  expect(y('dev:r1')).toBe(y('dev:r2'))
  expect(y('dev:sw1')).toBe(y('dev:sw2'))
  expect(y('dev:r1')).toBeLessThan(y('dev:sw1'))
  expect(y('dev:sw1')).toBeLessThan(y('host:52:54:00:68:dd:64'))
})

test('nodes in a row do not overlap, and each row is centred', () => {
  const positions = layout(TOPOLOGY.nodes, TOPOLOGY.links)
  const x = (id: string) => positions.get(id)!.x

  expect(x('dev:r2') - x('dev:r1')).toBeGreaterThan(168)
  expect(x('dev:sw2') - x('dev:sw1')).toBeGreaterThan(168)
  // The top row is centred on x = 0 (positions are a node's left edge).
  expect(x('dev:r1') + x('dev:r2') + 168).toBe(0)
})

test('a node is placed under the nodes it connects to', () => {
  const positions = layout(TOPOLOGY.nodes, TOPOLOGY.links)
  const x = (id: string) => positions.get(id)!.x

  // SW1 hangs off R1, so it sits directly under R1 and SW2 beside it. The
  // host is plugged into SW2, so it sits directly under SW2.
  expect(x('dev:sw1')).toBe(x('dev:r1'))
  expect(x('dev:sw1')).toBeLessThan(x('dev:sw2'))
  expect(x('host:52:54:00:68:dd:64')).toBe(x('dev:sw2'))
})

test('nodes that want the same place are pushed apart, not stacked', () => {
  const hosts = ['a', 'b', 'c'].map((letter) => ({ ...TOPOLOGY.nodes[4], id: `host:${letter}`, name: `10.1.20.1${letter}` }))
  const links = hosts.map((host) => ({ ...TOPOLOGY.links[4], id: host.id, b: { node: host.id, interface: null } }))
  const positions = layout([...TOPOLOGY.nodes.slice(0, 4), ...hosts], [...TOPOLOGY.links.slice(0, 4), ...links])
  const xs = hosts.map((host) => positions.get(host.id)!.x)

  expect(xs[1] - xs[0]).toBe(264)
  expect(xs[2] - xs[1]).toBe(264)
  // Three hosts of SW2: the middle one is under it, the others either side.
  expect(xs[1]).toBe(positions.get('dev:sw2')!.x)
})

test('rows without nodes take no space', () => {
  const routersAndHost: Topology = { ...TOPOLOGY, nodes: TOPOLOGY.nodes.filter((item) => item.kind !== 'switch'), links: [] }
  const positions = layout(routersAndHost.nodes, [])

  // The host row comes directly under the router row.
  expect(positions.get('host:52:54:00:68:dd:64')!.y - positions.get('dev:r1')!.y).toBe(190)
})

test('links go from the upper node down, or left to right within a row', () => {
  const flow = toFlow(TOPOLOGY)

  const [trunk] = edge(flow, 'dev:r1', 'dev:sw1')
  expect([trunk.source, trunk.sourceHandle, trunk.target, trunk.targetHandle]).toEqual(['dev:r1', 'bottom', 'dev:sw1', 'top'])
  expect([trunk.data.sourceLabel, trunk.data.targetLabel]).toEqual(['Gi0/1', 'Et0/1'])

  const [routed] = edge(flow, 'dev:r1', 'dev:r2')
  expect([routed.source, routed.sourceHandle, routed.target, routed.targetHandle]).toEqual(['dev:r1', 'right', 'dev:r2', 'left'])
  expect([routed.data.sourceLabel, routed.data.targetLabel]).toEqual(['Gi0/2', 'Gi0/1'])
})

test('interface labels follow the node they belong to when a link is drawn the other way round', () => {
  // The same link with its ends swapped in the data: SW1 is still the upper end.
  const swapped: Topology = {
    ...TOPOLOGY,
    links: TOPOLOGY.links.map((link) => (link.a.node === 'dev:r1' && link.b.node === 'dev:sw1' ? { ...link, a: link.b, b: link.a } : link)),
  }

  const [trunk] = toFlow(swapped).edges.filter((item) => item.id.includes('dev:r1|Gi0/1'))

  expect([trunk.source, trunk.data.sourceLabel, trunk.target, trunk.data.targetLabel]).toEqual(['dev:r1', 'Gi0/1', 'dev:sw1', 'Et0/1'])
})

test('parallel links between two devices are fanned out, single links are straight', () => {
  const flow = toFlow(TOPOLOGY)

  const parallel = edge(flow, 'dev:sw1', 'dev:sw2')
  expect(parallel).toHaveLength(2)
  expect(parallel.map((item) => item.data.offset)).toEqual([-27, 27])
  expect(edge(flow, 'dev:r1', 'dev:sw1')[0].data.offset).toBe(0)
})

test('blocked links are dashed, OSPF links highlighted, down links red', () => {
  const flow = toFlow(TOPOLOGY)
  const [forwarding, blocked] = edge(flow, 'dev:sw1', 'dev:sw2')
  const [ospf] = edge(flow, 'dev:r1', 'dev:r2')

  expect([forwarding.data.dash, forwarding.data.tag, forwarding.data.colour, forwarding.data.animated]).toEqual([undefined, null, 'var(--ns-fg-subtle)', true])
  expect([blocked.data.dash, blocked.data.tag, blocked.data.opacity, blocked.data.animated]).toEqual(['6 5', 'STP blocked', 0.45, false])
  // Only the line fades: its labels and tag stay readable, in a text colour.
  expect([blocked.data.labelOpacity, blocked.data.tagText]).toEqual([1, 'var(--ns-fg-muted)'])
  expect([ospf.data.colour, ospf.data.width, ospf.data.tag, ospf.data.dash]).toEqual(['var(--ns-accent)', 2.25, 'OSPF', undefined])

  const withDown: Topology = { ...TOPOLOGY, links: TOPOLOGY.links.map((link) => (link.ospf ? { ...link, status: 'down' } : link)) }
  const [down] = edge(toFlow(withDown), 'dev:r1', 'dev:r2')
  expect([down.data.colour, down.data.tag, down.data.animated]).toEqual(['var(--ns-crit)', 'down', false])
})

test('choosing a VLAN highlights where it is carried and dims the rest', () => {
  const flow = toFlow(TOPOLOGY, { vlan: 30 })

  // VLAN 30 runs R1 - SW1 - SW2 over both cables, but not to the host (VLAN 20)
  // and not over the routed link.
  const [trunk] = edge(flow, 'dev:r1', 'dev:sw1')
  expect([trunk.data.colour, trunk.data.opacity, trunk.data.width]).toEqual(['var(--ns-accent)', 1, 2.25])
  const [routed] = edge(flow, 'dev:r1', 'dev:r2')
  expect(routed.data.opacity).toBeLessThan(0.3)
  const [hostLink] = flow.edges.filter((item) => item.id.includes('host:'))
  expect(hostLink.data.opacity).toBeLessThan(0.3)

  expect(node(flow, 'dev:sw2').data.dimmed).toBe(false)
  expect(node(flow, 'dev:r2').data.dimmed).toBe(true)
  expect(node(flow, 'host:52:54:00:68:dd:64').data.dimmed).toBe(true)
  // The blocked cable carries VLAN 30 on paper: highlighted, but dashed.
  const [, blocked] = edge(flow, 'dev:sw1', 'dev:sw2')
  expect([blocked.data.colour, blocked.data.dash]).toEqual(['var(--ns-accent)', '6 5'])
})

test('a link blocked for one VLAN is solid when another VLAN is chosen', () => {
  const partly: Topology = {
    ...TOPOLOGY,
    links: TOPOLOGY.links.map((link) =>
      link.stp_blocked ? { ...link, stp: [link.stp[0], { ...link.stp[1], state: 'forwarding', blocked_at: null }] } : link,
    ),
  }
  const blockedLink = partly.links.find((link) => link.stp_blocked)!

  expect(isBlocked(blockedLink)).toBe(true)
  expect(isBlocked(blockedLink, 20)).toBe(true)
  expect(isBlocked(blockedLink, 30)).toBe(false)
  expect(edge(toFlow(partly, { vlan: 30 }), 'dev:sw1', 'dev:sw2')[1].data.dash).toBeUndefined()
  expect(edge(toFlow(partly, { vlan: 20 }), 'dev:sw1', 'dev:sw2')[1].data.dash).toBe('6 5')
})

test('with no VLAN chosen nothing is dimmed', () => {
  const flow = toFlow(TOPOLOGY)

  expect(flow.nodes.every((item) => !item.data.dimmed)).toBe(true)
  expect(flow.edges.every((item) => item.data.opacity === (item.data.dash ? 0.45 : 1))).toBe(true)
})

test('the management network is only drawn when asked for', () => {
  expect(toFlow(TOPOLOGY).nodes.some((item) => item.id === MANAGEMENT_NODE_ID)).toBe(false)

  const flow = toFlow(TOPOLOGY, { showManagement: true })

  const management = node(flow, MANAGEMENT_NODE_ID)
  expect([management.data.name, management.data.subtitle, management.data.badge]).toEqual(['Management network', '192.168.17.0/24', '1 other host'])
  // To the left of everything else, so its links do not cross the map.
  expect(management.position.x).toBeLessThan(Math.min(...flow.nodes.filter((item) => item.id !== MANAGEMENT_NODE_ID).map((item) => item.position.x)))
  const links = flow.edges.filter((item) => item.source === MANAGEMENT_NODE_ID)
  expect(links.map((item) => [item.target, item.data.targetLabel])).toEqual([
    ['dev:r1', 'Gi0/0'],
    ['dev:r2', 'Gi0/0'],
    ['dev:sw1', 'Et0/0'],
    ['dev:sw2', 'Et0/0'],
  ])
  expect(links.every((item) => item.data.dash === '2 5')).toBe(true)
  expect(links[2].data.details.join(' ')).toContain('VLAN 10')
  // The data topology itself is unchanged.
  expect(flow.edges.length - links.length).toBe(TOPOLOGY.links.length)
})

test('hover details describe the link in words', () => {
  const flow = toFlow(TOPOLOGY)

  expect(edge(flow, 'dev:sw1', 'dev:sw2')[1].data.details).toEqual([
    'SW1 Et0/3  to  SW2 Et0/2',
    'Trunk carrying VLAN 20, 30 · interface up',
    'STP VLAN 20: blocking at SW2 (SW1 Desg, SW2 Altn)',
    'STP VLAN 30: blocking at SW2 (SW1 Desg, SW2 Altn)',
    'Reported by both ends (CDP)',
  ])
  expect(edge(flow, 'dev:r1', 'dev:r2')[0].data.details).toEqual([
    'R1 Gi0/2  to  R2 Gi0/1',
    'Routed link (Layer 3) · interface up',
    'OSPF neighbours: FULL',
    'Reported by both ends (CDP)',
  ])
  const [hostLink] = flow.edges.filter((item) => item.id.includes('host:'))
  expect(hostLink.data.details.slice(0, 2)).toEqual(['SW2 Et0/3  to  10.1.20.10', 'Access port in VLAN 20 · interface up'])
  expect(hostLink.data.details.at(-1)).toBe('MAC address learned on this access port')
})

test('devices that were not reached and unknown neighbours are marked', () => {
  const partial: Topology = {
    ...TOPOLOGY,
    nodes: [
      ...TOPOLOGY.nodes.map((item) => (item.id === 'dev:r2' ? { ...item, collected: false } : item)),
      { ...TOPOLOGY.nodes[0], id: 'nbr:core9', kind: 'unknown', name: 'CORE9', device_id: null, ip: '10.9.9.9', collected: false },
    ],
  }
  const flow = toFlow(partial)

  expect(node(flow, 'dev:r2').data.notCollected).toBe(true)
  expect(node(flow, 'dev:r1').data.notCollected).toBe(false)
  expect([node(flow, 'nbr:core9').data.badge, node(flow, 'nbr:core9').data.deviceId, node(flow, 'nbr:core9').data.notCollected]).toEqual(['not managed', null, false])
  // Unknown neighbours get their own row, between the switches and the hosts.
  expect(node(flow, 'nbr:core9').position.y).toBeGreaterThan(node(flow, 'dev:sw1').position.y)
  expect(node(flow, 'nbr:core9').position.y).toBeLessThan(node(flow, 'host:52:54:00:68:dd:64').position.y)
})

test('summary counts what is on the map', () => {
  expect(summarise(TOPOLOGY)).toBe('2 routers, 2 switches, 1 host, 5 links · 1 blocked by spanning tree, 1 OSPF adjacency')
})

test('devices and links that changed since the baseline are marked', () => {
  const flow = toFlow(TOPOLOGY, { changed: { nodes: ['dev:r1', 'dev:r2'], links: ['dev:r1|Gi0/2--dev:r2|Gi0/1'] } })

  expect(node(flow, 'dev:r1').data.changed).toBe(true)
  expect(node(flow, 'dev:sw1').data.changed).toBe(false)
  const [changed] = edge(flow, 'dev:r1', 'dev:r2')
  expect([changed.data.colour, changed.data.width, changed.data.tag]).toEqual(['var(--ns-warn)', 2.5, 'changed'])
  expect(edge(flow, 'dev:r1', 'dev:sw1')[0].data.colour).toBe('var(--ns-fg-subtle)')
})

test('hovering a node keeps it and its neighbours bright and fades the rest', () => {
  const flow = toFlow(TOPOLOGY, { focus: 'dev:sw2' })
  const near = new Set(['dev:sw2'])
  for (const link of TOPOLOGY.links) {
    if (link.a.node === 'dev:sw2') near.add(link.b.node)
    if (link.b.node === 'dev:sw2') near.add(link.a.node)
  }

  expect(near.has('dev:sw1')).toBe(true)
  expect(near.has('dev:r2')).toBe(false)
  for (const item of flow.nodes) expect([item.id, item.data.faded]).toEqual([item.id, !near.has(item.id)])
  expect(edge(flow, 'dev:r1', 'dev:r2')[0].data.opacity).toBe(0.15)
  expect(edge(flow, 'dev:sw1', 'dev:sw2')[0].data.opacity).toBeGreaterThan(0.15)
})

test('nodes carry their health and selection', () => {
  const flow = toFlow(TOPOLOGY, { health: { 'dev:r1': 'crit', 'dev:sw1': 'ok' }, selected: 'dev:sw1' })

  expect([node(flow, 'dev:r1').data.health, node(flow, 'dev:sw1').data.health, node(flow, 'dev:r2').data.health]).toEqual(['crit', 'ok', null])
  expect([node(flow, 'dev:sw1').data.selected, node(flow, 'dev:r1').data.selected]).toEqual([true, false])
})
