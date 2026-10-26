// Smoke tests for the pages: the real routes, hooks and API client, with
// only fetch replaced. They check behaviour, not how the pages look.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { expect, test } from 'vitest'
import App from './App'
import {
  BLOCKED,
  BACKUP,
  ME,
  BACKUP_2,
  COLLECT_RESULT,
  collectionRun,
  DEVICES,
  DIFF_1_TO_2,
  Failure,
  HEALTH,
  INTERFACES,
  installFakeApi,
  ROUTER,
  scan,
  SCAN_3,
  BASELINE,
  DRIFT_REPORT,
  driftCheck,
  SWITCH as SWITCH_DEVICE,
  TOPOLOGY,
} from './test/fakeApi'

function open(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return userEvent.setup()
}

/** The lines of every code-view table with this name, as "+text", "-text", " text" (diffs) or "text". */
function codeLines(name: string, scope: HTMLElement = document.body) {
  const sign: Record<string, string> = { add: '+', del: '-', ctx: ' ' }
  return within(scope)
    .getAllByRole('table', { name })
    .flatMap((table) => within(table).getAllByRole('row'))
    .filter((row) => (row as HTMLTableRowElement).cells.length > 1)
    .map((row) => (row.dataset.kind ? sign[row.dataset.kind] : '') + row.lastElementChild!.textContent)
}

/** The card (section) with the given heading. */
async function card(title: string) {
  const heading = await screen.findByRole('heading', { name: title })
  return within(heading.closest('section')!)
}

// --- Overview --------------------------------------------------------------

