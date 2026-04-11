import { createServiceRoleClient } from '@/lib/supabase/server'
import { getValidAccessToken } from '@/lib/docusign'

// DocuSign Connect webhook — receives envelope status updates
// Configure in DocuSign: Settings → Connect → Add Configuration
// URL: https://firmfunds.ca/api/docusign/webhook
// Data Format: REST v2.1 (JSON)
// Event Delivery Mode: Aggregate

export async function POST(request: Request) {
  try {
    const body = await request.text()
    let payload: any

    // DocuSign sends JSON when configured for REST v2.1
    try {
      payload = JSON.parse(body)
    } catch {
      console.error('DocuSign webhook: received non-JSON payload')
      return new Response('OK', { status: 200 })
    }

    const envelopeId = payload?.envelopeId || payload?.data?.envelopeId || payload?.EnvelopeStatus?.EnvelopeID

    // DocuSign Connect (REST v2.1, aggregate mode) sends status via the `event` field
    // (e.g. "envelope-sent", "envelope-completed"), not via a top-level `status` field.
    // Fall back through the older XML/SOAP shapes for safety, but the event name is the
    // authoritative source on the current configuration.
    const eventName: string | undefined = payload?.event
    const eventToStatus: Record<string, string> = {
      'envelope-sent': 'sent',
      'envelope-delivered': 'delivered',
      'envelope-completed': 'completed',
      'envelope-declined': 'declined',
      'envelope-voided': 'voided',
      'recipient-completed': 'completed',
    }
    const envelopeStatus =
      payload?.status ||
      payload?.data?.envelopeSummary?.status ||
      payload?.EnvelopeStatus?.Status ||
      (eventName ? eventToStatus[eventName] : undefined)

    if (!envelopeId) {
      console.error('DocuSign webhook: no envelopeId in payload')
      return new Response('OK', { status: 200 })
    }

    console.log(`DocuSign webhook: envelope ${envelopeId} status: ${envelopeStatus}`)

    const supabase = createServiceRoleClient()

    // Find our envelope records (one per document in this envelope)
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

    // Build envelope update data
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
    const recipients = payload?.recipients?.signers || payload?.data?.envelopeSummary?.recipients?.signers || []
    for (const signer of recipients) {
      if (signer.recipientId === '1') {
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

    // Update all envelope records for this envelopeId
    const { error: updateErr } = await supabase
      .from('esignature_envelopes')
      .update(updateData)
      .eq('envelope_id', envelopeId)

    if (updateErr) {
      console.error('DocuSign webhook: failed to update envelope:', updateErr.message)
    }

    // ================================================================
    // SIGNED — Download docs, store them, link to checklist, check off
    // ================================================================
    if (mappedStatus === 'signed') {
      // Determine if this is a BCA (brokerage-level) or deal-level envelope
      const isBca = envelopes[0].document_type === 'bca'

      if (isBca) {
        // ============================================================
        // BCA ENVELOPE — Brokerage Cooperation Agreement
        // ============================================================
        const brokerageId = envelopes[0].brokerage_id
        console.log(`DocuSign webhook: BCA signed — downloading doc for brokerage ${brokerageId}`)

        const auth = await getValidAccessToken()

        if (auth && brokerageId) {
          try {
            // 1. Download signed BCA PDF from DocuSign (documentId '1' — only one doc)
            const docRes = await fetch(
              `${auth.baseUri}/restapi/v2.1/accounts/${auth.accountId}/envelopes/${envelopeId}/documents/1`,
              { headers: { 'Authorization': `Bearer ${auth.accessToken}` } }
            )

            if (docRes.ok) {
              const pdfBuffer = await docRes.arrayBuffer()
              const pdfBytes = new Uint8Array(pdfBuffer)

              // 2. Upload to Supabase storage (brokerage-level path)
              const timestamp = Date.now()
              const randomId = crypto.randomUUID()
              const storagePath = `brokerage-bca/${brokerageId}/${timestamp}_${randomId}.pdf`

              const { error: uploadErr } = await supabase.storage
                .from('deal-documents')
                .upload(storagePath, pdfBytes, {
                  contentType: 'application/pdf',
                  upsert: false,
                })

              if (uploadErr) {
                console.error('DocuSign webhook: failed to upload BCA to storage:', uploadErr.message)
              } else {
                console.log(`DocuSign webhook: stored signed BCA at ${storagePath}`)
              }
            } else {
              console.error(`DocuSign webhook: failed to download BCA doc: ${docRes.status}`)
            }
          } catch (docErr: any) {
            console.error('DocuSign webhook: error processing BCA document:', docErr?.message)
          }

          // 3. Update bca_signed_at on the brokerage record
          const { error: bcaUpdateErr } = await supabase
            .from('brokerages')
            .update({ bca_signed_at: new Date().toISOString() })
            .eq('id', brokerageId)

          if (bcaUpdateErr) {
            console.error('DocuSign webhook: failed to update bca_signed_at:', bcaUpdateErr.message)
          } else {
            console.log(`DocuSign webhook: brokerage ${brokerageId} bca_signed_at updated`)
          }
        } else {
          console.error(`DocuSign webhook: no valid auth token — cannot download signed BCA for brokerage ${brokerageId}`)
        }

        console.log(`DocuSign webhook: completed BCA processing for brokerage ${brokerageId}`)

      } else {
        // ============================================================
        // DEAL ENVELOPE — CPA + IDP (existing logic, unchanged)
        // ============================================================
        const dealId = envelopes[0].deal_id
        console.log(`DocuSign webhook: envelope signed — downloading docs for deal ${dealId}`)

        // Get DocuSign auth token for API calls
        const auth = await getValidAccessToken()

        if (auth) {
          // Process each document in the envelope (CPA = docId 1, IDP = docId 2)
          for (const envelope of envelopes) {
            const docType = envelope.document_type // 'cpa' or 'idp'
            const docId = docType === 'cpa' ? '1' : '2'

            try {
              // 1. Download the signed PDF from DocuSign
              const docRes = await fetch(
                `${auth.baseUri}/restapi/v2.1/accounts/${auth.accountId}/envelopes/${envelopeId}/documents/${docId}`,
                { headers: { 'Authorization': `Bearer ${auth.accessToken}` } }
              )

              if (!docRes.ok) {
                console.error(`DocuSign webhook: failed to download ${docType} doc: ${docRes.status}`)
                continue
              }

              const pdfBuffer = await docRes.arrayBuffer()
              const pdfBytes = new Uint8Array(pdfBuffer)

              // 2. Upload to Supabase storage
              const timestamp = Date.now()
              const randomId = crypto.randomUUID()
              const fileName = docType === 'cpa'
                ? `Commission_Purchase_Agreement_Signed.pdf`
                : `Irrevocable_Direction_to_Pay_Signed.pdf`
              const storagePath = `${dealId}/${timestamp}_${randomId}.pdf`

              const { error: uploadErr } = await supabase.storage
                .from('deal-documents')
                .upload(storagePath, pdfBytes, {
                  contentType: 'application/pdf',
                  upsert: false,
                })

              if (uploadErr) {
                console.error(`DocuSign webhook: failed to upload ${docType} to storage:`, uploadErr.message)
                continue
              }

              // 3. Create deal_documents record
              const dealDocType = docType === 'cpa' ? 'commission_agreement' : 'direction_to_pay'

              const { data: docRecord, error: insertErr } = await supabase
                .from('deal_documents')
                .insert({
                  deal_id: dealId,
                  uploaded_by: envelope.sent_by || '00000000-0000-0000-0000-000000000000',
                  document_type: dealDocType,
                  file_name: fileName,
                  file_path: storagePath,
                  file_size: pdfBytes.length,
                  upload_source: 'nexone_auto', // system-uploaded
                  notes: `Signed via DocuSign (envelope ${envelopeId})`,
                })
                .select('id')
                .single()

              if (insertErr || !docRecord) {
                console.error(`DocuSign webhook: failed to insert ${docType} document record:`, insertErr?.message)
                continue
              }

              console.log(`DocuSign webhook: stored signed ${docType} as document ${docRecord.id}`)

              // 4. Link document to the matching checklist item and auto-check it
              const checklistMatch = docType === 'cpa'
                ? '%Commission Purchase Agreement%'
                : '%Irrevocable Direction to Pay%'

              const { data: checklistItem } = await supabase
                .from('underwriting_checklist')
                .select('id')
                .eq('deal_id', dealId)
                .ilike('checklist_item', checklistMatch)
                .single()

              if (checklistItem) {
                const { error: checkErr } = await supabase
                  .from('underwriting_checklist')
                  .update({
                    is_checked: true,
                    checked_by: null,
                    checked_at: new Date().toISOString(),
                    linked_document_id: docRecord.id,
                    notes: `Auto-completed by system: Signed document received from DocuSign`,
                  })
                  .eq('id', checklistItem.id)

                if (checkErr) {
                  console.error(`DocuSign webhook: failed to update checklist item ${checklistItem.id}:`, checkErr.message)
                } else {
                  console.log(`DocuSign webhook: linked ${docType} to checklist item ${checklistItem.id} and marked complete`)
                }
              }

            } catch (docErr: any) {
              console.error(`DocuSign webhook: error processing ${docType} document:`, docErr?.message)
              // Continue with the next document — don't fail the whole webhook
            }
          }
        } else {
          // No auth token — can't download the signed docs, so do NOT check off the items.
          console.error(`DocuSign webhook: no valid auth token — cannot download signed docs for deal ${envelopes[0].deal_id}. Checklist items NOT checked. Admin must re-authorize DocuSign.`)
        }

        console.log(`DocuSign webhook: completed processing for deal ${envelopes[0].deal_id}`)
      }
    }

    return new Response('OK', { status: 200 })
  } catch (err: any) {
    console.error('DocuSign webhook error:', err?.message)
    // Always return 200 — DocuSign retries on non-200 and we don't want to loop
    return new Response('OK', { status: 200 })
  }
}
