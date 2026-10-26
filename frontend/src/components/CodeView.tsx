import { Fragment, useState } from 'react'
import type { DiffLine, TokenKind } from '../ios'
import { highlightLine, parseDiff, splitRows } from '../ios'

const TOKEN_CLASS: Record<TokenKind, string> = {
  plain: '',
  comment: 'text-fg-subtle',
  keyword: 'text-code-keyword',
  interface: 'text-code-interface',
  address: 'text-code-address',
  number: 'text-code-number',
  string: 'text-code-string italic',
  negate: 'text-crit-fg',
  secret: 'text-fg-subtle',
  shutdown: 'text-crit-fg',
}

/** One line of IOS config, coloured. */
function Code({ text }: { text: string }) {
  if (!text) return <>{' '}</>
  return (
    <>
      {highlightLine(text).map((token, index) =>
        token.kind === 'plain' ? <Fragment key={index}>{token.text}</Fragment> : <span key={index} className={TOKEN_CLASS[token.kind]}>{token.text}</span>,
      )}
    </>
  )
}

const GUTTER = 'w-px select-none border-r border-line px-2 text-right align-top text-fg-subtle tabular'

/** A configuration with line numbers and IOS syntax colours. */
export function ConfigView({ text, label, maxHeight = 'max-h-[36rem]' }: { text: string; label: string; maxHeight?: string }) {
  const lines = text.replace(/\n$/, '').split('\n')
  return (
    <div className={`${maxHeight} overflow-auto rounded border border-line bg-canvas`}>
      <table aria-label={label} className="min-w-full border-separate border-spacing-0 font-mono text-xs leading-5">
        <tbody>
          {lines.map((line, index) => (
            <tr key={index} className="hover:bg-raised">
              <td className={GUTTER}>{index + 1}</td>
              <td className="px-3 whitespace-pre text-fg">
                <Code text={line} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const ROW_BG: Record<DiffLine['kind'], string> = { add: 'bg-ok-soft', del: 'bg-crit-soft', ctx: '' }
const SIGN: Record<DiffLine['kind'], { text: string; className: string }> = {
  add: { text: '+', className: 'text-ok-fg' },
  del: { text: '-', className: 'text-crit-fg' },
  ctx: { text: ' ', className: '' },
}

/**
 * A unified diff drawn like a code review: unified or side by side, line
 * numbers of both versions, added lines green, removed lines red, IOS syntax
 * colours on every line.
 */
export default function DiffView({
  diff,
  maxHeight = 'max-h-[36rem]',
  label = 'Config diff',
  allowSplit = true,
}: {
  diff: string
  maxHeight?: string
  label?: string
  allowSplit?: boolean
}) {
  const [mode, setMode] = useState<'unified' | 'split'>('unified')
  const parsed = parseDiff(diff)
  const numbered = parsed.hunks.some((hunk) => hunk.header !== null)
  const split = allowSplit && mode === 'split'

  return (
    <div className="overflow-hidden rounded border border-line bg-canvas">
      {(parsed.from || allowSplit) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-3 py-1.5 text-xs">
          {parsed.from && (
            <span className="min-w-0 truncate font-mono text-fg-muted">
              <span className="text-crit-fg">{parsed.from}</span>
              <span className="text-fg-subtle"> → </span>
              <span className="text-ok-fg">{parsed.to}</span>
            </span>
          )}
          {allowSplit && (
            <div className="ml-auto inline-flex rounded border border-line-strong p-px" role="group" aria-label="Diff layout">
              {(['unified', 'split'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={mode === item}
                  onClick={() => setMode(item)}
                  className={`rounded-[3px] px-2 leading-5 transition-colors duration-150 ${mode === item ? 'bg-raised text-fg' : 'text-fg-muted hover:text-fg'}`}
                >
                  {item === 'unified' ? 'Unified' : 'Side by side'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className={`${maxHeight} overflow-auto`}>
        <table aria-label={label} className="min-w-full border-separate border-spacing-0 font-mono text-xs leading-5">
          <tbody>
            {parsed.hunks.map((hunk, hunkIndex) => (
              <Fragment key={hunkIndex}>
                {hunk.header && (
                  <tr>
                    <td colSpan={split ? 6 : 4} className="border-y border-line bg-accent-soft px-3 text-link">
                      {hunk.header}
                    </td>
                  </tr>
                )}
                {split
                  ? splitRows(hunk).map((row, index) => (
                      <tr key={index}>
                        <Half line={row.left} number={row.left?.old ?? null} numbered={numbered} />
                        <Half line={row.right} number={row.right?.new ?? null} numbered={numbered} divider />
                      </tr>
                    ))
                  : hunk.lines.map((line, index) => (
                      <tr key={index} data-kind={line.kind} className={ROW_BG[line.kind]}>
                        {numbered && <td className={GUTTER}>{line.old ?? ''}</td>}
                        {numbered && <td className={GUTTER}>{line.new ?? ''}</td>}
                        <td className={`w-px pl-2 select-none ${SIGN[line.kind].className}`}>{SIGN[line.kind].text}</td>
                        <td className="pr-3 pl-1 whitespace-pre text-fg">
                          <Code text={line.text} />
                        </td>
                      </tr>
                    ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Half({ line, number, numbered, divider = false }: { line: DiffLine | null; number: number | null; numbered: boolean; divider?: boolean }) {
  const bg = line ? ROW_BG[line.kind] : 'bg-raised/40'
  return (
    <>
      {numbered && <td className={`${GUTTER} ${divider ? 'border-l' : ''} ${bg}`}>{number ?? ''}</td>}
      <td className={`w-px pl-2 select-none ${bg} ${line ? SIGN[line.kind].className : ''} ${!numbered && divider ? 'border-l border-line' : ''}`}>
        {line ? SIGN[line.kind].text : ''}
      </td>
      <td data-kind={line?.kind} className={`w-1/2 pr-3 pl-1 whitespace-pre text-fg ${bg}`}>
        {line ? <Code text={line.text} /> : ''}
      </td>
    </>
  )
}
