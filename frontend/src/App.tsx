import { Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import { EmptyState } from './components/ui'
import Collections from './pages/Collections'
import DeviceDetail from './pages/DeviceDetail'
import Devices from './pages/Devices'
import NetworkHealth from './pages/NetworkHealth'
import Overview from './pages/Overview'
import ScanDetail from './pages/ScanDetail'
import Scans from './pages/Scans'
import TopologyPage from './pages/Topology'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="network-health" element={<NetworkHealth />} />
        <Route path="devices" element={<Devices />} />
        <Route path="devices/:id" element={<DeviceDetail />} />
        <Route path="collections" element={<Collections />} />
        <Route path="topology" element={<TopologyPage />} />
        <Route path="scans" element={<Scans />} />
        <Route path="scans/:id" element={<ScanDetail />} />
        <Route path="*" element={<EmptyState>Page not found.</EmptyState>} />
      </Route>
    </Routes>
  )
}
