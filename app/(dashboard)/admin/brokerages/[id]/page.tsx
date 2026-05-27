import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import {
  ArrowLeft,
  Building2,
  Mail,
  Phone,
  ChevronRight,
} from 'lucide-react'

import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { BrokerageAdminsPanel } from '@/components/admin/BrokerageAdminsPanel'
import { Card, CardContent } from '@/components/ui/card'

export const metadata = {
  title: 'Brokerage detail — Firm Funds Admin',
  robots: { index: false, follow: false },
}

// Next.js 16: dynamic-route params arrive as a Promise.
interface PageProps {
  params: Promise<{ id: string }>
}

export default async function BrokerageDetailPage({ params }: PageProps) {
  const { id } = await params

  // Auth gate — same as the rest of the admin app
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role, is_active')
    .eq('id', user.id)
    .single()

  if (
    !profile ||
    profile.is_active === false ||
    !['super_admin', 'firm_funds_admin'].includes(profile.role)
  ) {
    redirect('/login')
  }

  // Load the brokerage via service role — admins should see archived as well
  // so the page never 404s when navigating from an old audit row.
  const service = createServiceRoleClient()
  const { data: brokerage } = await service
    .from('brokerages')
    .select(
      'id, name, brand, email, phone, status, broker_of_record_name, broker_of_record_email, is_white_label_partner, profit_share_pct, created_at',
    )
    .eq('id', id)
    .maybeSingle()

  if (!brokerage) {
    notFound()
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/admin/brokerages"
              className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors shrink-0"
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Brokerages
            </Link>
            <div className="w-px h-6 bg-border/30 shrink-0" aria-hidden="true" />
            <div className="flex items-center gap-2 min-w-0">
              <Building2
                size={16}
                className="text-primary shrink-0"
                aria-hidden="true"
              />
              <h1 className="text-sm font-semibold text-foreground truncate">
                {brokerage.name}
              </h1>
            </div>
          </div>
          <Link
            href={`/admin/brokerages/${id}/firm-deal-pipe`}
            className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
          >
            Firm-deal pipe settings
            <ChevronRight size={12} aria-hidden="true" />
          </Link>
        </div>
      </header>

      <main id="main-content" className="max-w-5xl mx-auto px-4 py-6 space-y-5">
        {/* Brokerage card — quick info, not a full edit form (that lives on
            /admin/brokerages list page expansion). */}
        <Card className="border-border/40 bg-card/60">
          <CardContent className="p-5 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  {brokerage.name}
                </h2>
                {brokerage.brand ? (
                  <p className="text-sm text-muted-foreground">{brokerage.brand}</p>
                ) : null}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground/70">
                  Status
                </span>
                <span className="text-sm font-semibold text-foreground capitalize">
                  {brokerage.status}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-border/40">
              <div className="flex items-center gap-2 text-sm">
                <Mail
                  size={14}
                  className="text-muted-foreground shrink-0"
                  aria-hidden="true"
                />
                <span className="text-muted-foreground">{brokerage.email}</span>
              </div>
              {brokerage.phone ? (
                <div className="flex items-center gap-2 text-sm">
                  <Phone
                    size={14}
                    className="text-muted-foreground shrink-0"
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground">
                    {brokerage.phone}
                  </span>
                </div>
              ) : null}
              {brokerage.broker_of_record_email ? (
                <div className="flex items-center gap-2 text-sm sm:col-span-2">
                  <Mail
                    size={14}
                    className="text-primary shrink-0"
                    aria-hidden="true"
                  />
                  <span className="text-foreground">
                    {brokerage.broker_of_record_name ||
                      'Broker of Record'}{' '}
                    <span className="text-muted-foreground">
                      &lt;{brokerage.broker_of_record_email}&gt;
                    </span>
                  </span>
                </div>
              ) : null}
            </div>
            <div className="pt-2 text-xs text-muted-foreground">
              <Link
                href="/admin/brokerages"
                className="underline-offset-4 hover:underline hover:text-foreground"
              >
                Edit brokerage details, agents, KYC, banking, BCA &rarr;
              </Link>
            </div>
          </CardContent>
        </Card>

        {/* Admins management — the main reason this page exists */}
        <BrokerageAdminsPanel
          brokerageId={brokerage.id}
          brokerageName={brokerage.name}
        />
      </main>
    </div>
  )
}
