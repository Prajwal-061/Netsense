// Smoke tests for the pages: the real routes, hooks and API client, with
// only fetch replaced. They check behaviour, not how the pages look.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { expect, test } from 'vitest'
import App from './App'
import {
  BACKUP,
  BACKUP_2,
  COLLECT_RESULT,
  DIFF_1_TO_2,
  Failure,
  HEALTH,
  INTERFACES,
  installFakeApi,
  scan,
  SCAN_3,
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

/** The card (section) with the given heading. */
async function card(title: string) {
  const heading = await screen.findByRole('heading', { name: title })
  return within(heading.closest('section')!)
}

// --- Overview --------------------------------------------------------------

test('overview shows device counts, the last scan and the latest change report', async () => {
  installFakeApi()
  open('/')

  const devices = await card('Devices')
  expect(await devices.findByText('Known devices')).toBeInTheDocument()
  expect(devices.getByText('Known devices').previousSibling).toHaveTextContent('4')
  // Three devices were in the latest scan; the fourth was last seen earlier.
  expect(devices.getByText('Up in the last scan').previousSibling).toHaveTextContent('3')
  expect(devices.getByText('network device')).toBeInTheDocument()

  const scanCard = await card('Scan')
  expect(await scanCard.findByRole('link', { name: '#3' })).toBeInTheDocument()
  expect(scanCard.getByText('completed')).toBeInTheDocument()

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

  // The scan finishes on the server. The page finds out by polling.
  const devicesFetchedBefore = api.calls.filter((call) => call === 'GET /devices').length
  api.routes['GET /scans'] = [scan(4, 'completed', { device_count: 4 }), scan(3, 'completed')]
  api.routes['GET /scans/4'] = { ...SCAN_3, ...scan(4, 'completed', { device_count: 4 }) }

  expect(await screen.findByRole('button', { name: 'Start scan' }, { timeout: 6000 })).toBeInTheDocument()
  expect(screen.queryByText(/Scan #4 is running/)).not.toBeInTheDocument()
  await waitFor(() =>
    expect(api.calls.filter((call) => call === 'GET /devices').length).toBeGreaterThan(devicesFetchedBefore),
  )
  expect(await (await card('Scan')).findByRole('link', { name: '#4' })).toBeInTheDocument()
}, 15_000)

test('a scan that is already running is explained, not shown as a crash', async () => {
  installFakeApi({ 'POST /scans': new Failure(409, 'Scan #7 is still running (started 2026-10-07 06:23 UTC).') })
  const user = open('/')

  await user.click(await screen.findByRole('button', { name: 'Start scan' }))

  expect(await screen.findByText(/A scan is already running/)).toHaveTextContent('Scan #7 is still running')
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

// --- Device detail ---------------------------------------------------------

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

  expect(await screen.findByText(/Collected 2 interfaces, 1 VLAN and the MAC table entries as raw text/)).toBeInTheDocument()
  expect(await screen.findByRole('cell', { name: 'Ethernet0/1' })).toBeInTheDocument()
  expect(screen.getByRole('cell', { name: 'administratively down' })).toHaveClass('text-red-700')
  expect(screen.getAllByRole('cell', { name: 'up' })[0]).toHaveClass('text-emerald-700')

  expect(screen.getByText(/first config backup/)).toBeInTheDocument()

  await user.click(screen.getByRole('tab', { name: 'Config backups' }))
  expect(await screen.findByText(/enable secret <redacted>/)).toBeInTheDocument()
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
  expect(await screen.findByText('+vlan 20')).toHaveClass('text-emerald-300')
  expect(screen.getByText('+ switchport access vlan 20')).toHaveClass('text-emerald-300')
  expect(screen.getByText('- switchport access vlan 10')).toHaveClass('text-red-300')
  expect(screen.getByText(/switchport mode access/)).not.toHaveClass('text-emerald-300', 'text-red-300')
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
  expect(await screen.findByText(/vlan 20/)).toBeInTheDocument()
  expect(screen.queryByText('+vlan 20')).not.toBeInTheDocument()
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
