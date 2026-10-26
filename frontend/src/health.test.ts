import { expect, test } from 'vitest'
import { deviceHealth, networkScore, nodeHealth, scoreHealth } from './health'
import { DRIFT_REPORT } from './test/fakeApi'

test('device scores come from their findings', () => {
  const devices = Object.fromEntries(deviceHealth(DRIFT_REPORT).map((device) => [device.name, device]))

  // R1: its OSPF change and what followed (3 critical, 1 warning).
  expect([devices.R1.critical, devices.R1.warning, devices.R1.score, devices.R1.health]).toEqual([3, 1, 15, 'crit'])
  // SW1: only warnings.
  expect(devices.SW1.health).toBe('warn')
  expect(devices.SW1.score).toBe(100 - 10 * devices.SW1.warning)
})

test('the network score is the average device score', () => {
  const scores = deviceHealth(DRIFT_REPORT).map((device) => device.score)

  expect(networkScore(DRIFT_REPORT)).toBe(Math.round(scores.reduce((a, b) => a + b, 0) / scores.length))
})

test('an unreachable device scores 0 and a clean report scores 100', () => {
  const unreachable = {
    ...DRIFT_REPORT,
    devices: DRIFT_REPORT.devices.map((device) => (device.name === 'R2' ? { ...device, status: 'unreachable' as const } : device)),
  }
  expect(deviceHealth(unreachable).find((device) => device.name === 'R2')).toMatchObject({ score: 0, health: 'crit' })

  const clean = { ...DRIFT_REPORT, findings: [], devices: DRIFT_REPORT.devices.map((device) => ({ ...device, findings: [] })) }
  expect(networkScore(clean)).toBe(100)
  expect(Object.values(nodeHealth(clean))).toEqual(['ok', 'ok', 'ok', 'ok'])
})

test('node health is keyed by topology node id', () => {
  expect(nodeHealth(DRIFT_REPORT)).toMatchObject({ 'dev:r1': 'crit', 'dev:sw1': 'warn' })
  expect(nodeHealth(null)).toEqual({})
  expect([scoreHealth(95), scoreHealth(70), scoreHealth(20)]).toEqual(['ok', 'warn', 'crit'])
})
