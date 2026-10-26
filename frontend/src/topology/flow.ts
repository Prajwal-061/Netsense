// Turns the API's topology into what React Flow draws: positioned nodes and
// styled edges. Pure functions only (no React, no DOM), so the layout and
// every styling rule can be tested directly.

import type { Topology, TopologyLink, TopologyNode } from '../api'
import type { Health } from '../health'

export const NODE_WIDTH = 168
export const NODE_HEIGHT = 62
const COLUMN_GAP = 96
const ROW_GAP = 128
/** How far apart two cables between the same pair of devices are drawn. */
const PARALLEL_SPREAD = 54

export const MANAGEMENT_NODE_ID = 'management'

export interface FlowOptions {
  /** Highlight where this VLAN is carried. */
  vlan?: number
  showManagement?: boolean
  /** Devices and links to mark as changed (a drift check's findings). */
  changed?: { nodes: string[]; links: string[] }
  /** Health per node id, from the latest drift check. */
  health?: Record<string, Health>
  /** The node under the pointer: it and its neighbours stay bright, the rest fade. */
  focus?: string | null
  /** The node whose details are open. */
  selected?: string | null
}

export interface FlowNodeData extends Record<string, unknown> {
  kind: TopologyNode['kind'] | 'management'
  name: string
  subtitle: string
  badge: string | null
  deviceId: number | null
  notCollected: boolean
  dimmed: boolean
  /** Has drifted from the baseline. */
  changed: boolean
  health: Health | null
  faded: boolean
  selected: boolean
}

export interface FlowNode {
  id: string
  type: 'device'
  position: { x: number; y: number }
  width: number
  height: number
  data: FlowNodeData
}

export interface FlowEdgeData extends Record<string, unknown> {
  sourceLabel: string
  targetLabel: string
  /** Sideways bend, in pixels: 0 for a straight line, +/- for parallel links. */
  offset: number
  colour: string
  width: number
  dash: string | undefined
  opacity: number
  tag: string | null
  /** Healthy and forwarding: drawn with slowly moving dashes. */
  animated: boolean
  /** Lines shown when the pointer is over the link. */
  details: string[]
}

export interface FlowEdge {
  id: string
  type: 'link'
  source: string
  target: string
  sourceHandle: string
  targetHandle: string
  data: FlowEdgeData
}

// Theme tokens, so the map follows the light and dark themes.
export const COLOURS = {
  normal: 'var(--ns-fg-subtle)',
  down: 'var(--ns-crit)',
  ospf: 'var(--ns-accent)',
  vlan: 'var(--ns-accent)',
  changed: 'var(--ns-warn)',
  management: 'var(--ns-line-strong)',
}

// Routers at the top, then switches, then neighbours NetSense could not
// identify, then hosts. Rows that have no nodes take no space.
const TIER: Record<TopologyNode['kind'], number> = { router: 0, switch: 1, unknown: 2, host: 3 }

function nameOf(nodes: Map<string, TopologyNode>, id: string): string {
  return nodes.get(id)?.name ?? id
}

/**
 * Place the nodes in rows by kind. Within a row, each node goes under the
 * average position of the nodes it connects to in the rows above, which keeps
 * links short and mostly uncrossed. Nodes that would overlap are pushed
 * apart, and a row with nothing above it is spread evenly around the centre.
 */
export function layout(nodes: TopologyNode[], links: TopologyLink[]): Map<string, { x: number; y: number }> {
  const neighbours = new Map<string, string[]>()
  for (const link of links) {
    neighbours.set(link.a.node, [...(neighbours.get(link.a.node) ?? []), link.b.node])
    neighbours.set(link.b.node, [...(neighbours.get(link.b.node) ?? []), link.a.node])
  }
  const tiers = [...new Set(nodes.map((node) => TIER[node.kind]))].sort((a, b) => a - b)
  const positions = new Map<string, { x: number; y: number }>()
  const step = NODE_WIDTH + COLUMN_GAP

  tiers.forEach((tier, row) => {
    const members = nodes.filter((node) => TIER[node.kind] === tier)
    // Where each node would like to be: under its already-placed neighbours.
    const wanted = (node: TopologyNode): number | undefined => {
      const placed = (neighbours.get(node.id) ?? []).flatMap((id) => positions.get(id)?.x ?? [])
      return placed.length ? placed.reduce((sum, x) => sum + x, 0) / placed.length : undefined
    }
    const ordered = members
      .map((node) => ({ node, wanted: wanted(node) }))
      .sort(
        (a, b) =>
          (a.wanted ?? Infinity) - (b.wanted ?? Infinity) ||
          a.node.name.localeCompare(b.node.name, undefined, { numeric: true }),
      )

    // Left to right: take the wanted place, but never closer than one step
    // to the node before. A node with no preference goes next in line.
    const xs: number[] = []
    ordered.forEach(({ wanted: x }, column) => {
      const earliest = column === 0 ? -Infinity : xs[column - 1] + step
      xs.push(x === undefined ? (column === 0 ? 0 : earliest) : Math.max(x, earliest))
    })
    // Pushing only ever moves nodes right. Shift the row back so that, on
    // average, nodes sit where they wanted (or, with no preferences at all,
    // so that the row is centred).
    const preferences = ordered.flatMap(({ wanted: x }, column) => (x === undefined ? [] : [x - xs[column]]))
    const shift = preferences.length
      ? preferences.reduce((sum, d) => sum + d, 0) / preferences.length
      : -(xs[0] + xs[xs.length - 1]) / 2 - NODE_WIDTH / 2
    ordered.forEach(({ node }, column) => {
      positions.set(node.id, { x: Math.round(xs[column] + shift), y: row * (NODE_HEIGHT + ROW_GAP) })
    })
  })
  return positions
}

