// A stand-in for the NetSense API: replaces fetch with a lookup table, so
// the real pages, hooks and API client run with no backend and no network.
// The sample data lives in fixtures.ts.

import { vi } from 'vitest'
import { DEVICES, HEALTH, ME, SCAN_3, scan } from './fixtures'

export * from './fixtures'

/** A route reply that makes fetch fail for that request only, as a CORS block does. */
export const BLOCKED = Symbol('blocked by the browser')

/** A reply: a JSON body (status 200), [status, body], or a function returning either. */
type Reply = unknown | (() => unknown)

export class Failure {
  status: number
  detail: string
  constructor(status: number, detail: string) {
    this.status = status
    this.detail = detail
  }
}

export interface FakeApi {
  /** Replies by "METHOD /path". Change entries mid-test to change the API's state. */
  routes: Record<string, Reply>
  /** Every request made, as "METHOD /path", in order. */
  calls: string[]
  /** When true, every request fails as if the server were down. */
  offline: boolean
  /** The JSON body of the last request to each "METHOD /path". */
  bodies: Record<string, unknown>
}

export function installFakeApi(overrides: Record<string, Reply> = {}): FakeApi {
  const api: FakeApi = {
    offline: false,
    calls: [],
    bodies: {},
    routes: {
      'GET /health': HEALTH,
      'GET /auth/me': ME,
      'GET /scans': [scan(3, 'completed'), scan(2, 'completed', { device_count: 2 }), scan(1, 'completed')],
      'GET /scans/3': SCAN_3,
      'GET /collections': [],
      'GET /devices': DEVICES,
      ...Object.fromEntries(DEVICES.map((item) => [`GET /devices/${item.id}`, item])),
      ...overrides,
    },
  }

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const { pathname, search } = new URL(url)
    const key = `${init?.method ?? 'GET'} ${pathname}${search}`
    api.calls.push(key)
    if (typeof init?.body === 'string') api.bodies[key] = JSON.parse(init.body)
    // The session cookie only travels when a request asks for it.
    if (init?.credentials !== 'include') throw new Error(`${key} was sent without credentials: 'include'`)
    if (api.offline) throw new TypeError('Failed to fetch')

    const route = api.routes[key]
    const reply = typeof route === 'function' ? (route as () => unknown)() : route
    if (reply === BLOCKED) throw new TypeError('Failed to fetch')
    if (reply === undefined) return json(404, { detail: `No fake route for ${key}` })
    if (reply instanceof Failure) return json(reply.status, { detail: reply.detail })
    return json(200, reply)
  })
  return api
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
