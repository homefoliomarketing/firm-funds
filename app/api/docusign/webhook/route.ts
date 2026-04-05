import { createServiceRoleClient } from '@/lib/supabase/server'

// DocuSign Connect webhook — receives envelope status updates
// Configure in DocuSign: Settings → Connect → Add Configuration
// URL: https://firmfunds.ca/api/docusign/webhook

export async function POST(request: Request) {
  try {
    const body = await request.text()
    let payload: any

    // DocuSign sends XML by default, but we'll configure it for JSON
    // Try JSON first, fall back to treating as XML error
    try {
      payload = JSON.parse(body)
    } catch {
      console.error('DocuSign webhook: received non-JSON payload')
      return new Response('OK', { status: 200 }) // Always return 200 to DocuSign
    }

    const envelopeId = payload?.envelopeId || payload?.EnvelopeStatus?.EnvelopeID
    const envelopeStatus = payload?.status || payload?.EnvelopeStatus?.Status

    if (!envelopeId) {
      console.error('DocuSign webhook: no envelopeId in payload')
      return new Response('OK', { status: 200 })
    }

    console.log(`DocuSign webhook: envelope ${envelopeId} status: ${envelopeStatus}`)

    const supabase = createServiceRoleClient()

    // Find our envelope records
    const { data: envelopes, error: fetchErr } = await supabase
      .from('esignature_envelopes')
      .select('*')
      .eq('envelope_id', envelopeId)

    if (fetchErr || !envelopes || envelopes.length === 0) {
      console.error('DocuSign webhook: envelope not found in DB:', envelopeId)
      return new Response('OK', { status: 200 })
    }

    // Map DocuSign status to our status
    const statusMap: Record<string, string> = {
      'sent': 'sent',
      'delivered': 'delivered',
      'completed': 'signed',
      'declined': 'declined',
      'voided': 'voided',
    }

    const mappedStatus = statusMap[envelopeStatus?.toLowerCase()] || envelopeStatus?.toLowerCase()

    // Update envelope records
    const updateData: Record<string, any> = {
      status: mappedStatus,
    }

    if (mappedStatus === 'signed') {
      updateData.completed_at = new Date().toISOString()
      updateData.agent_signer_status = 'signed'
      updateData.agent_signed_at = new Date().toISOString()
    } else if (mappedStatus === 'delivered') {
      updateData.agent_signer_status = 'delivered'
    } else if (mappedStatus === 'declined') {
      updateData.agent_signer_status = 'declined'
    } else if (mappedStatus === 'voided') {
      updateData.voided_at = new Date().toISOString()
    }

    // Check individual recipient statuses if available
    const recipients = payload?.recipients?.signers || []
    for (const signer of recipients) {
      if (signer.recipientId === '1') {
        // Agent signer
        const signerStatus = signer.status?.toLowerCase()
        if (signerStatus === 'completed') {
          updateData.agent_signer_status = 'signed'
          updateData.agent_signed_at = signer.signedDateTime || new Date().toISOString()
        } else if (signerStatus === 'declined') {
          updateData.agent_signer_status = 'declined'
        } else if (signerStatus === 'delivered') {
          updateData.agent_signer_status = 'delivered'
        }
      }
    }

    const { error: updateErr } = await supabase
      .from('esignature_envelopes')
      .update(updateData)
      .eq('envelope_id', envelopeId)

    if (updateErr) {
      console.error('DocuSign webhook: failed to update envelope:', updateErr.message)
    }

    // If all signed, auto-check the underwriting checklist items
    if (mappedStatus === 'signed') {
      const dealId = envelopes[0].deal_id

      // Check item 11: "Commission Purchase Agreement - Signed and Executed"
      await supabase
        .from('underwriting_checklist')
        .update({
          is_checked: true,
          checked_by: 'system',
          checked_at: new Date().toISOString(),
          notes: `Auto-checked: DocuSign envelope ${envelopeId} completed`,
        })
        .eq('deal_id', dealId)
        .ilike('checklist_item', '%Commission Purchase Agreement%')
        .eq('is_checked', false)

      // Check item 12: "Irrevocable Direction to Pay - Signed and Executed"
      await supabase
        .from('underwriting_checklist')
        .update({
          is_checked: true,
          checked_by: 'system',
          checked_at: new Date().toISOString(),
          notes: `Auto-checked: DocuSign envelope ${envelopeId} completed`,
        })
        .eq('deal_id', dealId)
        .ilike('checklist_item', '%Irrevocable Direction to Pay%')
        .eq('is_checked', false)

      console.log(`DocuSign webhook: auto-checked CPA + IDP checklist items for deal ${dealId}`)
    }

    return new Response('OK', { status: 200 })
  } catch (err: any) {
    console.error('DocuSign webhook error:', err?.message)
    // Always return 200 — DocuSign retries on non-200 and we don't want to loop
    return new Response('OK', { status: 200 })
  }
}
