// Health scores from a drift check report. Pure functions, used by the
// overview, the topology map and the network health page.
//
// A device starts at 100 and loses 25 per critical finding, 10 per warning
// and 2 per info finding, down to 0. A device that could not be collected
// from scores 0. The network score is the average over the devices compared.
// It is a summary for the eye, not a measurement: the findings say what is
// actually wrong.

import type { DriftReport, Severity } from './api'

export type Health = 'ok' | 'warn' | 'crit'

export const PENALTY: Record<Severity, number> = { critical: 25, warning: 10, info: 2 }

export interface DeviceHealth {
  name: string
  deviceId: number | null
  score: number
  health: Health
  critical: number
  warning: number
  info: number
}

export function healthOf(critical: number, warning: number): Health {
  return critical ? 'crit' : warning ? 'warn' : 'ok'
}

export function deviceHealth(report: DriftReport): DeviceHealth[] {
  const byId = new Map(report.findings.map((finding) => [finding.id, finding]))
  return report.devices
    .filter((device) => device.status !== 'not in baseline')
    .map((device) => {
      const findings = device.findings.map((id) => byId.get(id)!).filter(Boolean)
      const count = (severity: Severity) => findings.filter((finding) => finding.severity === severity).length
      const critical = count('critical')
      const warning = count('warning')
      const info = count('info')
      const penalty = critical * PENALTY.critical + warning * PENALTY.warning + info * PENALTY.info
      const score = device.status === 'unreachable' ? 0 : Math.max(0, 100 - penalty)
      return { name: device.name, deviceId: device.device_id, score, health: device.status === 'unreachable' ? 'crit' : healthOf(critical, warning), critical, warning, info }
    })
}

export function networkScore(report: DriftReport): number | null {
  const devices = deviceHealth(report)
  if (devices.length === 0) return null
  return Math.round(devices.reduce((sum, device) => sum + device.score, 0) / devices.length)
}

/** Topology node id ("dev:r1") to that device's health, for colouring the map. */
export function nodeHealth(report: DriftReport | null | undefined): Record<string, Health> {
  if (!report) return {}
  return Object.fromEntries(deviceHealth(report).map((device) => [`dev:${device.name.toLowerCase()}`, device.health]))
}

export function scoreHealth(score: number): Health {
  return score >= 90 ? 'ok' : score >= 60 ? 'warn' : 'crit'
}
