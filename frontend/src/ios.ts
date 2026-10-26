// Cisco IOS configuration text: syntax highlighting and unified diffs.
// Pure functions; the components in components/CodeView.tsx draw the result.

export type TokenKind = 'plain' | 'comment' | 'keyword' | 'interface' | 'address' | 'number' | 'string' | 'negate' | 'secret' | 'shutdown'

export interface Token {
  text: string
  kind: TokenKind
}

const INTERFACE =
  /^(TenGigabitEthernet|GigabitEthernet|FastEthernet|Ethernet|Port-channel|Loopback|Vlan|Tunnel|Serial|Te|Gi|Fa|Et|Po|Lo|Vl|Tu|Se)\d+(\/\d+)*(\.\d+)?$/
const ADDRESS = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/
const NUMBER = /^\d+([,-]\d+)*$/
/** Commands whose second word is part of the command ("ip address", "switchport mode"). */
const TWO_WORD = new Set(['ip', 'ipv6', 'switchport', 'spanning-tree', 'router', 'service', 'snmp-server', 'logging', 'ntp', 'crypto', 'aaa', 'line', 'vtp', 'cdp', 'lldp', 'login', 'transport', 'encapsulation', 'standby', 'channel-group'])
/** Everything after these is free text. */
const FREE_TEXT = new Set(['description', 'name', 'hostname', 'banner', 'remark', 'domain-name'])
// Not plain "key": "crypto key generate rsa" has no secret after it.
const SECRET = new Set(['secret', 'password', 'community', 'key-string'])

/** Split one config line into coloured tokens. Whitespace is kept, so the tokens join back to the line. */
export function highlightLine(line: string): Token[] {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('!')) return [{ text: line, kind: 'comment' }]
  const tokens: Token[] = []
  const parts = line.split(/(\s+)/)
  let word = 0
  let freeText = false
  let secretNext = false
  let commandWords = 1
  for (const part of parts) {
    if (part === '') continue
    if (/^\s+$/.test(part)) {
      tokens.push({ text: part, kind: 'plain' })
      continue
    }
    let kind: TokenKind
    if (freeText) kind = 'string'
    else if (part === '<redacted>' || secretNext) kind = 'secret'
    else if (word === 0 && part === 'no') {
      kind = 'negate'
      commandWords = 2 // "no shutdown": the next word is the command
    } else if (part === 'shutdown' && word < commandWords + 1) kind = 'shutdown'
    else if (word < commandWords) kind = 'keyword'
    else if (INTERFACE.test(part)) kind = 'interface'
    else if (ADDRESS.test(part)) kind = 'address'
    else if (NUMBER.test(part)) kind = 'number'
    else kind = 'plain'

    if (kind === 'keyword' && TWO_WORD.has(part) && word === commandWords - 1) commandWords++
    if (kind === 'keyword' && FREE_TEXT.has(part)) freeText = true
    secretNext = SECRET.has(part) && !secretNext
    // "enable secret 9 $9$...": the hash type number is part of the secret.
    if (kind === 'secret' && /^\d$/.test(part)) secretNext = true
    tokens.push({ text: part, kind })
    word++
  }
  return tokens
}

// --- unified diff -------------------------------------------------------------------------

export type DiffKind = 'add' | 'del' | 'ctx'

export interface DiffLine {
  kind: DiffKind
  text: string
  /** Line number in the older and newer text, when the diff has hunk headers. */
  old: number | null
  new: number | null
}

export interface Hunk {
  header: string | null
  lines: DiffLine[]
}

export interface ParsedDiff {
  from: string | null
  to: string | null
  hunks: Hunk[]
}

/**
 * Read a unified diff ("--- a", "+++ b", "@@ -9,6 +9,9 @@", then " ", "+",
 * "-" lines). A diff of one section without headers (as in drift findings)
 * is read as one hunk without line numbers.
 */
export function parseDiff(diff: string): ParsedDiff {
  const result: ParsedDiff = { from: null, to: null, hunks: [] }
  let hunk: Hunk | null = null
  let oldLine: number | null = null
  let newLine: number | null = null
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('--- ') && !hunk) {
      result.from = raw.slice(4)
      continue
    }
    if (raw.startsWith('+++ ') && !hunk?.lines.length) {
      result.to = raw.slice(4)
      continue
    }
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (header) {
      hunk = { header: raw, lines: [] }
      result.hunks.push(hunk)
      oldLine = Number(header[1])
      newLine = Number(header[2])
      continue
    }
    if (raw === '' ) continue
    if (!hunk) {
      hunk = { header: null, lines: [] }
      result.hunks.push(hunk)
    }
    const sign = raw[0]
    const text = raw.slice(1)
    if (sign === '+') {
      hunk.lines.push({ kind: 'add', text, old: null, new: newLine })
      if (newLine !== null) newLine++
    } else if (sign === '-') {
      hunk.lines.push({ kind: 'del', text, old: oldLine, new: null })
      if (oldLine !== null) oldLine++
    } else {
      hunk.lines.push({ kind: 'ctx', text: sign === ' ' ? text : raw, old: oldLine, new: newLine })
      if (oldLine !== null) oldLine++
      if (newLine !== null) newLine++
    }
  }
  return result
}

/** Side-by-side rows: context on both sides, removed lines paired with the added lines that replace them. */
export function splitRows(hunk: Hunk): { left: DiffLine | null; right: DiffLine | null }[] {
  const rows: { left: DiffLine | null; right: DiffLine | null }[] = []
  let index = 0
  const lines = hunk.lines
  while (index < lines.length) {
    const line = lines[index]
    if (line.kind === 'ctx') {
      rows.push({ left: line, right: line })
      index++
      continue
    }
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (index < lines.length && lines[index].kind === 'del') removed.push(lines[index++])
    while (index < lines.length && lines[index].kind === 'add') added.push(lines[index++])
    for (let row = 0; row < Math.max(removed.length, added.length); row++) {
      rows.push({ left: removed[row] ?? null, right: added[row] ?? null })
    }
  }
  return rows
}