/** Does spanning tree block this link, overall or for one VLAN? */
export function isBlocked(link: TopologyLink, vlan?: number): boolean {
  if (vlan === undefined) return link.stp_blocked
  return link.stp.some((entry) => entry.vlan === vlan && entry.state === 'blocking')
}

export function linkDetails(link: TopologyLink, nodes: Map<string, TopologyNode>): string[] {
  const end = (side: TopologyLink['a']) => [nameOf(nodes, side.node), side.interface].filter(Boolean).join(' ')
  const lines = [`${end(link.a)}  to  ${end(link.b)}`]
  const mode =
    link.mode === 'trunk'
      ? `Trunk carrying VLAN ${link.vlans.join(', ') || 'none'}`
      : link.mode === 'access'
        ? `Access port in VLAN ${link.vlans.join(', ')}`
        : link.mode === 'routed'
          ? 'Routed link (Layer 3)'
          : 'Port mode not known'
  lines.push(`${mode} · interface ${link.status}`)
  for (const entry of link.stp) {
    const where = entry.blocked_at ? ` at ${nameOf(nodes, entry.blocked_at)}` : ''
    const roles = Object.entries(entry.roles)
      .map(([node, role]) => `${nameOf(nodes, node)} ${role}`)
      .join(', ')
    lines.push(`STP VLAN ${entry.vlan}: ${entry.state}${where} (${roles})`)
  }
  if (link.ospf_state) lines.push(`OSPF neighbours: ${link.ospf_state}`)
  if (link.kind === 'cdp') {
    lines.push(
      link.seen_from.length === 2
        ? 'Reported by both ends (CDP)'
        : `Reported by ${nameOf(nodes, link.seen_from[0])} only (CDP)`,
    )
  } else {
    lines.push('MAC address learned on this access port')
  }
  return lines
}