test('overview shows device counts, the last scan and the latest change report', async () => {
  installFakeApi()
  open('/')

  const kpis = within(await screen.findByRole('region', { name: 'Key figures' }))
  await waitFor(() => expect(kpis.getByText('Known devices').nextElementSibling!.firstElementChild).toHaveTextContent(/^4$/))
  // Three devices were in the latest scan; the fourth was last seen earlier.
  expect(kpis.getByText('3 up in the last scan')).toBeInTheDocument()
  // The sparkline: devices found by each completed scan, oldest first.
  expect(kpis.getByRole('img', { name: /^Devices found per scan: / })).toBeInTheDocument()
  expect((await card('Devices')).getByText('network device')).toBeInTheDocument()

  const events = await card('Recent events')
  expect(await events.findByRole('link', { name: /Scan #3 found \d+ devices/ })).toHaveAttribute('href', '/scans/3')

  const changes = await card('Latest changes')
  const added = within((await changes.findByText('New devices')).closest('div')!.parentElement!)
  expect(added.getByText('192.168.17.128')).toBeInTheDocument()
  const missing = within(changes.getByText('No longer seen').closest('div')!.parentElement!)
  expect(missing.getByText('192.168.17.9')).toBeInTheDocument()
  const moved = within(changes.getByText('IP address changed').closest('div')!.parentElement!)
  expect(moved.getByText(/192\.168\.17\.77/)).toHaveTextContent('192.168.17.77 to 192.168.17.1')
})

test('starting a scan shows progress, then refreshes everything when it finishes', async () => {
  const api = installFakeApi({ 'POST /scans': scan(4, 'running') })
  const user = open('/')

  await user.click(await screen.findByRole('button', { name: 'Start scan' }))
  // From here the API reports the new scan as running.
  api.routes['GET /scans'] = [scan(4, 'running'), scan(3, 'completed')]

  expect(await screen.findByText(/Scan #4 is running/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Start scan' })).not.toBeInTheDocument()

  // The live console follows the scan's steps.
  api.routes['GET /scans/4/progress'] = { scan_id: 4, status: 'running', step: 'services', step_started_at: new Date().toISOString(), hosts_found: 3 }
  const done = await screen.findByText('3 devices answered', {}, { timeout: 3000 })
  expect(done.closest('li')).toHaveTextContent('Done:ARP discovery')
  expect(screen.getByText('Service scan (Nmap)').closest('li')).toHaveTextContent('Running:')
  expect(screen.getByText('Classify and save').closest('li')).toHaveTextContent('Waiting:')

  // The scan finishes on the server. The page finds out by polling.
  const devicesFetchedBefore = api.calls.filter((call) => call === 'GET /devices').length
  api.routes['GET /scans'] = [scan(4, 'completed', { device_count: 4 }), scan(3, 'completed')]
  api.routes['GET /scans/4'] = { ...SCAN_3, ...scan(4, 'completed', { device_count: 4 }) }

  expect(await screen.findByRole('button', { name: 'Start scan' }, { timeout: 6000 })).toBeInTheDocument()
  expect(screen.queryByText(/Scan #4 is running/)).not.toBeInTheDocument()
  await waitFor(() =>
    expect(api.calls.filter((call) => call === 'GET /devices').length).toBeGreaterThan(devicesFetchedBefore),
  )
  expect(await (await card('Recent events')).findByRole('link', { name: /Scan #4 found 4 devices/ })).toBeInTheDocument()
}, 15_000)

test('a scan that is already running is explained, not shown as a crash', async () => {
  installFakeApi({ 'POST /scans': new Failure(409, 'Scan #7 is still running (started 2026-10-07 06:23 UTC).') })
  const user = open('/')

  await user.click(await screen.findByRole('button', { name: 'Start scan' }))

  expect((await screen.findByText(/A scan is already running/)).closest('[role=alert]')).toHaveTextContent('Scan #7 is still running')
  expect(screen.queryByText('Request failed')).not.toBeInTheDocument()
})

test('a failed last scan and missing raw-socket privilege are both reported', async () => {
  installFakeApi({
    'GET /health': { ...HEALTH, raw_sockets: false },
    'GET /scans': [
      scan(4, 'failed', { error: 'ARP scanning needs root or the CAP_NET_RAW capability.' }),
      scan(3, 'completed'),
    ],
  })
  open('/')

  expect(await screen.findByText(/The last scan/)).toHaveTextContent('#4')
  expect(screen.getByText('ARP scanning needs root or the CAP_NET_RAW capability.')).toBeInTheDocument()
  expect(await screen.findByText(/cannot open raw sockets/)).toBeInTheDocument()
  // The change report still comes from the last scan that completed.
  expect(await (await card('Latest changes')).findByText('New devices')).toBeInTheDocument()
})

test('an unreachable API gives a clear message instead of empty pages', async () => {
  const api = installFakeApi()
  api.offline = true
  open('/')

  const alerts = await screen.findAllByRole('alert')
  expect(alerts[0]).toHaveTextContent('API not reachable')
  expect(alerts[0]).toHaveTextContent('Cannot reach the NetSense API at http://192.168.17.132:8000')
  expect(screen.getByText('API offline')).toBeInTheDocument()
})

// --- Devices ---------------------------------------------------------------

test('devices table lists every device and filters by search and type', async () => {
  installFakeApi()
  const user = open('/devices')

  expect(await screen.findByRole('link', { name: '192.168.17.10' })).toBeInTheDocument()
  expect(screen.getAllByRole('row')).toHaveLength(5) // header + 4 devices
  expect(screen.getByText('4 of 4')).toBeInTheDocument()
  // Sorted by IP numerically: .1, .9, .10, .128
  const ips = screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent)
  expect(ips).toEqual(['192.168.17.1', '192.168.17.9', '192.168.17.10', '192.168.17.128'])
  expect(within(screen.getAllByRole('row')[2]).getByText('Not seen')).toBeInTheDocument()
  expect(within(screen.getAllByRole('row')[3]).getByText('Up')).toBeInTheDocument()

  await user.type(screen.getByRole('searchbox'), 'nginx')
  expect(screen.getByText('1 of 4')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '192.168.17.128' })).toBeInTheDocument()

  await user.clear(screen.getByRole('searchbox'))
  await user.selectOptions(screen.getByRole('combobox'), 'network device')
  expect(screen.getByText('1 of 4')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '192.168.17.10' })).toBeInTheDocument()

  await user.type(screen.getByRole('searchbox'), 'zzz')
  expect(screen.getByText('No devices match the search and filter.')).toBeInTheDocument()
})

test('devices table shows virtualization as its own badge next to the type', async () => {
  installFakeApi({ 'GET /devices': [...DEVICES, ROUTER] })
  const user = open('/devices')

  // The IOSv router: a network device that happens to run on QEMU/KVM.
  const router = (await screen.findByRole('link', { name: '192.168.17.3' })).closest('tr')!
  expect(within(router).getByText('network device')).toBeInTheDocument()
  expect(within(router).getByText('QEMU/KVM', { selector: 'span[title^="Virtual"]' })).toHaveAttribute(
    'title',
    'Virtual: the MAC address prefix belongs to QEMU/KVM',
  )
  // The IOL switch has the same type and no virtualization badge.
  const iolSwitch = screen.getByRole('link', { name: '192.168.17.10' }).closest('tr')!
  expect(within(iolSwitch).getByText('network device')).toBeInTheDocument()
  expect(iolSwitch.querySelector('span[title^="Virtual"]')).toBeNull()
  // Virtual is not a type: it is absent from the type filter, but searchable.
  const types = within(screen.getByRole('combobox')).getAllByRole('option').map((o) => o.textContent)
  expect(types).toEqual(['All types', 'network device', 'server', 'unknown'])
  await user.type(screen.getByRole('searchbox'), 'qemu')
  expect(screen.getByText('1 of 5')).toBeInTheDocument()
})

// --- Device detail ---------------------------------------------------------

test('device page shows virtualization and whether the type is a guess or confirmed', async () => {
  const api = installFakeApi({
    'GET /devices/5': ROUTER,
    'POST /devices/5/collect': { ...COLLECT_RESULT, device_id: 5, device_type: 'router' },
  })
  const user = open('/devices/5')

  expect(await screen.findByText('guess from scan')).toBeInTheDocument()
  expect(screen.getAllByTitle('Virtual: the MAC address prefix belongs to QEMU/KVM')).toHaveLength(2)
  expect(screen.getByText('from the MAC prefix')).toBeInTheDocument()

  // After a successful login the API reports the confirmed type.
  api.routes['GET /devices/5'] = {
    ...ROUTER,
    device_type: 'router',
    type_source: 'collected',
    type_reason: "confirmed by login: show version reports software image 'VIOS-ADVENTERPRISEK9-M', with no switch image and no VLAN table",
  }
  await user.click(screen.getByRole('button', { name: 'Collect from device' }))

  expect(await screen.findByText(/Confirmed as a router\./)).toBeInTheDocument()
  expect(await screen.findByText('confirmed by login')).toBeInTheDocument()
  expect(screen.getByText(/VIOS-ADVENTERPRISEK9-M/)).toBeInTheDocument()
  expect(screen.queryByText('guess from scan')).not.toBeInTheDocument()
  // A confirmed router keeps its collect button and tabs.
  expect(screen.getByRole('button', { name: 'Collect from device' })).toBeInTheDocument()
  // Router tabs, and none of the switch ones.
  const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
  expect(tabs).toEqual(['Interfaces', 'CDP neighbors', 'ARP', 'Routing table', 'OSPF neighbors', 'OSPF interfaces', 'Config backups'])
})

test('router tabs show OSPF neighbours and the routing table from the API', async () => {
  const api = installFakeApi({
    'GET /devices/5': { ...ROUTER, device_type: 'router', type_source: 'collected' },
    'GET /devices/5/ospf-neighbors': {
      device_id: 5,
      collected_at: '2026-10-08T07:30:00Z',
      data: [{ neighbor_id: '2.2.2.2', priority: '1', state: 'FULL/DR', dead_time: '00:00:38', ip_address: '10.0.12.2', interface: 'GigabitEthernet0/2' }],
    },
    'GET /devices/5/routes': {
      device_id: 5,
      collected_at: '2026-10-08T07:30:00Z',
      data: [{ protocol: 'O', network: '10.2.1.1', prefix_length: '32', nexthop_ip: '10.0.12.2', nexthop_if: 'GigabitEthernet0/2' }],
    },
  })
  const user = open('/devices/5')

  await user.click(await screen.findByRole('tab', { name: 'OSPF neighbors' }))
  expect(await screen.findByRole('cell', { name: '2.2.2.2' })).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: 'FULL/DR' })).toHaveClass('text-ok-fg')

  await user.click(screen.getByRole('tab', { name: 'Routing table' }))
  expect(await screen.findByRole('cell', { name: '10.2.1.1' })).toBeInTheDocument()
  expect(api.calls).toContain('GET /devices/5/routes')
  expect(screen.queryByRole('tab', { name: 'Trunks' })).not.toBeInTheDocument()
})

test('switch tabs show trunks and spanning tree, with blocked ports in red', async () => {
  installFakeApi({
    'GET /devices/2': { ...SWITCH_DEVICE, device_type: 'switch', type_source: 'collected' },
    'GET /devices/2/trunks': {
      device_id: 2,
      collected_at: '2026-10-08T07:30:00Z',
      data: [
        { interface: 'Et0/1', mode: 'on', encapsulation: '802.1q', status: 'trunking', native_vlan: '1', allowed_vlans: '20,30', active_vlans: '20,30', forwarding_vlans: '20,30' },
        { interface: 'Et0/2', mode: 'on', encapsulation: '802.1q', status: 'trunking', native_vlan: '1', allowed_vlans: '20,30', active_vlans: '20,30', forwarding_vlans: 'none' },
      ],
    },
    'GET /devices/2/spanning-tree': {
      device_id: 2,
      collected_at: '2026-10-08T07:30:00Z',
      data: [
        { vlan_id: '20', interface: 'Et0/1', role: 'Root', status: 'FWD', cost: '100' },
        { vlan_id: '20', interface: 'Et0/2', role: 'Altn', status: 'BLK', cost: '100' },
      ],
    },
  })
  const user = open('/devices/2')

  const tabs = (await screen.findAllByRole('tab')).map((tab) => tab.textContent)
  expect(tabs).toEqual(['Interfaces', 'CDP neighbors', 'ARP', 'VLANs', 'Trunks', 'Spanning tree', 'MAC table', 'Config backups'])

  await user.click(screen.getByRole('tab', { name: 'Trunks' }))
  expect(await screen.findByRole('cell', { name: 'none' })).toHaveClass('text-crit-fg')
  await user.click(screen.getByRole('tab', { name: 'Spanning tree' }))
  expect(await screen.findByRole('cell', { name: 'BLK' })).toHaveClass('text-crit-fg')
  expect(screen.getByRole('cell', { name: 'FWD' })).toHaveClass('text-ok-fg')
})

test('a switch page starts with its front panel: state, VLAN or T per port, details on hover', async () => {
  const at = '2026-10-08T07:30:00Z'
  installFakeApi({
    'GET /devices/2': { ...SWITCH_DEVICE, device_type: 'switch', type_source: 'collected' },
    'GET /devices/2/interfaces': {
      device_id: 2,
      collected_at: at,
      data: [
        { interface: 'Ethernet0/0', ip_address: 'unassigned', status: 'up', proto: 'up' },
        { interface: 'Ethernet0/1', ip_address: 'unassigned', status: 'up', proto: 'up' },
        { interface: 'Ethernet0/2', ip_address: 'unassigned', status: 'administratively down', proto: 'down' },
        { interface: 'Vlan10', ip_address: '192.168.17.10', status: 'up', proto: 'up' },
      ],
    },
    'GET /devices/2/vlans': { device_id: 2, collected_at: at, data: [{ vlan_id: '10', vlan_name: 'MGMT', interfaces: ['Et0/0'] }] },
    'GET /devices/2/trunks': { device_id: 2, collected_at: at, data: [{ interface: 'Et0/1', allowed_vlans: '20,30' }] },
    'GET /devices/2/cdp-neighbors': { device_id: 2, collected_at: at, data: [{ neighbor_name: 'R1', neighbor_interface: 'GigabitEthernet0/1', local_interface: 'Ethernet0/1' }] },
    'GET /devices/2/spanning-tree': { device_id: 2, collected_at: at, data: [{ vlan_id: '20', interface: 'Et0/1', role: 'Desg', status: 'FWD' }] },
    'GET /devices/2/mac-table': { device_id: 2, collected_at: at, data: [{ destination_address: 'aabb.cc00.0120', vlan_id: '20', destination_port: ['Et0/1'] }] },
  })
  const user = open('/devices/2')

  const panel = within(await screen.findByRole('group', { name: /front panel/ }))
  const ports = await panel.findAllByRole('button')
  expect(ports.map((port) => [port.dataset.port, port.dataset.state, port.textContent])).toEqual([
    ['Et0/0', 'up', '100/0'],
    ['Et0/1', 'up', 'T0/1'],
    ['Et0/2', 'admin-down', '0/2'],
  ])
  expect(screen.getByText('Vl10')).toBeInTheDocument()

  await user.hover(ports[1])
  const card = within(await screen.findByRole('tooltip'))
  expect(card.getByText('Ethernet0/1')).toBeInTheDocument()
  expect(card.getByText('VLANs 20, 30')).toBeInTheDocument()
  expect(card.getByText('R1 Gi0/1')).toBeInTheDocument()
  expect(card.getByText('1')).toBeInTheDocument() // MACs
  expect(card.getByText('VLAN 20 Desg FWD')).toBeInTheDocument()
  // The table is still there, below.
  expect(screen.getByRole('cell', { name: 'Ethernet0/1' })).toBeInTheDocument()
})

// --- Collections -----------------------------------------------------------

test('collect from all devices shows each device as it finishes, including a failure', async () => {
  const api = installFakeApi({
    // Like the real server: from the moment of the POST, the run exists.
    'POST /collections': () => {
      api.routes['GET /collections'] = [collectionRun('started')]
      api.routes['GET /collections/7'] = collectionRun('started')
      return collectionRun('started')
    },
  })
  const user = open('/collections')

  expect(await screen.findByText('No collection has been run yet.')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Collect from all devices' }))

  // Straight away: all four devices listed as being collected.
  expect(await screen.findByText('Collection #7 is running')).toBeInTheDocument()
  expect(screen.getByText('0 of 4 devices done')).toBeInTheDocument()
  expect(await screen.findAllByText('collecting')).toHaveLength(4)
  expect(screen.queryByRole('button', { name: 'Collect from all devices' })).not.toBeInTheDocument()

  // Two devices have answered: one succeeded, one failed. The others go on.
  api.routes['GET /collections'] = [collectionRun('halfway')]
  api.routes['GET /collections/7'] = collectionRun('halfway')
  expect(await screen.findByText(/2 of 4 devices done/, {}, { timeout: 6000 })).toHaveTextContent('(1 failed)')
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
  expect(screen.getAllByText('collecting')).toHaveLength(2)
  const r2 = screen.getByText('192.168.17.4').closest('tr')!
  expect(within(r2).getByText('failed')).toBeInTheDocument()
  expect(within(r2).getByText('Authentication failed: 192.168.17.4 rejected the login.')).toBeInTheDocument()
  const r1 = screen.getByText('R1').closest('tr')!
  expect(within(r1).getByText('success')).toBeInTheDocument()
  expect(within(r1).getByText('router')).toBeInTheDocument()
  expect(within(r1).getByText(/legacy SSH/)).toBeInTheDocument()

  // Finished: the button is back and everything else is refreshed.
  const devicesFetched = api.calls.filter((call) => call === 'GET /devices').length
  api.routes['GET /collections'] = [collectionRun('finished')]
  api.routes['GET /collections/7'] = collectionRun('finished')
  expect(await screen.findByRole('button', { name: 'Collect from all devices' }, { timeout: 6000 })).toBeInTheDocument()
  // The list and the run's details are fetched separately; wait for both.
  await waitFor(() => expect(screen.queryAllByText('collecting')).toHaveLength(0), { timeout: 6000 })
  const sw1 = screen.getByText('SW1').closest('tr')!
  expect(within(sw1).getByText('changed')).toBeInTheDocument()
  expect(within(sw1).getByText('3 kinds of data')).toHaveAttribute('title', expect.stringContaining('trunks: 3'))
  const history = within((await card('History')).getByRole('table'))
  expect(history.getByText('completed')).toBeInTheDocument()
  expect(devicesFetched).toBe(0) // this page does not list devices itself
}, 20_000)

test('starting a collection with no network devices or one already running is explained', async () => {
  const api = installFakeApi({
    'POST /collections': new Failure(404, 'No device is classified as a router, switch or network device yet. Run a scan first; devices are recognised by their SSH banner.'),
  })
  const user = open('/collections')

  await user.click(await screen.findByRole('button', { name: 'Collect from all devices' }))
  expect(await screen.findByText(/Run a scan first/)).toBeInTheDocument()
  expect(screen.queryByText('Request failed')).not.toBeInTheDocument()

  api.routes['POST /collections'] = new Failure(409, 'Collection #7 is still running (started 2026-10-08 07:30 UTC).')
  await user.click(screen.getByRole('button', { name: 'Collect from all devices' }))
  expect(await screen.findByText(/A collection is already running/)).toHaveTextContent('Collection #7 is still running')
})

test('network device: collect, then interfaces and the config backup are shown', async () => {
  const api = installFakeApi({ 'POST /devices/2/collect': COLLECT_RESULT })
  const user = open('/devices/2')

  expect(await screen.findByText("ssh banner on port 22 is 'Cisco SSH 1.25', OS IOS")).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: '22/tcp' })).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: 'Cisco SSH' })).toBeInTheDocument()
  // Before any collection the API answers 404, shown as an empty state.
  expect(await screen.findByText(/Nothing has been collected from this device yet/)).toBeInTheDocument()

  api.routes['GET /devices/2/interfaces'] = INTERFACES
  api.routes['GET /devices/2/configs'] = [BACKUP]
  api.routes['GET /devices/2/configs/1'] = { ...BACKUP, config: 'hostname SW1\nenable secret <redacted>\nend' }
  await user.click(screen.getByRole('button', { name: 'Collect from device' }))

  expect(await screen.findByText(/Collected 8 kinds of data\. Confirmed as a switch\./)).toBeInTheDocument()
  expect(await screen.findByRole('cell', { name: 'Ethernet0/1' })).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: 'administratively down' })).toHaveClass('text-crit-fg')
  expect(screen.getAllByRole('cell', { name: 'up' })[0]).toHaveClass('text-ok-fg')

  expect(screen.getByText(/first config backup/)).toBeInTheDocument()

  await user.click(screen.getByRole('tab', { name: 'Config backups' }))
  await waitFor(() => expect(codeLines('Running config')).toEqual(['hostname SW1', 'enable secret <redacted>', 'end']))
  expect(screen.getByText(/3 lines/)).toBeInTheDocument()
  // One backup: marked as the first, no "changed" badge, nothing to compare.
  expect(screen.getByText('first backup')).toBeInTheDocument()
  expect(screen.queryByText('Config changed since last backup')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Compare backups' }))
  expect(screen.getByText(/There is only one backup so far/)).toBeInTheDocument()
})

