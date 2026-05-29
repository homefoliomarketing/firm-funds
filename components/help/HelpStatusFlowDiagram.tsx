/**
 * Visual diagram of the deal status flow.
 *
 *   under_review -> approved -> funded -> completed
 *                                  |
 *                                  v
 *                            failed_to_close -> cured
 *
 * Pure SVG with no client JS. Colors come from the existing `--status-*` CSS
 * variables in `app/globals.css`, applied through inline `style` rather than
 * Tailwind utilities (the SVG renderer needs the actual CSS variable values
 * on `fill`/`stroke`, not class-driven properties).
 *
 * The whole diagram is wrapped in a `role="img"` group with `<title>` and
 * `<desc>` so screen readers narrate the flow without having to expose every
 * pill's text individually.
 */
export default function HelpStatusFlowDiagram() {
  // Single source of truth for pill geometry so labels stay centered.
  const PILL_HEIGHT = 28
  const PILL_RADIUS = 14

  // Each pill is described as { label, x, y, width, varName }.
  // `varName` references a CSS variable defined in app/globals.css.
  const happyPath = [
    { label: 'Under review', x: 10, y: 30, width: 110, varName: '--status-blue' },
    { label: 'Approved', x: 145, y: 30, width: 90, varName: '--status-green' },
    { label: 'Funded', x: 260, y: 30, width: 80, varName: '--status-purple' },
    { label: 'Completed', x: 365, y: 30, width: 100, varName: '--status-teal' },
  ]

  const failedBranch = [
    { label: 'Failed to close', x: 220, y: 130, width: 130, varName: '--status-red' },
    { label: 'Cured', x: 375, y: 130, width: 70, varName: '--status-teal' },
  ]

  return (
    <div className="my-4 rounded-xl border border-border bg-card p-4 overflow-x-auto">
      <svg
        viewBox="0 0 480 180"
        width="100%"
        height="auto"
        role="img"
        aria-labelledby="status-flow-title status-flow-desc"
        className="text-foreground"
      >
        <title id="status-flow-title">Deal status flow</title>
        <desc id="status-flow-desc">
          A deal moves through under review, approved, funded, and completed.
          If a deal fails to close after funding, it moves to failed to close,
          and once remediated it moves to cured.
        </desc>

        <defs>
          <marker
            id="arrow-help-flow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" opacity="0.5" />
          </marker>
        </defs>

        {/* Happy-path arrows */}
        <g stroke="currentColor" strokeWidth="1.5" opacity="0.5" fill="none" markerEnd="url(#arrow-help-flow)">
          <line x1="120" y1="44" x2="145" y2="44" />
          <line x1="235" y1="44" x2="260" y2="44" />
          <line x1="340" y1="44" x2="365" y2="44" />
        </g>

        {/* Funded -> Failed to close (down + right) */}
        <g stroke="currentColor" strokeWidth="1.5" opacity="0.5" fill="none" markerEnd="url(#arrow-help-flow)">
          <path d="M 300 60 L 300 100 L 285 100 L 285 130" />
        </g>

        {/* Failed to close -> Cured */}
        <g stroke="currentColor" strokeWidth="1.5" opacity="0.5" fill="none" markerEnd="url(#arrow-help-flow)">
          <line x1="350" y1="144" x2="375" y2="144" />
        </g>

        {/* Happy-path pills */}
        {happyPath.map((p) => (
          <g key={p.label}>
            <rect
              x={p.x}
              y={p.y}
              width={p.width}
              height={PILL_HEIGHT}
              rx={PILL_RADIUS}
              ry={PILL_RADIUS}
              style={{
                fill: `var(${p.varName}-muted)`,
                stroke: `var(${p.varName}-border)`,
                strokeWidth: 1,
              }}
            />
            <text
              x={p.x + p.width / 2}
              y={p.y + PILL_HEIGHT / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="11"
              fontWeight="500"
              style={{ fill: `var(${p.varName})` }}
            >
              {p.label}
            </text>
          </g>
        ))}

        {/* Failed-branch pills */}
        {failedBranch.map((p) => (
          <g key={p.label}>
            <rect
              x={p.x}
              y={p.y}
              width={p.width}
              height={PILL_HEIGHT}
              rx={PILL_RADIUS}
              ry={PILL_RADIUS}
              style={{
                fill: `var(${p.varName}-muted)`,
                stroke: `var(${p.varName}-border)`,
                strokeWidth: 1,
              }}
            />
            <text
              x={p.x + p.width / 2}
              y={p.y + PILL_HEIGHT / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="11"
              fontWeight="500"
              style={{ fill: `var(${p.varName})` }}
            >
              {p.label}
            </text>
          </g>
        ))}

        {/* "If deal fails" label on the down arrow */}
        <text
          x="305"
          y="92"
          fontSize="10"
          style={{ fill: 'var(--muted-foreground)' }}
        >
          If it fails
        </text>
      </svg>
    </div>
  )
}
