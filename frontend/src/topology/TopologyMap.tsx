import { Controls, ReactFlow, useNodesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useEffect, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Topology } from '../api'
import DeviceNode from './DeviceNode'
import { toFlow } from './flow'
import type { FlowNode, FlowOptions } from './flow'
import LinkEdge from './LinkEdge'

// Defined once, outside the component: React Flow re-mounts every node if
// these objects change identity between renders.
const NODE_TYPES = { device: DeviceNode }
const EDGE_TYPES = { link: LinkEdge }

/**
 * The interactive map of one topology. Nodes can be dragged; a dragged node
 * keeps its place while only the options change, and the automatic layout
 * returns for another collection. Clicking a device opens its page.
 */
export default function TopologyMap({
  topology,
  options,
  className = 'h-[min(68vh,620px)] min-h-[400px]',
}: {
  topology: Topology
  options: FlowOptions
  className?: string
}) {
  const navigate = useNavigate()
  const flow = useMemo(() => toFlow(topology, options), [topology, options])
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
    <div className={`${className} p-2`} data-testid="topology-map">
      <ReactFlow
        nodes={nodes}
        edges={flow.edges}
        onNodesChange={onNodesChange}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodeClick={(_, node) => {
          if (node.data.deviceId !== null) void navigate(`/devices/${node.data.deviceId}`)
        }}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.3}
        maxZoom={1.8}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
