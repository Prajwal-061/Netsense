import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useNodesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Topology } from '../api'
import type { Health } from '../health'
import DeviceNode from './DeviceNode'
import { toFlow } from './flow'
import type { FlowNode, FlowNodeData, FlowOptions } from './flow'
import LinkEdge from './LinkEdge'

// Defined once, outside the component: React Flow re-mounts every node if
// these objects change identity between renders.
const NODE_TYPES = { device: DeviceNode }
const EDGE_TYPES = { link: LinkEdge }

const MINIMAP_COLOUR: Record<Health, string> = { ok: 'var(--ns-ok)', warn: 'var(--ns-warn)', crit: 'var(--ns-crit)' }

/**
 * The interactive map of one topology. Nodes can be dragged; a dragged node
 * keeps its place while only the options change, and the automatic layout
 * returns for another collection. Hovering a node lights up its neighbours.
 * Clicking a node calls `onSelect`, or without it opens the device's page.
 */
export default function TopologyMap({
  topology,
  options,
  className = 'h-[min(68vh,620px)] min-h-[400px]',
  onSelect,
  compact = false,
}: {
  topology: Topology
  options: FlowOptions
  className?: string
  onSelect?: (nodeId: string | null) => void
  /** A small preview: no minimap or controls. */
  compact?: boolean
}) {
  const navigate = useNavigate()
  const [focus, setFocus] = useState<string | null>(null)
  const flow = useMemo(() => toFlow(topology, { ...options, focus }), [topology, options, focus])
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([])
  const laidOutFor = useRef<number>(undefined)
  useEffect(() => {
    const sameCollection = laidOutFor.current === topology.collection_id
    laidOutFor.current = topology.collection_id
    setNodes((current) => {
      const moved = new Map(sameCollection ? current.map((node) => [node.id, node.position]) : [])
      return flow.nodes.map((node) => ({ ...node, position: moved.get(node.id) ?? node.position }))
    })
  }, [flow.nodes, topology.collection_id, setNodes])

  return (
    <div className={className} data-testid="topology-map">
      <ReactFlow
        nodes={nodes}
        edges={flow.edges}
        onNodesChange={onNodesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={(_, node) => {
          if (onSelect) onSelect(node.id)
          else if (node.data.deviceId !== null) void navigate(`/devices/${node.data.deviceId}`)
        }}
        onPaneClick={() => onSelect?.(null)}
        onNodeMouseEnter={(_, node) => setFocus(node.id)}
        onNodeMouseLeave={() => setFocus(null)}
        fitView
        fitViewOptions={{ padding: compact ? 0.08 : 0.18, maxZoom: compact ? 1 : 1.3 }}
        minZoom={0.3}
        maxZoom={1.8}
        nodesConnectable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--ns-line-strong)" />
        {!compact && (
          <>
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              className="max-md:!hidden"
              nodeBorderRadius={3}
              nodeColor={(node) => {
                const health = (node.data as FlowNodeData).health
                return health ? MINIMAP_COLOUR[health] : 'var(--ns-line-strong)'
              }}
            />
          </>
        )}
      </ReactFlow>
    </div>
  )
}
