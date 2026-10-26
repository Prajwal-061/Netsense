// The NetSense API, faked inside the browser: Playwright answers every request
// to FAKE_API_URL from the same sample data the page tests use.

import type { Page } from '@playwright/test'
import { FAKE_API_URL } from './settings'
import {
  BACKUP,
  BACKUP_2,
  BASELINE,
  DEVICES,
  DIFF_1_TO_2,
  HEALTH,
  INTERFACES,
  ME,
  ROUTER,
  SCAN_3,
  SWITCH,
  SWITCH_CONFIG,
  TOPOLOGY,
  collectionRun,
  driftCheck,
  scan,
} from '../src/test/fixtures'

const RUN = collectionRun('finished')
const { results: _results, ...RUN_SUMMARY } = RUN
const CHECK = driftCheck('completed')
const { report: _report, ...CHECK_SUMMARY } = CHECK
// The switch as confirmed by a login, so its page shows the switch tabs.
const COLLECTED_SWITCH = { ...SWITCH, device_type: 'switch', type_source: 'collected' }

export const SCANS = [
  scan(5, 'failed', {
    error: 'Raw sockets are not available: the API needs CAP_NET_RAW to send ARP requests.',
  }),
  scan(4, 'interrupted', { error: 'Interrupted: the program stopped before the scan finished.' }),
  scan(3, 'completed'),
  scan(2, 'completed', { device_count: 2 }),
  scan(1, 'completed'),
]

/** A reply with an HTTP error status and the API's { detail } body. */
export class HttpError {
  status: number
  detail: string
  constructor(status: number, detail: string) {
    this.status = status
    this.detail = detail
  }
}

/** Replies by "METHOD /path?query". */
export const ROUTES: Record<string, unknown> = {
  'GET /health': HEALTH,
  'GET /auth/me': ME,
  'GET /scans': SCANS,
  'GET /scans/3': SCAN_3,
  'GET /scans/5': { ...SCANS[0], results: [], changes: null },
  'GET /scans/4': { ...SCANS[1], results: [], changes: null },
  'GET /devices': [...DEVICES, ROUTER],
  ...Object.fromEntries([...DEVICES, ROUTER].map((item) => [`GET /devices/${item.id}`, item])),
  'GET /devices/2': COLLECTED_SWITCH,
  'GET /devices/2/interfaces': INTERFACES,
  'GET /devices/2/configs': [BACKUP_2, BACKUP],
  'GET /devices/2/configs/2': { ...BACKUP_2, config: SWITCH_CONFIG },
  'GET /devices/2/configs/1': { ...BACKUP, config: SWITCH_CONFIG },
  'GET /devices/2/configs/diff?from_id=1&to_id=2': DIFF_1_TO_2,
  'GET /collections': [RUN_SUMMARY],
  'GET /collections/7': RUN,
  'GET /topology': TOPOLOGY,
  'GET /topology?collection_id=7': TOPOLOGY,
  'GET /baseline': BASELINE,
  'GET /drift-checks': [CHECK_SUMMARY],
  'GET /drift-checks/3': CHECK,
}

/**
 * Answers the dashboard's API requests on this page. Returns the requests
 * that had no reply, so a test can fail on them instead of on a blank page.
 */
export async function fakeApi(page: Page, routes: Record<string, unknown> = ROUTES): Promise<string[]> {
  const missing: string[] = []
  await page.route(`${FAKE_API_URL}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const cors = {
      'Access-Control-Allow-Origin': (await request.headerValue('origin')) ?? '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    }
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const key = `${request.method()} ${url.pathname}${url.search}`
    const reply = routes[key]
    if (reply === undefined) {
      // Collected data the sample does not have: the API answers 404 for those too.
      if (!/^GET \/devices\/\d+\/[a-z-]+$/.test(key)) missing.push(key)
      return route.fulfill({ status: 404, headers: cors, json: { detail: `No fake route for ${key}` } })
    }
    if (reply instanceof HttpError) return route.fulfill({ status: reply.status, headers: cors, json: { detail: reply.detail } })
    if (reply === null) return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: 'null' })
    return route.fulfill({ status: 200, headers: cors, json: reply })
  })
  return missing
}
