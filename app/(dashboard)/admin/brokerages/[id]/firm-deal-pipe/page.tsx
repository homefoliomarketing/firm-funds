'use client'

import { use, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ClipboardCopy,
  Inbox,
  Loader2,
  Send,
  Sparkles,
  XCircle,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import {
  testSheetAccess,
  parseSheetIdInput,
  fetchTabPreview,
  createBrokeragePipe,
  getBrokerageForPipeWizard,
  getPipeStatistics,
  getServiceAccountEmail,
  setPipeAutoFire,
  setPipeNotificationRecipients,
  type ExistingPipeSummary,
  type NotificationRecipientsConfig,
  type PipeStatistics,
} from '@/lib/actions/firm-deal-pipe-actions'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// ============================================================================
// Types + constants
// ============================================================================

type TabRole = 'conditional' | 'watch' | 'ignore'
type ColumnRole = 'address' | 'mls' | 'closing_date' | 'listing_agent' | 'selling_agent' | 'ignore'

const COLUMN_ROLE_LABELS: Record<ColumnRole, string> = {
  address: 'Address',
  mls: 'MLS #',
  closing_date: 'Closing date',
  listing_agent: 'Listing agent',
  selling_agent: 'Selling agent',
  ignore: '(ignore)',
}

// Default heuristic when the admin first lands on step 2. Anything that looks
// like a month name becomes a Watch tab; anything containing "conditional"
// becomes the Conditional tab; everything else defaults to Ignore.
const MONTH_RE = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i

function suggestTabRole(name: string, alreadyHaveConditional: boolean): TabRole {
  const lower = name.trim().toLowerCase()
  if (!alreadyHaveConditional && /conditional/.test(lower)) return 'conditional'
  if (MONTH_RE.test(lower)) return 'watch'
  return 'ignore'
}

// Spreadsheet column letter for a 0-based index: A, B, ..., Z, AA, AB, ...
function indexToColumnLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

// ============================================================================
// Page
// ============================================================================

interface PageProps {
  // Next.js 16: params is a Promise. The `use()` hook unwraps it for client
  // components without needing a Suspense boundary on this page (parent
  // layout handles loading).
  params: Promise<{ id: string }>
}

export default function FirmDealPipeWizardPage(props: PageProps) {
  const { id: brokerageId } = use(props.params)
  const router = useRouter()
  const supabase = createClient()

  const [authChecked, setAuthChecked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [brokerage, setBrokerage] = useState<{ id: string; name: string } | null>(null)
  const [existingPipe, setExistingPipe] = useState<ExistingPipeSummary | null>(null)
  const [serviceAccountEmail, setServiceAccountEmail] = useState<string>('')

  // Step state — see <Wizard /> below for the rest.
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1)
  const [sheetInput, setSheetInput] = useState('')
  const [sheetId, setSheetId] = useState('')
  const [sheetUrl, setSheetUrl] = useState('')
  const [tabs, setTabs] = useState<string[]>([])
  const [tabRoles, setTabRoles] = useState<Record<string, TabRole>>({})
  const [previewTab, setPreviewTab] = useState<string>('')
  const [previewRows, setPreviewRows] = useState<string[][]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  const [columnRoles, setColumnRoles] = useState<Record<string, ColumnRole>>({})
  const [brandName, setBrandName] = useState('')
  const [brandTagline, setBrandTagline] = useState('Powered by Firm Funds')
  const [submitting, setSubmitting] = useState(false)
  const [submitMessage, setSubmitMessage] = useState<string | null>(null)
  const [sheetCheckLoading, setSheetCheckLoading] = useState(false)
  const [sheetCheckError, setSheetCheckError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // ----- Auth check (admin only) -----
  useEffect(() => {
    async function checkAuth() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('id', user.id)
        .single()
      if (profile?.role !== 'super_admin' && profile?.role !== 'firm_funds_admin') {
        router.push('/login'); return
      }
      setAuthChecked(true)
    }
    checkAuth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ----- Initial fetch -----
  useEffect(() => {
    if (!authChecked) return
    async function load() {
      setLoading(true)
      const [pipeRes, saRes] = await Promise.all([
        getBrokerageForPipeWizard({ brokerageId }),
        getServiceAccountEmail(),
      ])
      if (!pipeRes.success) {
        setError(pipeRes.error ?? 'Failed to load brokerage.')
        setLoading(false)
        return
      }
      setBrokerage(pipeRes.data!.brokerage)
      setExistingPipe(pipeRes.data!.pipe)
      if (!brandName) setBrandName(`${pipeRes.data!.brokerage.name} Advances`)
      if (saRes.success && saRes.data) setServiceAccountEmail(saRes.data.email)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, brokerageId])

  // -----------------------------------------------------------------------
  // Step 1 — sheet share check
  // -----------------------------------------------------------------------
  async function handleSheetCheck() {
    setSheetCheckLoading(true)
    setSheetCheckError(null)
    const parseRes = await parseSheetIdInput(sheetInput)
    if (!parseRes.success) {
      setSheetCheckError(parseRes.error ?? 'Invalid input.')
      setSheetCheckLoading(false)
      return
    }
    const id = parseRes.data!.sheetId
    const url = sheetInput.includes('http')
      ? sheetInput.trim()
      : `https://docs.google.com/spreadsheets/d/${id}/edit`
    const accessRes = await testSheetAccess({ sheetId: id })
    if (!accessRes.success) {
      setSheetCheckError(accessRes.error ?? 'Sheet access failed.')
      if (accessRes.data?.serviceAccountEmail) {
        setServiceAccountEmail(accessRes.data.serviceAccountEmail)
      }
      setSheetCheckLoading(false)
      return
    }
    setSheetId(id)
    setSheetUrl(url)
    setTabs(accessRes.data!.tabs)
    // Seed default roles
    const roles: Record<string, TabRole> = {}
    let haveConditional = false
    for (const t of accessRes.data!.tabs) {
      const role = suggestTabRole(t, haveConditional)
      if (role === 'conditional') haveConditional = true
      roles[t] = role
    }
    setTabRoles(roles)
    setSheetCheckLoading(false)
    setStep(2)
  }

  // -----------------------------------------------------------------------
  // Step 2 — tab classification
  // -----------------------------------------------------------------------
  const conditionalTab = useMemo(
    () => Object.entries(tabRoles).find(([, r]) => r === 'conditional')?.[0] ?? '',
    [tabRoles]
  )
  const watchedTabs = useMemo(
    () => Object.entries(tabRoles).filter(([, r]) => r === 'watch').map(([t]) => t),
    [tabRoles]
  )
  const tabsStepValid = !!conditionalTab && watchedTabs.length > 0

  function setTabRole(tab: string, role: TabRole) {
    setTabRoles(prev => {
      const next = { ...prev, [tab]: role }
      // Enforce single Conditional — if the user picks conditional for one,
      // demote any others currently set to conditional back to ignore.
      if (role === 'conditional') {
        for (const t of Object.keys(next)) {
          if (t !== tab && next[t] === 'conditional') next[t] = 'ignore'
        }
      }
      return next
    })
  }

  // -----------------------------------------------------------------------
  // Step 3 — column mapping
  // -----------------------------------------------------------------------
  async function loadPreview(tab: string) {
    setPreviewLoading(true)
    setPreviewTab(tab)
    const res = await fetchTabPreview({ sheetId, tab, limit: 6 })
    if (res.success && res.data) {
      setPreviewRows(res.data.rows)
    } else {
      setPreviewRows([])
      setSheetCheckError(res.error ?? 'Preview failed.')
    }
    setPreviewLoading(false)
  }

  // First-time entry into step 3: pick a watched tab + preload preview.
  useEffect(() => {
    if (step !== 3) return
    if (!previewTab && watchedTabs.length > 0) {
      void loadPreview(watchedTabs[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // Derive number of columns to render mapping rows for, based on widest
  // preview row.
  const previewColCount = useMemo(() => {
    let max = 0
    for (const row of previewRows) max = Math.max(max, row.length)
    // Always show at least 8 columns so the admin can pick further-right
    // columns even when the header row is short (Choice Realty's closing date
    // is in column K, well past the first data column).
    return Math.max(max, 8)
  }, [previewRows])

  // For each letter, what role is currently selected (or 'ignore').
  function setColumnRole(letter: string, role: ColumnRole) {
    setColumnRoles(prev => {
      const next = { ...prev, [letter]: role }
      // Enforce each NAMED role belongs to at most one column. If the admin
      // assigns address to B but it was already on A, clear A.
      if (role !== 'ignore') {
        for (const l of Object.keys(next)) {
          if (l !== letter && next[l] === role) next[l] = 'ignore'
        }
      }
      return next
    })
  }

  const columnsStepValid = useMemo(() => {
    const assigned = new Set(Object.values(columnRoles))
    if (!assigned.has('address')) return false
    if (!assigned.has('listing_agent') && !assigned.has('selling_agent')) return false
    return true
  }, [columnRoles])

  // -----------------------------------------------------------------------
  // Step 5 — confirm + create
  // -----------------------------------------------------------------------
  async function handleCreate() {
    setSubmitting(true)
    setSubmitMessage(null)
    const mapping: Record<string, string> = {}
    for (const [letter, role] of Object.entries(columnRoles)) {
      if (role === 'ignore') continue
      mapping[role] = letter
    }
    const res = await createBrokeragePipe({
      brokerageId,
      sheetId,
      sheetUrl,
      conditionalTab,
      tabsToWatch: watchedTabs,
      columnMapping: mapping,
      brandName,
      brandTagline,
    })
    setSubmitting(false)
    if (!res.success) {
      setSubmitMessage(res.error ?? 'Create failed.')
      return
    }
    // Reload to show the "already configured" state so Bud can see what landed.
    const refreshed = await getBrokerageForPipeWizard({ brokerageId })
    if (refreshed.success && refreshed.data) {
      setExistingPipe(refreshed.data.pipe)
    }
    setSubmitMessage('Pipe created — first poll within ~15 min will baseline the sheet without firing events.')
  }

  async function handleCopyEmail() {
    try {
      await navigator.clipboard.writeText(serviceAccountEmail)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard blocked — fall through silently
    }
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  if (!authChecked || loading) {
    return (
      <div className="container mx-auto px-4 py-6 max-w-4xl">
        <Skeleton className="h-8 w-64 mb-4" />
        <Skeleton className="h-32 w-full" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto px-4 py-6 max-w-4xl">
        <Card className="border-destructive">
          <CardContent className="py-4">
            <p className="text-sm text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" aria-hidden="true" /> {error}
            </p>
            <div className="mt-3">
              <Link href="/admin/brokerages" className="text-xs text-primary hover:underline">
                ← Back to brokerages
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-4xl">
      <header className="mb-6">
        <Link
          href="/admin/brokerages"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary mb-3"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to brokerages
        </Link>
        <div className="flex items-center gap-2">
          <Inbox className="h-5 w-5 text-primary" aria-hidden="true" />
          <h1 className="text-xl font-bold">Firm Deal Pipe</h1>
          <span className="text-xs text-muted-foreground">· {brokerage?.name}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Connect this brokerage&apos;s Google Sheet so Firm Funds can detect firm deals and offer advances automatically.
        </p>
      </header>

      {/* ALREADY CONFIGURED — show summary instead of the wizard. */}
      {existingPipe ? (
        <ExistingPipeView
          pipe={existingPipe}
          brokerageId={brokerageId}
          brokerageName={brokerage?.name ?? ''}
        />
      ) : (
        <Wizard
          step={step}
          setStep={setStep}
          // Step 1
          sheetInput={sheetInput}
          setSheetInput={setSheetInput}
          sheetCheckLoading={sheetCheckLoading}
          sheetCheckError={sheetCheckError}
          serviceAccountEmail={serviceAccountEmail}
          copied={copied}
          onCopyEmail={handleCopyEmail}
          onSheetCheck={handleSheetCheck}
          // Step 2
          tabs={tabs}
          tabRoles={tabRoles}
          setTabRole={setTabRole}
          tabsStepValid={tabsStepValid}
          conditionalTab={conditionalTab}
          watchedTabs={watchedTabs}
          // Step 3
          previewTab={previewTab}
          previewRows={previewRows}
          previewLoading={previewLoading}
          previewColCount={previewColCount}
          columnRoles={columnRoles}
          setColumnRole={setColumnRole}
          columnsStepValid={columnsStepValid}
          loadPreview={loadPreview}
          // Step 4
          brandName={brandName}
          setBrandName={setBrandName}
          brandTagline={brandTagline}
          setBrandTagline={setBrandTagline}
          // Step 5
          sheetUrl={sheetUrl}
          onCreate={handleCreate}
          submitting={submitting}
          submitMessage={submitMessage}
          brokerageName={brokerage?.name ?? ''}
        />
      )}
    </div>
  )
}

// ============================================================================
// Existing-pipe summary — includes the config dump, the auto-fire toggle
// with confirmation modal (P2 #8), and the per-pipe statistics card (P2 #9).
// ============================================================================
function ExistingPipeView({ pipe, brokerageId, brokerageName }: {
  pipe: ExistingPipeSummary
  brokerageId: string
  brokerageName: string
}) {
  // Local copy of auto_fire_enabled so we can flip it without a page reload.
  const [autoFire, setAutoFire] = useState(pipe.auto_fire_enabled)
  const [stats, setStats] = useState<PipeStatistics | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState<string | null>(null)

  // Reload stats on mount and whenever the toggle flips (the lifetime sent
  // count is the modal's anchor; refetching keeps it honest in case events
  // landed since the page first loaded).
  useEffect(() => {
    let cancelled = false
    // Resetting loading/error state at the start of an effect-driven fetch is
    // the canonical pattern. React Compiler flags this but it cannot cascade —
    // the effect body fires once per dep change, not on every render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatsLoading(true)
    setStatsError(null)
    void getPipeStatistics({ brokerageId }).then(res => {
      if (cancelled) return
      if (res.success && res.data) {
        setStats(res.data)
      } else {
        setStatsError(res.error ?? 'Failed to load statistics.')
      }
      setStatsLoading(false)
    })
    return () => { cancelled = true }
  }, [brokerageId, autoFire])

  return (
    <div className="space-y-4">
      <Card className="border-emerald-700/40 bg-emerald-950/15">
        <CardContent className="py-5 px-5 space-y-4">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-400 mt-0.5" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">Pipe already configured for {brokerageName}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Disable this pipe in SQL before running the wizard again.
              </p>
            </div>
          </div>

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <div>
              <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Brand</dt>
              <dd className="font-medium">
                {pipe.brand_name ?? '—'}
                <span className="text-muted-foreground"> · {pipe.brand_tagline ?? 'Powered by Firm Funds'}</span>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Mode</dt>
              <dd className="font-medium">
                {autoFire ? 'Auto-fire' : 'Manual review'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Last polled</dt>
              <dd className="font-medium">
                {pipe.last_polled_at
                  ? new Date(pipe.last_polled_at).toLocaleString('en-CA', { timeZone: 'America/Toronto' })
                  : 'Never (first poll pending)'}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Conditional tab</dt>
              <dd className="font-medium">{pipe.conditional_tab ?? '—'}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Watched tabs ({pipe.tabs_to_watch.length})</dt>
              <dd className="font-medium">
                {pipe.tabs_to_watch.length > 0 ? pipe.tabs_to_watch.join(', ') : '—'}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Column mapping</dt>
              <dd className="font-medium font-mono">
                {Object.keys(pipe.column_mapping).length === 0
                  ? '—'
                  : Object.entries(pipe.column_mapping).map(([k, v]) => `${k}=${v}`).join(', ')}
              </dd>
            </div>
            {pipe.sheet_url && (
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Sheet</dt>
                <dd className="font-medium truncate">
                  <a href={pipe.sheet_url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    {pipe.sheet_url}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </CardContent>
      </Card>

      <AutoFireToggleCard
        pipeId={pipe.pipe_id}
        brokerageName={brokerageName}
        autoFire={autoFire}
        setAutoFire={setAutoFire}
        validatedEvents={stats?.validated_events_lifetime ?? null}
      />

      <NotificationRecipientsCard
        pipeId={pipe.pipe_id}
        brokerageEmail={pipe.brokerage_email}
        brokerOfRecordEmail={pipe.broker_of_record_email}
        initial={pipe.notification_recipients}
      />

      <PipeStatisticsCard stats={stats} loading={statsLoading} error={statsError} />
    </div>
  )
}

// ----------------------------------------------------------------------------
// Auto-fire toggle (P2 #8) — Switch + confirmation modal. The modal quotes the
// lifetime count of validated (offer_sent) events for this brokerage so Bud
// has a concrete number to anchor his decision on.
// ----------------------------------------------------------------------------
function AutoFireToggleCard({
  pipeId,
  brokerageName,
  autoFire,
  setAutoFire,
  validatedEvents,
}: {
  pipeId: string
  brokerageName: string
  autoFire: boolean
  setAutoFire: (v: boolean) => void
  validatedEvents: number | null
}) {
  const [pendingValue, setPendingValue] = useState<boolean | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function handleSwitchChange(next: boolean) {
    // Open the confirmation modal instead of writing immediately. The Switch
    // visually flips back to the previous state until the user confirms,
    // because we bind it to `autoFire`, not `pendingValue`.
    setError(null)
    setPendingValue(next)
  }

  async function handleConfirm() {
    if (pendingValue === null) return
    setSubmitting(true)
    setError(null)
    const res = await setPipeAutoFire({ pipeId, enabled: pendingValue })
    setSubmitting(false)
    if (!res.success || !res.data) {
      setError(res.error ?? 'Failed to update mode.')
      return
    }
    setAutoFire(res.data.auto_fire_enabled)
    setPendingValue(null)
  }

  const enabling = pendingValue === true
  const disabling = pendingValue === false
  const dialogOpen = pendingValue !== null

  return (
    <Card>
      <CardContent className="py-4 px-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Zap className={`h-5 w-5 mt-0.5 ${autoFire ? 'text-amber-400' : 'text-muted-foreground'}`} aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">
                Auto-fire mode {autoFire ? 'enabled' : 'off'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {autoFire
                  ? 'New firm deals are offered to agents automatically, no admin review.'
                  : 'New firm deals queue for admin review before any offer is sent.'}
              </p>
            </div>
          </div>
          <Switch
            checked={autoFire}
            onCheckedChange={handleSwitchChange}
            aria-label="Toggle auto-fire mode"
          />
        </div>
      </CardContent>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!submitting && !open) {
            setPendingValue(null)
            setError(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {enabling ? (
                <>
                  <Zap className="h-4 w-4 text-amber-400" aria-hidden="true" />
                  Enable auto-fire for {brokerageName}?
                </>
              ) : (
                <>
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  Turn auto-fire off?
                </>
              )}
            </DialogTitle>
            <DialogDescription>
              {enabling ? (
                <>
                  Offers will be sent automatically — no admin click between firm deal detection and the agent&apos;s inbox.
                  {validatedEvents === null ? (
                    <> Stats are still loading…</>
                  ) : (
                    <> So far <span className="font-semibold text-foreground">{validatedEvents}</span> {validatedEvents === 1 ? 'offer has' : 'offers have'} been sent for this brokerage. Make sure parsing has been reliable before flipping this on.</>
                  )}
                </>
              ) : (
                <>New firm deal events will queue for manual review again until you re-enable auto-fire. Already-sent offers are unaffected.</>
              )}
            </DialogDescription>
          </DialogHeader>

          {error && (
            <p className="text-xs text-destructive flex items-start gap-1.5">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}

          <DialogFooter className="flex-row gap-2 sm:flex-row">
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setPendingValue(null); setError(null) }}
              disabled={submitting}
              className="flex-1 sm:flex-none"
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={submitting}
              size="sm"
              className={`flex-1 sm:flex-none ${enabling ? 'bg-amber-500 text-amber-50 hover:bg-amber-500/90' : ''}`}
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" aria-hidden="true" />}
              {enabling ? 'Enable auto-fire' : disabling ? 'Turn off' : 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// ----------------------------------------------------------------------------
// NotificationRecipientsCard
//
// Configures who gets the brokerage-facing email when an agent accepts a
// firm-deal offer. brokerages.email + the resolved Firm Funds inbox are
// always included (shown read-only here for context). Settings the admin
// can change:
//   - Override the Firm Funds inbox for this pipe (replaces the env-var
//     default, e.g. for a white-label routing copies elsewhere)
//   - Include the Broker of Record (uses brokerages.broker_of_record_email)
//   - Free-form list of extra emails (one per line, max 10)
//
// Save button is disabled until something changed vs. the loaded baseline,
// so an accidental load doesn't overwrite anything. Email validation
// happens server-side; client-side we only do the trim+dedup so the
// preview chips read cleanly.
// ----------------------------------------------------------------------------
function NotificationRecipientsCard({
  pipeId,
  brokerageEmail,
  brokerOfRecordEmail,
  initial,
}: {
  pipeId: string
  brokerageEmail: string | null
  brokerOfRecordEmail: string | null
  initial: NotificationRecipientsConfig
}) {
  const [includeBoR, setIncludeBoR] = useState(initial.include_broker_of_record)
  // Stored as a single string for the textarea; we split + clean on save.
  const [extraEmailsText, setExtraEmailsText] = useState(initial.extra_emails.join('\n'))
  // Empty input = use default. Stored as raw text so the field stays in
  // sync with what the admin actually typed; we clean on save.
  const [ffInboxOverrideText, setFfInboxOverrideText] = useState(initial.ff_inbox_override ?? '')
  const [savedConfig, setSavedConfig] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Parse the textarea into a clean list — trim, drop blanks, dedup
  // case-insensitively. Server validates RFC-lite shape on save; here we
  // only need a stable shape for the previewed chips and the dirty check.
  const cleanedExtraEmails = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const line of extraEmailsText.split(/[\n,]/)) {
      const v = line.trim().toLowerCase()
      if (!v) continue
      if (seen.has(v)) continue
      seen.add(v)
      out.push(v)
    }
    return out
  }, [extraEmailsText])

  // Resolved FF inbox — what the dispatcher will use right now. Empty
  // override falls back to the server-supplied default. Same precedence as
  // resolveFFInbox() on the dispatcher side.
  const cleanedFfOverride = ffInboxOverrideText.trim().toLowerCase()
  const resolvedFfInbox = cleanedFfOverride || initial.ff_inbox_default

  const dirty =
    includeBoR !== savedConfig.include_broker_of_record ||
    cleanedExtraEmails.length !== savedConfig.extra_emails.length ||
    cleanedExtraEmails.some((e, i) => e !== savedConfig.extra_emails[i]) ||
    (cleanedFfOverride || null) !== (savedConfig.ff_inbox_override ?? null)

  // Live preview of the full recipient list the dispatcher will use. Helps
  // Bud sanity-check before saving without having to look up the brokerage
  // record separately.
  const previewList = useMemo(() => {
    const list = new Set<string>()
    if (brokerageEmail) list.add(brokerageEmail.toLowerCase())
    list.add(resolvedFfInbox)
    if (includeBoR && brokerOfRecordEmail) list.add(brokerOfRecordEmail.toLowerCase())
    for (const e of cleanedExtraEmails) list.add(e)
    return Array.from(list)
  }, [brokerageEmail, brokerOfRecordEmail, includeBoR, cleanedExtraEmails, resolvedFfInbox])

  async function handleSave() {
    setSaving(true)
    setStatus(null)
    const res = await setPipeNotificationRecipients({
      pipeId,
      includeBrokerOfRecord: includeBoR,
      extraEmails: cleanedExtraEmails,
      ffInboxOverride: cleanedFfOverride || null,
    })
    setSaving(false)
    if (!res.success || !res.data) {
      setStatus({ type: 'error', text: res.error ?? 'Failed to save.' })
      return
    }
    setSavedConfig(res.data)
    setExtraEmailsText(res.data.extra_emails.join('\n'))
    setFfInboxOverrideText(res.data.ff_inbox_override ?? '')
    setStatus({ type: 'success', text: 'Saved. New offers will use this list.' })
  }

  return (
    <Card>
      <CardContent className="py-4 px-5 space-y-4">
        <div className="flex items-start gap-3">
          <Send className="h-5 w-5 mt-0.5 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">Offer notification recipients</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Who at the brokerage gets emailed the moment an agent accepts a firm-deal offer.
            </p>
          </div>
        </div>

        {/* Always-included recipients (read-only context) */}
        <div className="rounded-lg border border-border/40 bg-secondary/30 px-3 py-2 space-y-1">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/80">Always included</p>
          <ul className="text-xs text-foreground space-y-0.5">
            <li>
              <span className="text-muted-foreground">Brokerage main email:</span>{' '}
              <span className="font-mono">{brokerageEmail ?? <em className="text-status-amber">(none on file)</em>}</span>
            </li>
            <li>
              <span className="text-muted-foreground">Firm Funds inbox:</span>{' '}
              <span className="font-mono">{resolvedFfInbox}</span>
              {cleanedFfOverride && (
                <span className="ml-1.5 text-[10px] uppercase tracking-wider text-primary/80">(override)</span>
              )}
            </li>
          </ul>
        </div>

        {/* Firm Funds inbox override */}
        <div className="space-y-1.5">
          <Label htmlFor="ff-inbox-override" className="text-xs font-semibold text-foreground">
            Firm Funds inbox override
          </Label>
          <p className="text-[11px] text-muted-foreground">
            Replaces the default <span className="font-mono">{initial.ff_inbox_default}</span>{' '}for this brokerage&apos;s offer emails and the 4-hour internal escalation. Leave blank to use the default.
          </p>
          <input
            id="ff-inbox-override"
            type="email"
            value={ffInboxOverrideText}
            onChange={(e) => setFfInboxOverrideText(e.target.value)}
            placeholder={initial.ff_inbox_default}
            autoComplete="off"
            className="w-full px-3 py-2 rounded-lg text-xs font-mono bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
          />
        </div>

        {/* Broker of Record toggle */}
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border/40 px-3 py-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-foreground">Include Broker of Record</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {brokerOfRecordEmail
                ? <>Will CC <span className="font-mono">{brokerOfRecordEmail}</span> on every offer notification.</>
                : <span className="text-status-amber">No broker_of_record_email on file. Add one to the brokerage record before turning this on.</span>}
            </p>
          </div>
          <Switch
            checked={includeBoR}
            onCheckedChange={setIncludeBoR}
            disabled={!brokerOfRecordEmail}
            aria-label="Include Broker of Record on offer notifications"
          />
        </div>

        {/* Extra emails textarea */}
        <div className="space-y-1.5">
          <Label htmlFor="extra-emails" className="text-xs font-semibold text-foreground">
            Extra recipients
          </Label>
          <p className="text-[11px] text-muted-foreground">
            One email per line. Max 10. Use this for the office admin who actually does submissions if their email isn&apos;t the main brokerage contact.
          </p>
          <Textarea
            id="extra-emails"
            value={extraEmailsText}
            onChange={(e) => setExtraEmailsText(e.target.value)}
            placeholder={'jane.smith@brokerage.com\noffice@brokerage.com'}
            rows={4}
            className="font-mono text-xs"
          />
        </div>

        {/* Live preview */}
        <div className="rounded-lg border border-border/40 bg-background px-3 py-2">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground/80 mb-1.5">
            Preview ({previewList.length} {previewList.length === 1 ? 'recipient' : 'recipients'})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {previewList.map(email => (
              <span key={email} className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-md bg-primary/10 text-primary border border-primary/20">
                {email}
              </span>
            ))}
          </div>
        </div>

        {status && (
          <p className={`text-xs flex items-start gap-1.5 ${status.type === 'success' ? 'text-emerald-400' : 'text-destructive'}`}>
            {status.type === 'success'
              ? <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />
              : <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" aria-hidden="true" />}
            {status.text}
          </p>
        )}

        <div className="flex items-center justify-end">
          <Button
            onClick={handleSave}
            disabled={!dirty || saving}
            size="sm"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" aria-hidden="true" />}
            Save recipients
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ----------------------------------------------------------------------------
// Per-pipe statistics card (P2 #9) — 30-day funnel + last-event hints + top
// unresolved shorthands. Renders inline below the auto-fire toggle on the
// firm-deal-pipe page.
// ----------------------------------------------------------------------------
function PipeStatisticsCard({
  stats,
  loading,
  error,
}: {
  stats: PipeStatistics | null
  loading: boolean
  error: string | null
}) {
  if (loading) {
    return (
      <Card>
        <CardContent className="py-4 px-5">
          <Skeleton className="h-5 w-40 mb-3" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-14" />)}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="border-destructive">
        <CardContent className="py-4 px-5">
          <p className="text-xs text-destructive flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
            Statistics: {error}
          </p>
        </CardContent>
      </Card>
    )
  }

  if (!stats) return null

  return (
    <Card>
      <CardContent className="py-4 px-5 space-y-4">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" aria-hidden="true" />
          <p className="text-sm font-semibold text-foreground">Last 30 days</p>
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
            {stats.total_30d} {stats.total_30d === 1 ? 'event' : 'events'} total
          </span>
        </div>

        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <StatTile
            icon={<Send className="h-3.5 w-3.5" aria-hidden="true" />}
            label="Offers sent"
            value={stats.sent_30d}
            accent="text-emerald-400"
          />
          <StatTile
            icon={<Inbox className="h-3.5 w-3.5" aria-hidden="true" />}
            label="Awaiting review"
            value={stats.awaiting_review_30d}
            accent="text-amber-400"
          />
          <StatTile
            icon={<XCircle className="h-3.5 w-3.5" aria-hidden="true" />}
            label="Rejected"
            value={stats.rejected_30d}
            accent="text-muted-foreground"
          />
          <StatTile
            icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
            label="Errored"
            value={stats.errored_30d}
            accent={stats.errored_30d > 0 ? 'text-red-400' : 'text-muted-foreground'}
          />
        </dl>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs pt-3 border-t border-border/40">
          <div>
            <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Most recent poll</dt>
            <dd className="font-medium">
              {stats.last_polled_at
                ? new Date(stats.last_polled_at).toLocaleString('en-CA', { timeZone: 'America/Toronto' })
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Most recent event</dt>
            <dd className="font-medium">
              {stats.last_event_at
                ? new Date(stats.last_event_at).toLocaleString('en-CA', { timeZone: 'America/Toronto' })
                : 'None yet'}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Lifetime offers sent</dt>
            <dd className="font-medium">{stats.validated_events_lifetime}</dd>
          </div>
        </dl>

        {stats.unresolved_shorthands.length > 0 && (
          <div className="pt-3 border-t border-border/40">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              Top unresolved names (30d) — add mappings via the review queue
            </p>
            <ul className="space-y-1">
              {stats.unresolved_shorthands.map(s => (
                <li
                  key={s.shorthand}
                  className="flex items-center justify-between text-xs px-2 py-1 rounded-md bg-muted/20"
                >
                  <span className="font-mono truncate" title={s.shorthand}>{s.shorthand}</span>
                  <span className="text-muted-foreground tabular-nums">{s.count}×</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function StatTile({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode
  label: string
  value: number
  accent: string
}) {
  return (
    <div className="rounded-lg border border-border/40 bg-card/40 p-3">
      <div className={`flex items-center gap-1.5 ${accent}`}>
        {icon}
        <span className="text-[10px] uppercase tracking-wider opacity-80">{label}</span>
      </div>
      <p className="text-xl font-bold tabular-nums mt-1">{value}</p>
    </div>
  )
}

// ============================================================================
// Step container — common chrome (header strip, footer buttons)
// ============================================================================
function StepShell({
  step,
  title,
  description,
  children,
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
  nextBusy,
  hideNext,
}: {
  step: 1 | 2 | 3 | 4 | 5
  title: string
  description: string
  children: React.ReactNode
  onBack?: () => void
  onNext?: () => void
  nextLabel?: string
  nextDisabled?: boolean
  nextBusy?: boolean
  hideNext?: boolean
}) {
  return (
    <Card>
      <CardContent className="py-5 px-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Step {step} of 5</p>
            <p className="text-base font-semibold">{title}</p>
            <p className="text-xs text-muted-foreground mt-1">{description}</p>
          </div>
          <StepDots current={step} />
        </div>

        <div>{children}</div>

        <div className="flex items-center justify-between pt-2 border-t border-border/40">
          {onBack ? (
            <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              Back
            </Button>
          ) : <span />}
          {!hideNext && onNext && (
            <Button onClick={onNext} disabled={nextDisabled || nextBusy} size="sm" className="gap-1.5">
              {nextBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {nextLabel ?? 'Continue'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function StepDots({ current }: { current: 1 | 2 | 3 | 4 | 5 }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden="true">
      {[1, 2, 3, 4, 5].map(i => (
        <span
          key={i}
          className={`h-1.5 w-1.5 rounded-full ${i <= current ? 'bg-primary' : 'bg-muted'}`}
        />
      ))}
    </div>
  )
}

// ============================================================================
// The Wizard itself (rendered when no pipe exists yet)
// ============================================================================
interface WizardProps {
  step: 1 | 2 | 3 | 4 | 5
  setStep: (s: 1 | 2 | 3 | 4 | 5) => void
  // Step 1
  sheetInput: string
  setSheetInput: (s: string) => void
  sheetCheckLoading: boolean
  sheetCheckError: string | null
  serviceAccountEmail: string
  copied: boolean
  onCopyEmail: () => void
  onSheetCheck: () => void
  // Step 2
  tabs: string[]
  tabRoles: Record<string, TabRole>
  setTabRole: (t: string, r: TabRole) => void
  tabsStepValid: boolean
  conditionalTab: string
  watchedTabs: string[]
  // Step 3
  previewTab: string
  previewRows: string[][]
  previewLoading: boolean
  previewColCount: number
  columnRoles: Record<string, ColumnRole>
  setColumnRole: (l: string, r: ColumnRole) => void
  columnsStepValid: boolean
  loadPreview: (tab: string) => void
  // Step 4
  brandName: string
  setBrandName: (s: string) => void
  brandTagline: string
  setBrandTagline: (s: string) => void
  // Step 5
  sheetUrl: string
  onCreate: () => void
  submitting: boolean
  submitMessage: string | null
  brokerageName: string
}

function Wizard(props: WizardProps) {
  if (props.step === 1) {
    return (
      <StepShell
        step={1}
        title="Share the sheet with Firm Funds"
        description="Paste the Google Sheets URL or ID. We'll check that we have read access."
        onNext={props.onSheetCheck}
        nextLabel="Check access"
        nextBusy={props.sheetCheckLoading}
        nextDisabled={!props.sheetInput.trim()}
      >
        <div className="space-y-3">
          <div>
            <label htmlFor="sheet-input" className="block text-xs font-medium text-muted-foreground mb-1">
              Google Sheets URL or ID
            </label>
            <input
              id="sheet-input"
              type="text"
              value={props.sheetInput}
              onChange={(e) => props.setSheetInput(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              className="w-full px-3 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
            />
          </div>

          {props.sheetCheckError && (
            <div className="rounded-md border border-amber-700/40 bg-amber-950/20 px-3 py-2">
              <p className="text-xs text-amber-300 flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                <span>{props.sheetCheckError}</span>
              </p>
              {props.serviceAccountEmail && /access|share|viewer/i.test(props.sheetCheckError) && (
                <ServiceAccountCopyRow
                  email={props.serviceAccountEmail}
                  copied={props.copied}
                  onCopy={props.onCopyEmail}
                />
              )}
            </div>
          )}

          <div className="rounded-md border border-border/40 bg-muted/15 px-3 py-2.5 space-y-2">
            <p className="text-xs font-semibold text-foreground">Before checking access</p>
            <ol className="text-xs text-muted-foreground list-decimal ml-4 space-y-1">
              <li>Open the brokerage&apos;s Google Sheet.</li>
              <li>Click <span className="font-semibold text-foreground">Share</span> (top right).</li>
              <li>
                Add this email as a <span className="font-semibold text-foreground">Viewer</span>:
              </li>
            </ol>
            <ServiceAccountCopyRow
              email={props.serviceAccountEmail}
              copied={props.copied}
              onCopy={props.onCopyEmail}
            />
          </div>
        </div>
      </StepShell>
    )
  }

  if (props.step === 2) {
    return (
      <StepShell
        step={2}
        title="Classify each tab"
        description="Pick the Conditional tab (the holding tab — exactly one) and the month tabs to watch."
        onBack={() => props.setStep(1)}
        onNext={() => props.setStep(3)}
        nextDisabled={!props.tabsStepValid}
      >
        <div className="space-y-2">
          {props.tabs.map(tab => (
            <div
              key={tab}
              className="flex flex-wrap items-center gap-3 rounded-md border border-border/40 bg-card/40 px-3 py-2"
            >
              <span className="text-sm font-medium flex-1 min-w-[120px] truncate">{tab}</span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {(['conditional', 'watch', 'ignore'] as TabRole[]).map(role => (
                  <button
                    key={role}
                    type="button"
                    onClick={() => props.setTabRole(tab, role)}
                    className={`text-xs px-2.5 py-1 rounded-md border transition ${
                      props.tabRoles[tab] === role
                        ? role === 'conditional'
                          ? 'bg-amber-500/15 border-amber-500/50 text-amber-300'
                          : role === 'watch'
                            ? 'bg-emerald-500/15 border-emerald-500/50 text-emerald-300'
                            : 'bg-muted border-border/50 text-muted-foreground'
                        : 'border-border/40 text-muted-foreground hover:border-primary/40 hover:text-foreground'
                    }`}
                    aria-pressed={props.tabRoles[tab] === role}
                  >
                    {role === 'conditional' ? 'Conditional' : role === 'watch' ? 'Watch' : 'Ignore'}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 rounded-md border border-border/40 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">Conditional:</span> the holding tab where pending deals sit before they firm.
          </p>
          <p>
            <span className="font-semibold text-foreground">Watch:</span> month tabs where firm deals land. Each move from Conditional → here fires a deal event.
          </p>
          <p>
            <span className="font-semibold text-foreground">Ignore:</span> everything else (archives, lookups, summaries).
          </p>
        </div>

        {!props.tabsStepValid && (
          <p className="text-xs text-amber-300 mt-2 flex items-center gap-1.5">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            Pick one Conditional tab and at least one Watch tab to continue.
          </p>
        )}
      </StepShell>
    )
  }

  if (props.step === 3) {
    const cols = Array.from({ length: props.previewColCount }, (_, i) => indexToColumnLetter(i))
    const header = props.previewRows[0] ?? []
    const dataRows = props.previewRows.slice(1)

    return (
      <StepShell
        step={3}
        title="Map the columns"
        description="Tag each column on a watched tab. Address is required, plus at least one of Listing or Selling agent."
        onBack={() => props.setStep(2)}
        onNext={() => props.setStep(4)}
        nextDisabled={!props.columnsStepValid}
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-muted-foreground">Preview tab:</label>
            <select
              value={props.previewTab}
              onChange={(e) => props.loadPreview(e.target.value)}
              className="text-xs bg-background border border-border rounded px-2 py-1"
            >
              {props.watchedTabs.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            {props.previewLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />}
          </div>

          {/* Mapping picker — one row per column letter. */}
          <div className="overflow-x-auto rounded-md border border-border/40">
            <table className="text-xs w-full">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-left px-2 py-1.5 font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Col</th>
                  <th className="text-left px-2 py-1.5 font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Header</th>
                  <th className="text-left px-2 py-1.5 font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Sample</th>
                  <th className="text-left px-2 py-1.5 font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Role</th>
                </tr>
              </thead>
              <tbody>
                {cols.map(letter => {
                  const idx = letterIdx(letter)
                  const headerVal = String(header[idx] ?? '').trim()
                  const samples = dataRows
                    .map(r => String(r[idx] ?? '').trim())
                    .filter(Boolean)
                    .slice(0, 2)
                  return (
                    <tr key={letter} className="border-t border-border/30">
                      <td className="px-2 py-1.5 font-mono text-muted-foreground">{letter}</td>
                      <td className="px-2 py-1.5 font-medium text-foreground max-w-[160px] truncate">{headerVal || <span className="text-muted-foreground italic">(blank)</span>}</td>
                      <td className="px-2 py-1.5 text-muted-foreground max-w-[200px] truncate" title={samples.join(' · ')}>
                        {samples.length > 0 ? samples.join(' · ') : <span className="italic">(empty)</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        <select
                          value={props.columnRoles[letter] ?? 'ignore'}
                          onChange={(e) => props.setColumnRole(letter, e.target.value as ColumnRole)}
                          className="text-xs bg-background border border-border rounded px-1.5 py-0.5"
                          aria-label={`Column ${letter} role`}
                        >
                          {(Object.keys(COLUMN_ROLE_LABELS) as ColumnRole[]).map(role => (
                            <option key={role} value={role}>{COLUMN_ROLE_LABELS[role]}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {!props.columnsStepValid && (
            <p className="text-xs text-amber-300 flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              Required: Address, and at least one of Listing agent / Selling agent.
            </p>
          )}
        </div>
      </StepShell>
    )
  }

  if (props.step === 4) {
    return (
      <StepShell
        step={4}
        title="Brand the outbound offer"
        description="What name and tagline should appear on emails and SMS to this brokerage's agents?"
        onBack={() => props.setStep(3)}
        onNext={() => props.setStep(5)}
        nextDisabled={!props.brandName.trim()}
      >
        <div className="space-y-3">
          <div>
            <label htmlFor="brand-name" className="block text-xs font-medium text-muted-foreground mb-1">
              Brand name <span className="text-amber-300">*</span>
            </label>
            <input
              id="brand-name"
              type="text"
              value={props.brandName}
              onChange={(e) => props.setBrandName(e.target.value)}
              placeholder={`${props.brokerageName} Advances`}
              className="w-full px-3 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
            />
            <p className="text-[10px] mt-1 text-muted-foreground">
              Shows in email subject lines and SMS sender attribution. Choice Realty uses &ldquo;Choice Advances&rdquo;.
            </p>
          </div>
          <div>
            <label htmlFor="brand-tagline" className="block text-xs font-medium text-muted-foreground mb-1">
              Tagline
            </label>
            <input
              id="brand-tagline"
              type="text"
              value={props.brandTagline}
              onChange={(e) => props.setBrandTagline(e.target.value)}
              placeholder="Powered by Firm Funds"
              className="w-full px-3 py-2 rounded-lg text-sm bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
            />
            <p className="text-[10px] mt-1 text-muted-foreground">
              Appears in the email footer. Defaults to &ldquo;Powered by Firm Funds&rdquo; for the standard white-label arrangement.
            </p>
          </div>
        </div>
      </StepShell>
    )
  }

  // Step 5
  const mapping: Record<string, string> = {}
  for (const [letter, role] of Object.entries(props.columnRoles)) {
    if (role === 'ignore') continue
    mapping[role] = letter
  }

  const created = !!props.submitMessage && !/fail|error/i.test(props.submitMessage)

  return (
    <StepShell
      step={5}
      title="Confirm and create"
      description="Review the configuration before creating the pipe. Manual review mode is on by default; flip to auto-fire later in SQL."
      onBack={() => props.setStep(4)}
      onNext={props.onCreate}
      nextLabel={created ? 'Created' : 'Create pipe'}
      nextBusy={props.submitting}
      nextDisabled={created}
    >
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
        <div>
          <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Brokerage</dt>
          <dd className="font-medium">{props.brokerageName}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Mode</dt>
          <dd className="font-medium">Manual review (auto-fire off)</dd>
        </div>
        <div>
          <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Brand</dt>
          <dd className="font-medium">{props.brandName || '—'} · {props.brandTagline || '—'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Conditional tab</dt>
          <dd className="font-medium">{props.tabRoles && Object.entries(props.tabRoles).find(([, r]) => r === 'conditional')?.[0] || '—'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Watched tabs ({props.watchedTabs.length})</dt>
          <dd className="font-medium">{props.watchedTabs.join(', ') || '—'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Column mapping</dt>
          <dd className="font-medium font-mono">
            {Object.entries(mapping).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}
          </dd>
        </div>
        {props.sheetUrl && (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground uppercase tracking-wider text-[10px]">Sheet</dt>
            <dd className="font-medium truncate">
              <a href={props.sheetUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                {props.sheetUrl}
              </a>
            </dd>
          </div>
        )}
      </dl>

      {props.submitMessage && (
        <div
          className={`mt-3 rounded-md border px-3 py-2 text-xs flex items-start gap-2 ${
            created
              ? 'border-emerald-700/40 bg-emerald-950/15 text-emerald-300'
              : 'border-destructive bg-destructive/10 text-destructive'
          }`}
        >
          {created ? (
            <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          )}
          <span>{props.submitMessage}</span>
        </div>
      )}

      {created && (
        <div className="mt-2 flex justify-end">
          <Link
            href="/admin/firm-deal-review"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1.5"
          >
            Go to Firm Deal Review
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
      )}
    </StepShell>
  )
}

// ============================================================================
// Helpers
// ============================================================================
function letterIdx(letter: string): number {
  let n = 0
  for (const c of letter.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64)
  return n - 1
}

function ServiceAccountCopyRow({
  email,
  copied,
  onCopy,
}: {
  email: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-background px-2 py-1.5">
      <code className="text-[11px] font-mono text-foreground truncate flex-1">{email || 'loading…'}</code>
      <Button
        variant="ghost"
        size="sm"
        onClick={onCopy}
        disabled={!email}
        className="h-6 px-2 text-[11px] gap-1"
        aria-label="Copy service account email"
      >
        {copied ? (
          <>
            <CheckCircle2 className="h-3 w-3 text-emerald-400" aria-hidden="true" />
            Copied
          </>
        ) : (
          <>
            <ClipboardCopy className="h-3 w-3" aria-hidden="true" />
            Copy
          </>
        )}
      </Button>
    </div>
  )
}