test('config tab marks changed backups and shows a coloured diff of two backups', async () => {
  const api = installFakeApi({
    'GET /devices/2/configs': [BACKUP_2, BACKUP],
    'GET /devices/2/configs/2': { ...BACKUP_2, config: 'hostname SW1\nvlan 20\nend' },
    'GET /devices/2/configs/diff?from_id=1&to_id=2': DIFF_1_TO_2,
    'GET /devices/2/configs/diff?from_id=2&to_id=2': { ...DIFF_1_TO_2, from_backup: BACKUP_2, changed: false, diff: '' },
  })
  const user = open('/devices/2')
  await user.click(await screen.findByRole('tab', { name: 'Config backups' }))

  // The newest backup differs from the one before it.
  expect(await screen.findByText('Config changed since last backup')).toBeInTheDocument()
  const list = within(screen.getByRole('list', { name: 'Config backups' }))
  expect(list.getByText('changed +4 / -1 lines')).toBeInTheDocument()
  expect(list.getByText('first backup')).toBeInTheDocument()
  expect(list.getByText('current')).toBeInTheDocument()

  // "Show what changed" compares the previous backup with the newest.
  await user.click(screen.getByRole('button', { name: 'Show what changed' }))
  await waitFor(() => expect(codeLines('Config diff')).toContain('+vlan 20'))
  const lines = codeLines('Config diff')
  expect(lines).toContain('+ switchport access vlan 20')
  expect(lines).toContain('- switchport access vlan 10')
  expect(lines).toContain('  switchport mode access')
  // Added and removed rows are tinted; context is not.
  const rows = within(screen.getByRole('table', { name: 'Config diff' })).getAllByRole('row')
  expect(rows.find((row) => row.dataset.kind === 'add')).toHaveClass('bg-ok-soft')
  expect(rows.find((row) => row.dataset.kind === 'del')).toHaveClass('bg-crit-soft')
  // Side by side: the removed line faces the line that replaced it.
  await user.click(screen.getByRole('button', { name: 'Side by side' }))
  const pair = within(screen.getByRole('table', { name: 'Config diff' }))
    .getAllByRole('row')
    .find((row) => row.textContent?.includes('switchport access vlan 10'))!
  expect(pair).toHaveTextContent(/switchport access vlan 10.*switchport access vlan 20/)
  expect(screen.getByText('+4 added')).toBeInTheDocument()
  expect(screen.getByText('-1 removed')).toBeInTheDocument()
  expect(screen.getByLabelText('From (older)')).toHaveValue('1')
  expect(screen.getByLabelText('To (newer)')).toHaveValue('2')
  expect(api.calls).toContain('GET /devices/2/configs/diff?from_id=1&to_id=2')

  // Picking other backups asks the API for that pair.
  await user.selectOptions(screen.getByLabelText('From (older)'), '2')
  expect(await screen.findByText('The same backup is selected on both sides.')).toBeInTheDocument()

  // Clicking a backup in the list goes back to viewing its text.
  await user.click(list.getByText('changed +4 / -1 lines'))
  await waitFor(() => expect(codeLines('Running config')).toContain('vlan 20'))
  expect(screen.queryByRole('table', { name: 'Config diff' })).not.toBeInTheDocument()
})

