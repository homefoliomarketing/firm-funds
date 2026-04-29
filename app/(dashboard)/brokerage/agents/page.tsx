'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft, UserPlus, Mail, Send, Edit, X, CheckCircle2, Clock, AlertCircle, Loader2,
} from 'lucide-react'
import {
  addAgentAsBrokerage, brokerageResendWelcomeEmail, brokerageUpdateAgentContact,
} from '@/lib/actions/brokerage-actions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

interface AgentRow {
  id: string
  first_name: string
  last_name: string
  email: string | null
  phone: string | null
  reco_number: string | null
  status: string
  kyc_status: string | null
  banking_approval_status: string | null
  account_activated_at: string | null
  welcome_email_sent_at: string | null
}

function activationBadge(agent: AgentRow): { label: string; cls: string } {
  if (agent.account_activated_at) {
    return { label: 'Activated', cls: 'bg-primary/15 text-primary border border-primary/30' }
  }
  if (!agent.email) {
    return { label: 'No email', cls: 'bg-muted text-muted-foreground border border-border' }
  }
  if (!agent.welcome_email_sent_at) {
    return { label: 'Not invited', cls: 'bg-muted text-muted-foreground border border-border' }
  }
  if (agent.kyc_status !== 'verified') {
    return { label: 'KYC pending', cls: 'bg-status-amber-muted/40 text-status-amber border border-status-amber-border/40' }
  }
  if (agent.banking_approval_status !== 'approved') {
    return { label: 'Banking pending', cls: 'bg-status-amber-muted/40 text-status-amber border border-status-amber-border/40' }
  }
  return { label: 'In setup', cls: 'bg-status-blue-muted/40 text-status-blue border border-status-blue-border/40' }
}

