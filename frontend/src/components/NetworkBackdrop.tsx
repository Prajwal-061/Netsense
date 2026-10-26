// A quiet network-graph pattern for the login page background: nodes on a
// jittered grid, each linked to its nearest neighbours, a few of them
// pulsing. Deterministic (seeded), so it looks the same on every load.

const WIDTH = 1440
const HEIGHT = 900

function random(seed: number) {
  // mulberry32: a tiny seeded generator, so the pattern never changes.
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function graph() {
  const next = random(7)
  const nodes: { x: number; y: number; hub: boolean }[] = []
  for (let gx = 0; gx <= 12; gx++) {
    for (let gy = 0; gy <= 7; gy++) {
      if (next() < 0.28) continue
      nodes.push({ x: gx * 120 + (next() - 0.5) * 70, y: gy * 125 + (next() - 0.5) * 70, hub: next() < 0.09 })
    }
  }
  const links = new Set<string>()
  nodes.forEach((node, i) => {
    const near = nodes
      .map((other, j) => ({ j, d: (other.x - node.x) ** 2 + (other.y - node.y) ** 2 }))
      .filter(({ j }) => j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 2)
    near.forEach(({ j }) => links.add(i < j ? `${i}-${j}` : `${j}-${i}`))
  })
  return { nodes, links: [...links].map((key) => key.split('-').map(Number) as [number, number]) }
}

const GRAPH = graph()

export default function NetworkBackdrop() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <radialGradient id="backdrop-fade" cx="50%" cy="50%" r="60%">
          <stop offset="0%" stopColor="var(--ns-canvas)" stopOpacity="0.96" />
          <stop offset="55%" stopColor="var(--ns-canvas)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--ns-canvas)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g stroke="var(--ns-line-strong)" strokeWidth="1" strokeOpacity="0.7">
        {GRAPH.links.map(([a, b]) => (
          <line key={`${a}-${b}`} x1={GRAPH.nodes[a].x} y1={GRAPH.nodes[a].y} x2={GRAPH.nodes[b].x} y2={GRAPH.nodes[b].y} />
        ))}
      </g>
      {GRAPH.nodes.map((node, index) => (
        <g key={index}>
          {node.hub && (
            <circle cx={node.x} cy={node.y} r="9" fill="none" stroke="var(--ns-accent)" strokeOpacity="0.5" className="backdrop-pulse" style={{ animationDelay: `${(index % 5) * 0.9}s` }} />
          )}
          <circle cx={node.x} cy={node.y} r={node.hub ? 3.5 : 2.5} fill={node.hub ? 'var(--ns-accent)' : 'var(--ns-line-strong)'} />
        </g>
      ))}
      <rect width={WIDTH} height={HEIGHT} fill="url(#backdrop-fade)" />
    </svg>
  )
}
