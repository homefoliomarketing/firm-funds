'use client'

import { AlertTriangle, Shield, MessageSquare, CheckCircle2, ChevronRight } from 'lucide-react'

export type ActionTab = 'deals' | 'payments' | 'messages' | 'agents' | 'referrals'

type Tone = 'red' | 'amber' | 'blue'

interface Item {
  key: string
  count: number
  label: string
  Icon: typeof AlertTriangle
  tone: Tone
  onClick: () => void
  ariaLabel: string
}

interface Props {
  tradeRecordsMissing: number
  kycPending: number
  unreadMessages: number
  onNavigate: (tab: ActionTab) => void
}

const toneClasses: Record<Tone, { bg: string; border: string; hover: string; iconBg: string; iconText: string; count: string }> = {
  red: {
    bg: 'bg-red-950/30',
    border: 'border-red-800/50',
    hover: 'hover:border-red-600 hover:bg-red-950/45',
    iconBg: 'bg-red-500/15',
    iconText: 'text-red-400',
    count: 'text-red-300',
  },
  amber: {
    bg: 'bg-amber-950/30',
    border: 'border-amber-800/50',
    hover: 'hover:border-amber-600 hover:bg-amber-950/45',
    iconBg: 'bg-amber-500/15',
    iconText: 'text-amber-400',
    count: 'text-amber-300',
  },
  blue: {
    bg: 'bg-blue-950/30',
    border: 'border-blue-800/50',
    hover: 'hover:border-blue-600 hover:bg-blue-950/45',
    iconBg: 'bg-blue-500/15',
    iconText: 'text-blue-400',
    count: 'text-blue-300',
  },
}

export default function ActionRequiredStrip({
  tradeRecordsMissing,
  kycPending,
  unreadMessages,
  onNavigate,
}: Props) {
  const items: Item[] = [
    {
      key: 'trade',
      count: tradeRecordsMissing,
      label: tradeRecordsMissing === 1 ? 'Trade record to upload' : 'Trade records to upload',
      Icon: AlertTriangle,
      tone: 'red',
      onClick: () => onNavigate('deals'),
      ariaLabel: `${tradeRecordsMissing} trade record${tradeRecordsMissing === 1 ? '' : 's'} to upload, view deals`,
    },
    {
      key: 'kyc',
      count: kycPending,
      label: kycPending === 1 ? 'Agent ID to review' : 'Agent IDs to review',
      Icon: Shield,
      tone: 'amber',
      onClick: () => onNavigate('agents'),
      ariaLabel: `${kycPending} agent ID${kycPending === 1 ? '' : 's'} awaiting review, view agents`,
    },
    {
      key: 'messages',
      count: unreadMessages,
      label: unreadMessages === 1 ? 'Unread message' : 'Unread messages',
      Icon: MessageSquare,
      tone: 'blue',
      onClick: () => onNavigate('messages'),
      ariaLabel: `${unreadMessages} unread message${unreadMessages === 1 ? '' : 's'}, view messages`,
    },
  ]

  const active = items.filter(i => i.count > 0)

  if (active.length === 0) {
    return (
      <section aria-label="Action items" className="mb-6">
        <div className="rounded-xl border border-status-green-border/50 bg-status-green-muted/30 px-5 py-3.5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-status-green/15 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 size={18} className="text-status-green" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">You&apos;re all caught up.</p>
            <p className="text-xs text-muted-foreground">Nothing needs your attention right now.</p>
          </div>
        </div>
      </section>
    )
  }

  // Single item: compact horizontal alert — avoids the empty-card-with-tiny-number look
  if (active.length === 1) {
    const item = active[0]
    const t = toneClasses[item.tone]
    return (
      <section aria-label="Action required" className="mb-6">
        <button
          type="button"
          onClick={item.onClick}
          aria-label={item.ariaLabel}
          className={`group w-full text-left rounded-xl px-5 py-3.5 transition-all border flex items-center gap-4 ${t.bg} ${t.border} ${t.hover} focus:outline-none focus:ring-2 focus:ring-ring`}
        >
          <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${t.iconBg}`} aria-hidden="true">
            <item.Icon size={17} className={t.iconText} />
          </div>
          <div className="flex-1 min-w-0 flex items-baseline gap-2">
            <span className={`text-xl font-bold tabular-nums leading-none ${t.count}`}>{item.count}</span>
            <span className="text-sm text-foreground/85">{item.label}</span>
          </div>
          <ChevronRight
            size={16}
            className={`opacity-50 group-hover:opacity-100 transition flex-shrink-0 ${t.iconText}`}
            aria-hidden="true"
          />
        </button>
      </section>
    )
  }

  // 2-3 items: equal-width card grid
  const gridCols = active.length === 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'

  return (
    <section aria-label="Action required" className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Needs your attention</p>
        <p className="text-[11px] text-muted-foreground/70">
          {active.length} items
        </p>
      </div>
      <div className={`grid gap-3 ${gridCols}`}>
        {active.map((item) => {
          const t = toneClasses[item.tone]
          return (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              aria-label={item.ariaLabel}
              className={`group relative text-left rounded-xl p-4 transition-all border ${t.bg} ${t.border} ${t.hover} focus:outline-none focus:ring-2 focus:ring-ring`}
            >
              <div className="flex items-start justify-between gap-2 mb-3">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${t.iconBg}`} aria-hidden="true">
                  <item.Icon size={17} className={t.iconText} />
                </div>
                <ChevronRight
                  size={15}
                  className={`opacity-30 group-hover:opacity-80 transition ${t.iconText}`}
                  aria-hidden="true"
                />
              </div>
              <p className={`text-2xl font-bold tabular-nums leading-none ${t.count}`}>{item.count}</p>
              <p className="text-xs mt-1.5 text-foreground/70">{item.label}</p>
            </button>
          )
        })}
      </div>
    </section>
  )
}