test('the compare request carries the two chosen backup ids as numbers', async () => {
  // Regression for "Input should be a valid integer": the dashboard must ask
  // for /configs/diff?from_id=<id>&to_id=<id>, older backup first.
  const BACKUP_3 = { ...BACKUP_2, id: 3, collected_at: '2026-10-08T10:00:00Z' }
  const api = installFakeApi({
    'GET /devices/2/configs': [BACKUP_3, BACKUP_2, BACKUP],
    'GET /devices/2/configs/3': { ...BACKUP_3, config: 'end' },
    'GET /devices/2/configs/diff?from_id=2&to_id=3': { ...DIFF_1_TO_2, from_backup: BACKUP_2, to_backup: BACKUP_3 },
    'GET /devices/2/configs/diff?from_id=1&to_id=3': DIFF_1_TO_2,
  })
  const user = open('/devices/2')
  await user.click(await screen.findByRole('tab', { name: 'Config backups' }))
  await user.click(await screen.findByRole('button', { name: 'Compare backups' }))

  // Default: the previous backup (#2) against the newest (#3).
  await waitFor(() => expect(codeLines('Config diff')).toContain('+vlan 20'))
  await user.selectOptions(screen.getByLabelText('From (older)'), '1')
  await waitFor(() => expect(api.calls).toContain('GET /devices/2/configs/diff?from_id=1&to_id=3'))

  const diffCalls = api.calls.filter((call) => call.includes('/configs/diff'))
  expect(diffCalls).toEqual([
    'GET /devices/2/configs/diff?from_id=2&to_id=3',
    'GET /devices/2/configs/diff?from_id=1&to_id=3',
  ])
})

