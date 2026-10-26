import { expect, test } from 'vitest'
import { highlightLine, parseDiff, splitRows } from './ios'

const kinds = (line: string) =>
  highlightLine(line)
    .filter((token) => token.text.trim())
    .map((token) => `${token.kind}:${token.text}`)

test('commands, interfaces, addresses, numbers and comments get their own colours', () => {
  expect(kinds('interface GigabitEthernet0/1.20')).toEqual(['keyword:interface', 'interface:GigabitEthernet0/1.20'])
  expect(kinds(' ip address 10.1.20.1 255.255.255.0')).toEqual(['keyword:ip', 'keyword:address', 'address:10.1.20.1', 'address:255.255.255.0'])
  expect(kinds(' switchport trunk allowed vlan 20,30')).toEqual(['keyword:switchport', 'keyword:trunk', 'plain:allowed', 'plain:vlan', 'number:20,30'])
  expect(kinds('!')).toEqual(['comment:!'])
  expect(kinds(' network 10.0.12.0 0.0.0.3 area 0')).toEqual(['keyword:network', 'address:10.0.12.0', 'address:0.0.0.3', 'plain:area', 'number:0'])
})

test('free text, negation, shutdown and masked secrets', () => {
  expect(kinds(' description Uplink to SW1')).toEqual(['keyword:description', 'string:Uplink', 'string:to', 'string:SW1'])
  expect(kinds(' no shutdown')).toEqual(['negate:no', 'shutdown:shutdown'])
  expect(kinds(' shutdown')).toEqual(['shutdown:shutdown'])
  expect(kinds('enable secret 9 <redacted>')).toEqual(['keyword:enable', 'plain:secret', 'secret:9', 'secret:<redacted>'])
  expect(kinds('crypto key generate rsa modulus 2048')).toEqual(['keyword:crypto', 'keyword:key', 'plain:generate', 'plain:rsa', 'plain:modulus', 'number:2048'])
})

test('tokens join back into the original line', () => {
  for (const line of ['interface Ethernet0/1', '  switchport mode trunk', 'hostname SW1', ' no ip address']) {
    expect(highlightLine(line).map((token) => token.text).join('')).toBe(line)
  }
})

const DIFF = [
  '--- backup #1',
  '+++ backup #2',
  '@@ -9,4 +9,5 @@',
  ' vlan 10',
  '-interface Ethernet0/3',
  '+interface Ethernet0/3',
  '+ description host',
  ' !',
].join('\n')

test('a unified diff is read with old and new line numbers', () => {
  const parsed = parseDiff(DIFF)
  expect([parsed.from, parsed.to]).toEqual(['backup #1', 'backup #2'])
  expect(parsed.hunks).toHaveLength(1)
  expect(parsed.hunks[0].lines.map((line) => [line.kind, line.old, line.new, line.text])).toEqual([
    ['ctx', 9, 9, 'vlan 10'],
    ['del', 10, null, 'interface Ethernet0/3'],
    ['add', null, 10, 'interface Ethernet0/3'],
    ['add', null, 11, ' description host'],
    ['ctx', 11, 12, '!'],
  ])
})

test('side by side, removed lines face the lines that replaced them', () => {
  const rows = splitRows(parseDiff(DIFF).hunks[0])
  expect(rows.map((row) => [row.left?.kind ?? null, row.right?.kind ?? null])).toEqual([
    ['ctx', 'ctx'],
    ['del', 'add'],
    [null, 'add'],
    ['ctx', 'ctx'],
  ])
})

test('a section diff without headers is one hunk without line numbers', () => {
  const parsed = parseDiff('-router ospf 1\n+router ospf 1\n  network 10.0.12.0 0.0.0.3 area 1')
  expect(parsed.hunks).toHaveLength(1)
  expect(parsed.hunks[0].lines.map((line) => [line.kind, line.old, line.text])).toEqual([
    ['del', null, 'router ospf 1'],
    ['add', null, 'router ospf 1'],
    ['ctx', null, ' network 10.0.12.0 0.0.0.3 area 1'],
  ])
})
