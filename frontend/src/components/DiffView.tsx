/** A unified diff in monospace: added lines green, removed lines red. */
export default function DiffView({ diff, maxHeight = 'max-h-[32rem]' }: { diff: string; maxHeight?: string }) {
  return (
    <div className={`${maxHeight} overflow-auto rounded-md bg-slate-950 py-3 font-mono text-xs leading-relaxed`}>
      {/* min-w-max keeps each line's background colour as wide as the longest line. */}
      <div className="min-w-max">
        {diff.split('\n').map((line, index) => (
          <div key={index} className={`px-4 whitespace-pre ${diffLineColour(line)}`}>
            {line || ' '}
          </div>
        ))}
      </div>
    </div>
  )
}

function diffLineColour(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'font-semibold text-slate-400'
  if (line.startsWith('@@')) return 'text-sky-400'
  if (line.startsWith('+')) return 'bg-emerald-500/15 text-emerald-300'
  if (line.startsWith('-')) return 'bg-red-500/15 text-red-300'
  return 'text-slate-300'
}