test('a backend older than the dashboard is reported, and nothing is guessed', async () => {
  // Regression: against a backend that had not been restarted, the health
  // answer has no api_revision and backups have no "changed" field. The
  // dashboard showed "no change" for a backup that had changed.
  const { api_revision: _removed, ...oldHealth } = HEALTH
  const oldBackup = ({ changed: _c, lines_added: _a, lines_removed: _r, ...rest }: typeof BACKUP_2) => rest
  installFakeApi({
    'GET /health': oldHealth,
    'GET /devices/2/configs': [oldBackup(BACKUP_2), oldBackup(BACKUP)],
    'GET /devices/2/configs/2': { ...oldBackup(BACKUP_2), config: 'end' },
  })
  const user = open('/devices/2')

  const banner = await screen.findByText('The backend is running older code than this dashboard')
  expect(banner.parentElement).toHaveTextContent(/restarted/)

  await user.click(await screen.findByRole('tab', { name: 'Config backups' }))
  const list = within(await screen.findByRole('list', { name: 'Config backups' }))
  expect(list.getAllByRole('button')).toHaveLength(2)
  expect(list.queryByText('no change')).not.toBeInTheDocument()
  expect(list.queryByText('first backup')).not.toBeInTheDocument()
  expect(screen.queryByText('Config changed since last backup')).not.toBeInTheDocument()
})

test('an up-to-date backend shows no version warning', async () => {
  installFakeApi()
  open('/')

  expect(await screen.findByText('API connected')).toBeInTheDocument()
  expect(screen.queryByText(/older code than this dashboard/)).not.toBeInTheDocument()
})

test('collecting a changed config says so', async () => {
  installFakeApi({
    'POST /devices/2/collect': { ...COLLECT_RESULT, first_backup: false, config_changed: true, config_backup: BACKUP_2 },
  })
  const user = open('/devices/2')

  await user.click(await screen.findByRole('button', { name: 'Collect from device' }))

  expect(
    await screen.findByText(/The running config has changed since the last backup \(\+4 \/ -1 lines\)/),
  ).toBeInTheDocument()
})

test('a collection that fails shows the reason from the API', async () => {
  installFakeApi({
    'POST /devices/2/collect': new Failure(502, "Authentication failed: 192.168.17.10 rejected the login for user 'netsense'."),
  })
  const user = open('/devices/2')

  await user.click(await screen.findByRole('button', { name: 'Collect from device' }))

  expect(await screen.findByText(/rejected the login for user 'netsense'/)).toBeInTheDocument()
})

