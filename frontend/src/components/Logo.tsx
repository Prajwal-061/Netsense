// The NetSense mark: an "N" drawn as a network path (four nodes, three
// links). The top-right node carries a faint ring: the "sense" in NetSense.

export function LogoMark({ size = 20, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} role="img" aria-label="NetSense">
      <rect width="32" height="32" rx="7" className="fill-accent" />
      <circle cx="23" cy="9" r="5.5" fill="none" stroke="white" strokeOpacity="0.45" strokeWidth="1.4" />
      <path d="M9 23V9l14 14V9" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="23" r="2.6" fill="white" />
      <circle cx="9" cy="9" r="2.6" fill="white" />
      <circle cx="23" cy="23" r="2.6" fill="white" />
      <circle cx="23" cy="9" r="2.6" fill="white" />
    </svg>
  )
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-semibold tracking-[-0.01em] text-fg ${className}`}>
      Net<span className="text-accent">Sense</span>
    </span>
  )
}