export function toFlow(topology: Topology, options: FlowOptions = {}): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const byId = new Map(topology.nodes.map((node) => [node.id, node]))
  const positions = layout(topology.nodes, topology.links)
  const { vlan, focus } = options

  // Hovering a node: it and its direct neighbours stay bright.
  const near = new Set<string>()
  if (focus) {
    near.add(focus)
    for (const link of topology.links) {
      if (link.a.node === focus) near.add(link.b.node)
      if (link.b.node === focus) near.add(link.a.node)
    }
  }

  // With a VLAN chosen: everything that carries it stays bright.
  const carries = (link: TopologyLink) => vlan !== undefined && link.vlans.includes(vlan)
  const lit = new Set<string>()
  if (vlan !== undefined) {
    for (const link of topology.links.filter(carries)) {
      lit.add(link.a.node)
      lit.add(link.b.node)
    }
  }

  const nodes: FlowNode[] = topology.nodes.map((node) => ({
    id: node.id,
    type: 'device',
    position: positions.get(node.id)!,
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    data: {
      kind: node.kind,
      name: node.name,
      subtitle: node.kind === 'host' ? (node.ip && node.ip !== node.name ? node.ip : (node.vendor ?? '')) : (node.ip ?? node.platform ?? ''),
      badge: node.kind === 'host' ? (node.virtualization ?? null) : node.kind === 'unknown' ? 'not managed' : null,
      deviceId: node.device_id,
      notCollected: node.kind !== 'host' && node.kind !== 'unknown' && !node.collected,
      dimmed: vlan !== undefined && !lit.has(node.id),
      changed: options.changed?.nodes.includes(node.id) ?? false,
      health: options.health?.[node.id] ?? null,
      faded: Boolean(focus) && !near.has(node.id),
      selected: options.selected === node.id,
    },
  }))

  // Number the links between each pair of nodes, to fan parallel ones out.
  const pairKey = (link: TopologyLink) => [link.a.node, link.b.node].sort().join('~')
  const pairCount = new Map<string, number>()
  for (const link of topology.links) pairCount.set(pairKey(link), (pairCount.get(pairKey(link)) ?? 0) + 1)
  const pairSeen = new Map<string, number>()

  const edges: FlowEdge[] = topology.links.map((link) => {
    const key = pairKey(link)
    const index = pairSeen.get(key) ?? 0
    pairSeen.set(key, index + 1)
    const offset = (index - (pairCount.get(key)! - 1) / 2) * PARALLEL_SPREAD

    // Draw from the upper node to the lower one, or left to right in a row.
    const pa = positions.get(link.a.node)!
    const pb = positions.get(link.b.node)!
    const sameRow = pa.y === pb.y
    const aFirst = sameRow ? pa.x <= pb.x : pa.y < pb.y
    const [from, to] = aFirst ? [link.a, link.b] : [link.b, link.a]

    const highlighted = carries(link)
    const changed = options.changed?.links.includes(link.id) ?? false
    const blocked = isBlocked(link, highlighted ? vlan : undefined)
    const colour =
      link.status === 'down'
        ? COLOURS.down
        : changed
          ? COLOURS.changed
          : highlighted
            ? COLOURS.vlan
            : link.ospf
              ? COLOURS.ospf
              : COLOURS.normal
    return {
      id: link.id,
      type: 'link',
      source: from.node,
      target: to.node,
      sourceHandle: sameRow ? 'right' : 'bottom',
      targetHandle: sameRow ? 'left' : 'top',
      data: {
        sourceLabel: from.interface ?? '',
        targetLabel: to.interface ?? '',
        offset,
        colour,
        width: changed ? 2.5 : highlighted || link.ospf ? 2.25 : link.kind === 'host' ? 1.25 : 1.5,
        dash: blocked ? '6 5' : undefined,
        opacity:
          (focus && link.a.node !== focus && link.b.node !== focus) || (vlan !== undefined && !highlighted)
            ? 0.15
            : blocked
              ? 0.45
              : 1,
        tag: link.status === 'down' ? 'down' : changed ? 'changed' : blocked ? 'STP blocked' : link.ospf ? 'OSPF' : null,
        animated: link.status === 'up' && !blocked && !changed && link.kind === 'cdp',
        details: linkDetails(link, byId),
      },
    }
  })

  if (options.showManagement && topology.management.members.length > 0) {
    const xs = [...positions.values()].map((p) => p.x)
    const ys = [...positions.values()].map((p) => p.y)
    const others = topology.management.hosts.length
    nodes.push({
      id: MANAGEMENT_NODE_ID,
      type: 'device',
      position: { x: Math.min(...xs) - NODE_WIDTH - 150, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      data: {
        kind: 'management',
        name: 'Management network',
        subtitle: topology.management.network ?? '',
        badge: others ? `${others} other host${others === 1 ? '' : 's'}` : null,
        deviceId: null,
        notCollected: false,
        dimmed: false,
        changed: false,
        health: null,
        faded: false,
        selected: false,
      },
    })
    for (const member of topology.management.members) {
      if (!byId.has(member.node)) continue
      edges.push({
        id: `management--${member.node}`,
        type: 'link',
        source: MANAGEMENT_NODE_ID,
        target: member.node,
        sourceHandle: 'right',
        targetHandle: 'left',
        data: {
          sourceLabel: '',
          targetLabel: member.interface ?? '',
          offset: 0,
          colour: COLOURS.management,
          width: 1.5,
          dash: '2 5',
          opacity: 1,
          tag: null,
          animated: false,
          details: [
            `${nameOf(byId, member.node)} ${member.interface ?? ''} on the management network`,
            `Address ${member.ip}${member.vlan ? ` · VLAN ${member.vlan}` : ''}`,
            'Out-of-band: how NetSense reaches the device, not a CDP link',
          ],
        },
      })
    }
  }
  return { nodes, edges }
}

/** One-line summary of a topology, for above the map. */
export function summarise(topology: Topology): string {
  const count = (kind: TopologyNode['kind']) => topology.nodes.filter((node) => node.kind === kind).length
  const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`
  const parts = [plural(count('router'), 'router'), plural(count('switch'), 'switch', 'switches'), plural(count('host'), 'host')]
  if (count('unknown')) parts.push(plural(count('unknown'), 'unknown neighbour'))
  parts.push(plural(topology.links.length, 'link'))
  const blocked = topology.links.filter((link) => link.stp_blocked).length
  const ospf = topology.links.filter((link) => link.ospf).length
  const down = topology.links.filter((link) => link.status === 'down').length
  const notes = [
    blocked ? `${blocked} blocked by spanning tree` : '',
    ospf ? plural(ospf, 'OSPF adjacency', 'OSPF adjacencies') : '',
    down ? `${down} down` : '',
  ].filter(Boolean)
  return parts.join(', ') + (notes.length ? ` · ${notes.join(', ')}` : '')
}