test('devices that are not network devices have no collect button', async () => {
  installFakeApi()
  open('/devices/3')

  expect(await screen.findByRole('cell', { name: 'nginx' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Collect from device' })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab')).not.toBeInTheDocument()
})

test('an unknown device shows the API error', async () => {
  installFakeApi({ 'GET /devices/999': new Failure(404, 'Device 999 not found.') })
  open('/devices/999')

  expect(await screen.findByText('Device 999 not found.')).toBeInTheDocument()
})

// --- Scans -----------------------------------------------------------------

test('scan history lists scans and a scan page shows its results and changes', async () => {
  installFakeApi({
    'GET /scans': [scan(4, 'failed', { error: 'Nmap failed: boom' }), scan(3, 'completed')],
  })
  const user = open('/scans')

  expect(await screen.findByText('Nmap failed: boom')).toBeInTheDocument()
  expect(screen.getAllByRole('row')).toHaveLength(3)

  await user.click(screen.getByRole('link', { name: '#3' }))

  expect(await screen.findByRole('heading', { name: /Scan #3/ })).toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'Devices seen (3)' })).toBeInTheDocument()
  expect((await card('Changes')).getByText('No longer seen')).toBeInTheDocument()
  expect(screen.getByText("ssh banner on port 22 is 'Cisco SSH 1.25', OS IOS")).toBeInTheDocument()
})

test('an interrupted scan is shown as interrupted in amber, never as completed', async () => {
  const interrupted = scan(15, 'interrupted', { error: 'Interrupted: the program stopped before the scan finished.', device_count: 6 })
  installFakeApi({
    'GET /scans': [interrupted, scan(3, 'completed')],
    'GET /scans/15': { ...interrupted, results: [], changes: null },
  })
  const user = open('/scans')

  const row = (await screen.findByRole('link', { name: '#15' })).closest('tr')!
  expect(within(row).getByText('interrupted')).toBeInTheDocument()
  expect(within(row).queryByText('completed')).not.toBeInTheDocument()
  expect(row.querySelector('.bg-warn')).not.toBeNull()
  // Its device count is not shown: only a completed scan's results count.
  expect(within(row).getAllByRole('cell').at(-1)).toHaveTextContent('-')

  await user.click(screen.getByRole('link', { name: '#15' }))
  expect(await screen.findByText(/This scan was interrupted/)).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: /Devices seen/ })).not.toBeInTheDocument()
})

test('an interrupted last scan is reported on the overview as a warning', async () => {
  installFakeApi({
    'GET /scans': [scan(15, 'interrupted', { error: 'Interrupted: the program stopped before the scan finished.' }), scan(3, 'completed')],
  })
  open('/')

  const bar = (await screen.findByText(/The last scan/)).closest('[role="alert"]')!
  expect(bar).toHaveTextContent('#15) was interrupted')
  expect(bar).toHaveClass('border-l-warn')
})

// --- Topology --------------------------------------------------------------
// jsdom has no layout engine, so React Flow cannot position handles and the
// links themselves are not drawn here. Their rules are tested in
// src/topology/flow.test.ts; these tests cover the page around the map.

test('topology page draws every device with its icon, and the controls', async () => {
  installFakeApi({ 'GET /topology': TOPOLOGY, 'GET /collections': [collectionRun('finished')] })
  open('/topology')

  const map = within(await screen.findByTestId('topology-map'))
  for (const name of ['R1', 'R2', 'SW1', 'SW2', '10.1.20.10']) {
    expect(await map.findByText(name)).toBeInTheDocument()
  }
  expect(map.getAllByRole('img', { name: 'router' })).toHaveLength(2)
  expect(map.getAllByRole('img', { name: 'switch' })).toHaveLength(2)
  expect(map.getAllByRole('img', { name: 'host' })).toHaveLength(1)
  expect(map.queryByText('Management network')).not.toBeInTheDocument()

  expect(screen.getByText('2 routers, 2 switches, 1 host, 5 links · 1 blocked by spanning tree, 1 OSPF adjacency')).toBeInTheDocument()
  expect(screen.getByText(/Collection #7,/)).toBeInTheDocument()
  const vlans = within(screen.getByLabelText('Highlight VLAN')).getAllByRole('option').map((o) => o.textContent)
  expect(vlans).toEqual(['All VLANs', 'VLAN 20 USERS', 'VLAN 30 SERVERS'])
  expect(within(screen.getByRole('list', { name: 'Legend' })).getByText('Blocked by spanning tree')).toBeInTheDocument()
})

test('topology controls: VLAN highlight, management network and choosing a collection', async () => {
  const api = installFakeApi({
    'GET /topology': TOPOLOGY,
    'GET /topology?collection_id=7': { ...TOPOLOGY, nodes: TOPOLOGY.nodes.slice(0, 4), links: TOPOLOGY.links.slice(0, 4) },
    'GET /collections': [collectionRun('finished')],
  })
  const user = open('/topology')
  const map = within(await screen.findByTestId('topology-map'))
  await map.findByText('R2')

  await user.selectOptions(screen.getByLabelText('Highlight VLAN'), '20')
  expect(screen.getByText(/carrying VLAN 20 are highlighted/)).toBeInTheDocument()
  // R2 is only reached over the routed link, which carries no VLAN.
  await waitFor(() => expect(map.getByText('R2').closest('[data-node]')).toHaveClass('opacity-25'))
  expect(map.getByText('SW2').closest('[data-node]')).not.toHaveClass('opacity-25')

  await user.click(screen.getByLabelText('Show management network'))
  expect(await map.findByText('Management network')).toBeInTheDocument()
  expect(map.getByText('192.168.17.0/24')).toBeInTheDocument()
  expect(map.getByText('1 other host')).toBeInTheDocument()

  await user.selectOptions(screen.getByLabelText('Collection'), '7')
  await waitFor(() => expect(api.calls).toContain('GET /topology?collection_id=7'))
  await waitFor(() => expect(map.queryByText('10.1.20.10')).not.toBeInTheDocument())
  expect(screen.getByText(/2 routers, 2 switches, 0 hosts, 4 links/)).toBeInTheDocument()
})

test('clicking a device on the map shows its details, with its health and links, and a link to its page', async () => {
  installFakeApi({
    'GET /topology': TOPOLOGY,
    'GET /devices/2': SWITCH_DEVICE,
    'GET /drift-checks': [driftCheck('completed')],
    'GET /drift-checks/3': driftCheck('completed'),
  })
  const user = open('/topology')

  // A bare click event: the simulated mouse-down of user.click() lacks the
  // "view" every real browser event has, which React Flow's drag code reads.
  const map = within(await screen.findByTestId('topology-map'))
  await waitFor(() => expect(map.getByText('R1').closest('[data-node]')).toHaveAttribute('data-health', 'crit'))
  fireEvent.click(map.getByText('SW1'))

  const panel = within(await screen.findByRole('complementary', { name: 'SW1 details' }))
  const rows = panel.getAllByRole('listitem').map((row) => row.textContent)
  expect(rows).toContain('Et0/1R1 Gi0/1trunk')
  expect(rows).toContain('Et0/3SW2 Et0/2STP blocked')
  await user.click(panel.getByRole('link', { name: 'Open device page' }))
  expect(await screen.findByRole('heading', { name: 'Classification' })).toBeInTheDocument()
  expect(screen.getByText('aa:bb:cc:80:01:00')).toBeInTheDocument()
})

test('hosts known from ARP but not located are listed under the map with the reason', async () => {
  installFakeApi({
    'GET /topology': {
      ...TOPOLOGY,
      nodes: TOPOLOGY.nodes.slice(0, 4),
      links: TOPOLOGY.links.slice(0, 4),
      unplaced_hosts: [{ ip: '10.1.20.10', mac: '52:54:00:68:dd:64', vendor: 'QEMU/KVM', seen_by: 'dev:r1', interface: 'Gi0/1.20' }],
    },
  })
  open('/topology')

  const note = (await screen.findByText('Known hosts that could not be placed on the map')).parentElement!
  expect(note).toHaveTextContent('10.1.20.10 (52:54:00:68:dd:64, QEMU/KVM), in the ARP table of R1 on Gi0/1.20')
  expect(note).toHaveTextContent(/forgets a MAC address after about five minutes/)
  expect(within(screen.getByTestId('topology-map')).queryByText('10.1.20.10')).not.toBeInTheDocument()
})

test('topology page explains when there is no collection yet', async () => {
  installFakeApi({ 'GET /topology': new Failure(404, 'No collection has finished yet. Collect from all devices first; the topology is built from what they report.') })
  open('/topology')

  expect(await screen.findByText(/There is no topology yet/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Collect from all devices' })).toHaveAttribute('href', '/collections')
  expect(screen.queryByText('Request failed')).not.toBeInTheDocument()
})

// --- Network health --------------------------------------------------------

test('network health: choosing and setting the baseline', async () => {
  const api = installFakeApi({
    'GET /baseline': new Failure(404, 'No baseline has been set yet.'),
    'GET /drift-checks': [],
    'GET /collections': [collectionRun('finished'), { ...collectionRun('finished'), id: 6, started_at: '2026-10-09T07:07:42Z' }],
    'PUT /baseline': { ...BASELINE, collection_id: 6, note: 'Healthy lab' },
  })
  const user = open('/network-health')

  expect(await screen.findByText(/No baseline yet/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Run drift check' })).toBeDisabled()
  expect(screen.getByText('Set a baseline first.')).toBeInTheDocument()

  // Any finished collection can be chosen, not only the latest.
  await user.selectOptions(screen.getByLabelText('Collection'), '6')
  await user.type(screen.getByLabelText('Note (optional)'), 'Healthy lab')
  await user.click(screen.getByRole('button', { name: 'Set as baseline' }))

  expect(await screen.findByText('Collection #6')).toBeInTheDocument()
  expect(api.bodies['PUT /baseline']).toEqual({ collection_id: 6, note: 'Healthy lab' })
  expect(screen.getByText('"Healthy lab"')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Run drift check' })).toBeEnabled()
})

test('network health: a drift check runs, then shows causes, findings by device and diffs', async () => {
  const api = installFakeApi({
    'GET /baseline': BASELINE,
    'GET /drift-checks': [],
    'GET /topology?collection_id=7': TOPOLOGY,
    'POST /drift-checks': () => {
      api.routes['GET /drift-checks'] = [driftCheck('running')]
      api.routes['GET /drift-checks/3'] = driftCheck('running')
      api.routes['GET /collections/7'] = collectionRun('halfway')
      return driftCheck('running')
    },
  })
  const user = open('/network-health')

  expect(await screen.findByText('Collection #3')).toBeInTheDocument()
  expect(screen.getByText('"Healthy lab, 9 October"')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Run drift check' }))
  expect(await screen.findByText(/Drift check #3 is running: collecting, 2 of 4 devices done/)).toBeInTheDocument()

  api.routes['GET /drift-checks'] = [driftCheck('completed')]
  api.routes['GET /drift-checks/3'] = driftCheck('completed')

  // Counts by severity.
  const summary = await screen.findByRole('heading', { name: 'Check #3' }, { timeout: 6000 })
  const tiles = within(summary.closest('section')!)
  expect(tiles.getByText('Critical').previousSibling).toHaveTextContent(String(DRIFT_REPORT.summary.critical))
  expect(tiles.getByText('Warning').previousSibling).toHaveTextContent(String(DRIFT_REPORT.summary.warning))
  expect(tiles.getByText(/Collection #7 compared with baseline collection #3/)).toBeInTheDocument()

  // Probable causes, each with what it led to.
  const causes = within(screen.getByRole('heading', { name: 'Probable causes' }).closest('section')!)
  const ospf = causes.getByText(/R1 configuration changed 'network 10.0.12.0 0.0.0.3 area 0'/).closest('li')!
  expect(within(ospf).getByText('R2 lost OSPF neighbor R1 (10.0.12.1) on Gi0/1.')).toBeInTheDocument()
  expect(within(ospf).getByText(/R1 lost 2 routes learned via 10.0.12.2/)).toBeInTheDocument()
  expect(causes.getByText(/cannot prove them/)).toBeInTheDocument()

  // Findings grouped by device, with their probable cause linked.
  const r2 = within(screen.getByRole('link', { name: 'R2' }).closest('section')!)
  // The message is also the 'Probable cause' link of R2's lost routes: take the finding itself.
  const lost = r2.getByText('R2 lost OSPF neighbor R1 (10.0.12.1) on Gi0/1.', { selector: 'p' }).closest('li')!
  expect(r2.getByText(/R2 lost 2 routes learned via 10.0.12.1/).closest('li')).toHaveTextContent('Probable cause: R2 lost OSPF neighbor R1')
  const causeLink = within(lost).getByRole('link', { name: /R1 configuration changed/ })
  const causeId = DRIFT_REPORT.findings.find((f) => f.message.startsWith('R1 configuration'))!.id
  expect(causeLink).toHaveAttribute('href', `#finding-${causeId}`)
  expect(document.getElementById(`finding-${causeId}`)).toHaveTextContent('R1 configuration changed')

  // Expandable config diffs: per change, and the whole device.
  const sw2 = within(screen.getByRole('link', { name: 'SW2' }).closest('section')!)
  const change = sw2.getByText("SW2 configuration added 'spanning-tree vlan 20 priority 0'.", { selector: 'p' }).closest('li')!
  await user.click(within(change).getByText('Show the configuration change'))
  expect(codeLines('Config diff', change)).toContain('+spanning-tree vlan 20 priority 0')
  const full = sw2.getByText('Full configuration diff for SW2')
  await user.click(full)
  expect(codeLines('Config diff', full.closest('details')!)).toContain('- switchport access vlan 20')

  // The map of the checked collection, with the changed devices outlined.
  const map = within(screen.getByTestId('topology-map'))
  expect(await map.findByText('R1')).toBeInTheDocument()
  expect(map.getByText('R1').closest('[data-node]')).toHaveAttribute('data-changed')
  expect(screen.getByText('Changed since the baseline')).toBeInTheDocument()
}, 20_000)

test('network health: a check with no drift says so plainly', async () => {
  const clean = {
    ...DRIFT_REPORT,
    summary: { critical: 0, warning: 0, info: 0, devices_compared: 4, devices_with_drift: 0 },
    findings: [],
    chains: [],
    config_diffs: {},
    highlight: { nodes: [], links: [] },
    devices: DRIFT_REPORT.devices.map((device) => ({ ...device, status: 'unchanged' as const, findings: [] })),
  }
  installFakeApi({
    'GET /baseline': BASELINE,
    'GET /drift-checks': [driftCheck('completed', clean)],
    'GET /drift-checks/3': driftCheck('completed', clean),
  })
  open('/network-health')

  expect(await screen.findByText('No drift: the network matches the baseline.')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Probable causes' })).not.toBeInTheDocument()
  expect(screen.queryByTestId('topology-map')).not.toBeInTheDocument()
})

test('network health: a refused drift check is explained', async () => {
  installFakeApi({
    'GET /baseline': BASELINE,
    'GET /drift-checks': [],
    'POST /drift-checks': new Failure(409, 'Collection #7 is still running (started 2026-10-24 09:00 UTC).'),
  })
  const user = open('/network-health')

  await user.click(await screen.findByRole('button', { name: 'Run drift check' }))

  expect(await screen.findByText(/Collection #7 is still running/)).toBeInTheDocument()
  expect(screen.queryByText('Request failed')).not.toBeInTheDocument()
})

// --- error messages ----------------------------------------------------------

test('an error answer from the API is shown as such, with the server\'s message', async () => {
  installFakeApi({
    'GET /baseline': new Failure(404, 'No baseline has been set yet.'),
    'GET /drift-checks': [],
    'GET /collections': [collectionRun('finished')],
    'PUT /baseline': new Failure(500, 'Internal server error (RuntimeError) while handling PUT /baseline. The full error is in the backend\'s log.'),
  })
  const user = open('/network-health')

  await user.click(await screen.findByRole('button', { name: 'Set as baseline' }))

  const alert = await screen.findByText(/Internal server error \(RuntimeError\) while handling PUT \/baseline/)
  expect(alert.closest('[role="alert"]')).toHaveTextContent('The API answered with an error (HTTP 500)')
  expect(screen.queryByText('API not reachable')).not.toBeInTheDocument()
})

test('a request the browser blocks while the API is up is not called unreachable', async () => {
  // Regression: PUT /baseline was refused by CORS, and the page said "API not reachable".
  installFakeApi({
    'GET /baseline': new Failure(404, 'No baseline has been set yet.'),
    'GET /drift-checks': [],
    'GET /collections': [collectionRun('finished')],
    'PUT /baseline': BLOCKED,
  })
  const user = open('/network-health')

  await user.click(await screen.findByRole('button', { name: 'Set as baseline' }))

  const alert = (await screen.findByText('Request blocked by the browser')).closest('[role="alert"]')!
  expect(alert).toHaveTextContent('is running, but the browser blocked its answer to PUT /baseline')
  expect(alert).toHaveTextContent('CORS')
  expect(screen.queryByText('API not reachable')).not.toBeInTheDocument()
})

// --- logging in --------------------------------------------------------------

test('without a session every page sends you to the login page, and back after logging in', async () => {
  const api = installFakeApi({ 'GET /auth/me': new Failure(401, 'Not logged in.') })
  const user = open('/devices')

  expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument()
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument()

  // A wrong password shows the server's answer.
  api.routes['POST /auth/login'] = new Failure(401, 'Wrong username or password.')
  await user.type(screen.getByLabelText('Password'), 'not it')
  await user.click(screen.getByRole('button', { name: 'Log in' }))
  expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument()

  // The right one goes back to the page that was asked for.
  api.routes['POST /auth/login'] = ME
  api.routes['GET /auth/me'] = ME
  await user.clear(screen.getByLabelText('Password'))
  await user.type(screen.getByLabelText('Password'), 'correct horse battery')
  await user.click(screen.getByRole('button', { name: 'Log in' }))

  expect(await screen.findByRole('heading', { name: 'Devices' })).toBeInTheDocument()
  expect(api.bodies['POST /auth/login']).toEqual({ username: 'admin', password: 'correct horse battery' })
  expect(screen.getByText('admin')).toBeInTheDocument()
})

test('too many failed logins are explained', async () => {
  installFakeApi({
    'GET /auth/me': new Failure(401, 'Not logged in.'),
    'POST /auth/login': new Failure(429, 'Too many failed logins. Try again in 15 minute(s).'),
  })
  const user = open('/login')

  await user.type(await screen.findByLabelText('Password'), 'guess')
  await user.click(screen.getByRole('button', { name: 'Log in' }))

  expect(await screen.findByText('Too many failed logins. Try again in 15 minute(s).')).toBeInTheDocument()
})

test('a session that expires while the dashboard is open leads to the login page', async () => {
  const api = installFakeApi()
  const user = open('/')
  expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()

  // The session ends on the server: every request is now refused.
  api.routes['GET /auth/me'] = new Failure(401, 'Your session has expired. Log in again.')
  api.routes['POST /scans'] = new Failure(401, 'Your session has expired. Log in again.')
  await user.click(screen.getByRole('button', { name: 'Start scan' }))

  expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument()
})

test('logging out ends the session and shows the login page', async () => {
  const api = installFakeApi({
    // Like the server: after logout the session no longer exists.
    'POST /auth/logout': () => {
      api.routes['GET /auth/me'] = new Failure(401, 'Not logged in.')
      return {}
    },
  })
  const user = open('/devices')

  await user.click(await screen.findByRole('button', { name: 'User menu' }))
  await user.click(screen.getByRole('menuitem', { name: 'Log out' }))

  expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument()
  expect(api.calls).toContain('POST /auth/logout')
})

// --- command palette -----------------------------------------------------------

test('Ctrl+K finds a device by hostname, IP or MAC and opens it', async () => {
  installFakeApi({ 'GET /topology': TOPOLOGY, 'GET /devices/2': SWITCH_DEVICE })
  const user = open('/')
  await screen.findByRole('heading', { name: 'Overview' })

  await user.keyboard('{Control>}k{/Control}')
  const search = await screen.findByRole('combobox')
  // By hostname (known from the topology).
  await user.type(search, 'sw1')
  expect(await screen.findByRole('option', { name: /SW1/ })).toHaveAttribute('aria-selected', 'true')
  // By MAC in Cisco notation.
  await user.clear(search)
  await user.type(search, 'aabb.cc80.0100')
  const options = screen.getAllByRole('option')
  expect(options).toHaveLength(1)
  expect(options[0]).toHaveTextContent('192.168.17.10')

  await user.keyboard('{Enter}')
  expect(await screen.findByRole('heading', { name: 'Classification' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('the palette also jumps to pages, and Escape closes it', async () => {
  installFakeApi({ 'GET /topology': TOPOLOGY })
  const user = open('/')
  await user.click(await screen.findByRole('button', { name: 'Search' }))

  await user.type(screen.getByRole('combobox'), 'net')
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  await user.keyboard('{Control>}k{/Control}')
  await user.type(await screen.findByRole('combobox'), 'collec')
  await user.keyboard('{ArrowDown}{ArrowUp}{Enter}')
  expect(await screen.findByRole('heading', { name: 'Collections' })).toBeInTheDocument()
})