export default function BrokerageAgentsPage() {
  const router = useRouter()
  const supabase = createClient()
  const [profile, setProfile] = useState<any>(null)
  const [brokerage, setBrokerage] = useState<any>(null)
  const [agents, setAgents] = useState<AgentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Add agent form
  const [showAddForm, setShowAddForm] = useState(false)
  const [addBusy, setAddBusy] = useState(false)
  const [addFirstName, setAddFirstName] = useState('')
  const [addLastName, setAddLastName] = useState('')
  const [addEmail, setAddEmail] = useState('')
  const [addPhone, setAddPhone] = useState('')
  const [addRecoNumber, setAddRecoNumber] = useState('')

  // Edit-contact state per agent (id of agent currently being edited)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editEmail, setEditEmail] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [editRecoNumber, setEditRecoNumber] = useState('')
  const [editBusy, setEditBusy] = useState(false)

  // Resend welcome state
  const [resendingId, setResendingId] = useState<string | null>(null)

  const loadAgents = async (brokerageId: string) => {
    const { data } = await supabase
      .from('agents')
      .select('id, first_name, last_name, email, phone, reco_number, status, kyc_status, banking_approval_status, account_activated_at, welcome_email_sent_at')
      .eq('brokerage_id', brokerageId)
      .neq('status', 'archived')
      .order('last_name')
    setAgents((data || []) as AgentRow[])
  }

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: prof } = await supabase.from('user_profiles').select('*').eq('id', user.id).single()
      if (!prof || prof.role !== 'brokerage_admin' || !prof.brokerage_id) { router.push('/login'); return }
      setProfile(prof)
      const { data: brok } = await supabase.from('brokerages').select('*').eq('id', prof.brokerage_id).single()
      setBrokerage(brok)
      await loadAgents(prof.brokerage_id)
      setLoading(false)
    }
    load()
  }, [])

  const flashStatus = (msg: { type: 'success' | 'error'; text: string }) => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 5000)
  }

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!addFirstName.trim() || !addLastName.trim()) {
      flashStatus({ type: 'error', text: 'First and last name are required' }); return
    }
    setAddBusy(true)
    const result = await addAgentAsBrokerage({
      firstName: addFirstName.trim(),
      lastName: addLastName.trim(),
      email: addEmail.trim() || null,
      phone: addPhone.trim() || undefined,
      recoNumber: addRecoNumber.trim() || undefined,
    })
    if (result.success) {
      const welcomeSent = (result.data as any)?.welcomeSent
      flashStatus({ type: 'success', text: welcomeSent ? 'Agent added and welcome email sent' : 'Agent added — no email on file, welcome email not sent' })
      setAddFirstName(''); setAddLastName(''); setAddEmail(''); setAddPhone(''); setAddRecoNumber('')
      setShowAddForm(false)
      if (profile?.brokerage_id) await loadAgents(profile.brokerage_id)
    } else {
      flashStatus({ type: 'error', text: result.error || 'Failed to add agent' })
    }
    setAddBusy(false)
  }

  const handleEditOpen = (a: AgentRow) => {
    setEditingId(a.id)
    setEditEmail(a.email || '')
    setEditPhone(a.phone || '')
    setEditRecoNumber(a.reco_number || '')
  }
  const handleEditSave = async () => {
    if (!editingId) return
    setEditBusy(true)
    const result = await brokerageUpdateAgentContact({
      agentId: editingId,
      email: editEmail.trim() || null,
      phone: editPhone.trim() || null,
      recoNumber: editRecoNumber.trim() || null,
    })
    if (result.success) {
      flashStatus({ type: 'success', text: 'Agent updated' })
      setEditingId(null)
      if (profile?.brokerage_id) await loadAgents(profile.brokerage_id)
    } else {
      flashStatus({ type: 'error', text: result.error || 'Failed to update agent' })
    }
    setEditBusy(false)
  }

  const handleResend = async (a: AgentRow) => {
    if (!a.email) {
      flashStatus({ type: 'error', text: 'Add an email first' }); return
    }
    setResendingId(a.id)
    const result = await brokerageResendWelcomeEmail({ agentId: a.id })
    if (result.success) {
      flashStatus({ type: 'success', text: `Welcome email sent to ${a.first_name} ${a.last_name}` })
      if (profile?.brokerage_id) await loadAgents(profile.brokerage_id)
    } else {
      flashStatus({ type: 'error', text: result.error || 'Failed to send' })
    }
    setResendingId(null)
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const activatedCount = agents.filter(a => a.account_activated_at).length
  const pendingCount = agents.length - activatedCount

  return (
    <div className="min-h-screen bg-background">
      <header className="bg-card/80 backdrop-blur-sm border-b border-border/50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center gap-3">
          <button onClick={() => router.push('/brokerage')} className="p-1.5 rounded-lg text-white/50 hover:text-primary" aria-label="Back">
            <ArrowLeft size={16} />
          </button>
          <img src="/brand/white.png" alt="Firm Funds" className="h-10 w-auto" />
          <div className="w-px h-8 bg-white/15 hidden sm:block" />
          <p className="text-sm font-medium text-white hidden sm:block">Agents{brokerage ? ` — ${brokerage.name}` : ''}</p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Your roster</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {agents.length} agent{agents.length === 1 ? '' : 's'} · {activatedCount} activated · {pendingCount} in setup
            </p>
          </div>
          <Button onClick={() => setShowAddForm(s => !s)} className="bg-primary text-primary-foreground hover:bg-primary/90">
            <UserPlus size={14} className="mr-1" /> Add agent
          </Button>
        </div>

        {statusMsg && (
          <div className={`rounded-lg px-4 py-3 text-sm ${statusMsg.type === 'success' ? 'bg-primary/10 text-primary border border-primary/30' : 'bg-destructive/10 text-destructive border border-destructive/30'}`}>
            {statusMsg.text}
          </div>
        )}

        {showAddForm && (
          <Card>
            <CardHeader><CardTitle className="text-base">Add a new agent</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={handleAdd} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="firstName">First name <span className="text-destructive">*</span></Label>
                  <Input id="firstName" required value={addFirstName} onChange={(e) => setAddFirstName(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="lastName">Last name <span className="text-destructive">*</span></Label>
                  <Input id="lastName" required value={addLastName} onChange={(e) => setAddLastName(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="If provided, welcome email will be sent" />
                </div>
                <div>
                  <Label htmlFor="phone">Phone</Label>
                  <Input id="phone" type="tel" value={addPhone} onChange={(e) => setAddPhone(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="reco">RECO #</Label>
                  <Input id="reco" value={addRecoNumber} onChange={(e) => setAddRecoNumber(e.target.value)} />
                </div>
                <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
                  <Button type="button" variant="outline" onClick={() => setShowAddForm(false)}>Cancel</Button>
                  <Button type="submit" disabled={addBusy} className="bg-primary text-primary-foreground hover:bg-primary/90">
                    {addBusy ? 'Adding…' : <>Add agent <Send size={14} className="ml-1" /></>}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {/* Agents table */}
        <Card>
          <CardContent className="p-0">
            {agents.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">No active agents on roster yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs uppercase tracking-wider text-muted-foreground border-b border-border">
                    <tr>
                      <th className="text-left px-4 py-3 font-semibold">Name</th>
                      <th className="text-left px-4 py-3 font-semibold">Email</th>
                      <th className="text-left px-4 py-3 font-semibold">Activation</th>
                      <th className="text-left px-4 py-3 font-semibold">Welcome sent</th>
                      <th className="text-right px-4 py-3 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {agents.map(a => {
                      const badge = activationBadge(a)
                      const isEditing = editingId === a.id
                      return (
                        <tr key={a.id} className="hover:bg-muted/30">
                          <td className="px-4 py-3">
                            <div className="font-medium text-foreground">{a.first_name} {a.last_name}</div>
                            {a.reco_number && <div className="text-[11px] text-muted-foreground/70 mt-0.5">RECO: {a.reco_number}</div>}
                          </td>
                          <td className="px-4 py-3">
                            {isEditing ? (
                              <div className="space-y-1">
                                <Input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="email@…" type="email" className="h-8 text-xs" />
                                <Input value={editPhone} onChange={(e) => setEditPhone(e.target.value)} placeholder="phone" type="tel" className="h-8 text-xs" />
                                <Input value={editRecoNumber} onChange={(e) => setEditRecoNumber(e.target.value)} placeholder="RECO #" className="h-8 text-xs" />
                              </div>
                            ) : (
                              <div>
                                <div className="text-foreground">{a.email || <span className="text-muted-foreground italic">No email</span>}</div>
                                {a.phone && <div className="text-[11px] text-muted-foreground/70 mt-0.5">{a.phone}</div>}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded ${badge.cls}`}>
                              {a.account_activated_at && <CheckCircle2 size={10} />}
                              {!a.account_activated_at && a.welcome_email_sent_at && <Clock size={10} />}
                              {!a.welcome_email_sent_at && !a.account_activated_at && <AlertCircle size={10} />}
                              {badge.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {a.welcome_email_sent_at ? new Date(a.welcome_email_sent_at).toLocaleDateString('en-CA') : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-2">
                              {isEditing ? (
                                <>
                                  <Button size="sm" variant="outline" onClick={() => setEditingId(null)} disabled={editBusy}>
                                    <X size={12} />
                                  </Button>
                                  <Button size="sm" disabled={editBusy} onClick={handleEditSave}>
                                    {editBusy ? 'Saving…' : 'Save'}
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Button size="sm" variant="outline" onClick={() => handleEditOpen(a)} title="Edit contact">
                                    <Edit size={12} />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={!a.email || resendingId === a.id || !!a.account_activated_at}
                                    onClick={() => handleResend(a)}
                                    title={!a.email ? 'Add email first' : a.account_activated_at ? 'Already activated' : 'Send welcome email'}
                                  >
                                    {resendingId === a.id ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
                                  </Button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  )
}
