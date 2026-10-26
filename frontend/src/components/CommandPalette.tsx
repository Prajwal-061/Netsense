import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDevices, useTopology } from '../queries'
import { DeviceGlyph } from './ui'

const PAGES = [
  { label: 'Overview', to: '/' },
  { label: 'Topology', to: '/topology' },
  { label: 'Devices', to: '/devices' },
  { label: 'Scans', to: '/scans' },
  { label: 'Collections', to: '/collections' },
  { label: 'Network health', to: '/network-health' },
]

interface Item {
  key: string
  group: 'Pages' | 'Devices'
  label: string
  detail?: string
  type?: string
  to: string
  /** Lower-case text the search matches against. */
  haystack: string
}

/** Hex digits only, so "aabb.cc80.0100", "AA-BB-..." and "aa:bb:..." all compare equal. */
const macDigits = (text: string) => text.toLowerCase().replace(/[^0-9a-f]/g, '')

/** Ctrl+K: jump to a page, or to a device by hostname, IP or MAC. */
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const devices = useDevices()
  const topology = useTopology()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)

  const items = useMemo<Item[]>(() => {
    const names = new Map<number, string>()
    for (const node of topology.data?.nodes ?? []) if (node.device_id !== null) names.set(node.device_id, node.name)
    const deviceItems: Item[] = (devices.data ?? []).map((device) => {
      const name = names.get(device.id)
      return {
        key: `device-${device.id}`,
        group: 'Devices',
        label: name ?? device.last_ip,
        detail: [name ? device.last_ip : null, device.mac, device.vendor].filter(Boolean).join(' · '),
        type: device.device_type,
        to: `/devices/${device.id}`,
        haystack: [name, device.last_ip, device.mac, macDigits(device.mac), device.vendor, device.device_type].join(' ').toLowerCase(),
      }
    })
    const pageItems: Item[] = PAGES.map((page) => ({ key: page.to, group: 'Pages', label: page.label, to: page.to, haystack: page.label.toLowerCase() }))
    return [...pageItems, ...deviceItems]
  }, [devices.data, topology.data])

  const results = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return items
    const digits = macDigits(text)
    return items.filter(
      (item) => item.haystack.includes(text) || (item.group === 'Devices' && digits.length >= 4 && item.haystack.includes(digits)),
    )
  }, [items, query])

  const selected = Math.min(active, Math.max(results.length - 1, 0))
  const go = (item: Item | undefined) => {
    if (!item) return
    onClose()
    void navigate(item.to)
  }

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]">
      <button type="button" aria-label="Close search" className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Search" className="relative w-full max-w-[560px] overflow-hidden rounded border border-line bg-surface shadow-float">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <svg viewBox="0 0 16 16" className="h-4 w-4 text-fg-subtle" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[selected] ? `palette-${results[selected].key}` : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActive((selected + 1) % Math.max(results.length, 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActive((selected - 1 + results.length) % Math.max(results.length, 1))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                go(results[selected])
              } else if (event.key === 'Escape') {
                onClose()
              }
            }}
            placeholder="Search devices by hostname, IP or MAC, or go to a page"
            className="h-11 min-w-0 flex-1 bg-transparent text-[14px] text-fg placeholder:text-fg-subtle focus:outline-none"
          />
          <kbd className="rounded-[2px] border border-line px-1 font-mono text-[10px] text-fg-subtle">esc</kbd>
        </div>
        <ul id="palette-results" role="listbox" ref={list} className="max-h-[360px] overflow-auto py-1">
          {results.length === 0 && <li className="px-3 py-3 text-fg-muted">No match for “{query}”.</li>}
          {results.map((item, index) => {
            const first = index === 0 || results[index - 1].group !== item.group
            return (
              <li key={item.key} role="presentation">
                {first && <p className="px-3 pt-2 pb-1 text-[10.5px] font-medium tracking-wide text-fg-subtle uppercase">{item.group}</p>}
                <div
                  id={`palette-${item.key}`}
                  role="option"
                  aria-selected={index === selected}
                  onMouseMove={() => setActive(index)}
                  onClick={() => go(item)}
                  className={`flex h-9 cursor-pointer items-center gap-2.5 px-3 ${index === selected ? 'bg-raised' : ''}`}
                >
                  {item.type ? <DeviceGlyph type={item.type} className="h-4 w-4 text-fg-muted" /> : <span className="h-4 w-4 text-center text-fg-subtle">→</span>}
                  <span className={item.group === 'Devices' ? 'font-mono text-[12.5px] text-fg' : 'text-fg'}>{item.label}</span>
                  {item.detail && <span className="truncate font-mono text-[11.5px] text-fg-subtle">{item.detail}</span>}
                </div>
              </li>
            )
          })}
        </ul>
        <div className="flex gap-4 border-t border-line px-3 py-1.5 text-[11px] text-fg-subtle">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
