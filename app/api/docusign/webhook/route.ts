import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServiceRoleClient } from '@/lib/supabase/server'
import { getValidAccessToken } from '@/lib/docusign'
import { logAuditEventServiceRole } from '@/lib/audit'
import { sendRemediationIdpSignedNotification } from '@/lib/email'

// DocuSign Connect webhook — receives envelope status updates
// Configure in DocuSign: Settings → Connect → Add Configuration
// URL: https://firmfunds.ca/api/docusign/webhook
// Data Format: REST v2.1 (JSON)
// Event Delivery Mode: Aggregate
// HMAC Security: REQUIRED in DocuSign Connect Configuration. The secret is
// stored as DOCUSIGN_HMAC_SECRET in Netlify env. The webhook fails closed
// (returns 401) if the env var is missing or the signature doesn't match.

/**
 * Redact an envelope ID for logging — show first/last 4 chars only.
 * Envelope IDs are the secret an attacker needs to spoof completion events;
 * the unredacted ID appearing in Netlify function logs is itself a leak.
 */
function redactEnvelopeId(id: string | null | undefined): string {
  if (!id) return '<none>'
  if (id.length <= 8) return '****'
  return `${id.slice(0, 4)}...${id.slice(-4)}`
}

/**
 * Verify the DocuSign Connect HMAC signature on a webhook payload. DocuSign
 * computes base64(HMAC-SHA256(secret, rawBody)) and sends it in the
 * X-DocuSign-Signature-1 header. Returns false if env is unset, header is
 * missing, or signature does not match. Constant-time comparison.
 *
 * Dev escape hatch: if DOCUSIGN_HMAC_DEV_BYPASS=1, verification is skipped.
 * Never set this in production.
 */
function verifyDocusignSignature(rawBody: string, headerSig: string | null): boolean {
  if (process.env.DOCUSIGN_HMAC_DEV_BYPASS === '1') {
    console.warn('DocuSign webhook: HMAC verification BYPASSED via DOCUSIGN_HMAC_DEV_BYPASS — never enable in production')
    return true
  }
  const secret = process.env.DOCUSIGN_HMAC_SECRET
  if (!secret) {
    console.error('DocuSign webhook: DOCUSIGN_HMAC_SECRET not configured — rejecting all webhooks (fail closed)')
    return false
  }
  if (!headerSig) {
    return false
  }
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(headerSig, 'utf8')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

export async function POST(request: Request) {
  try {
    const body = await request.text()

    // HMAC verification (Finding 1). Previously the webhook trusted any
    // POST that contained a recognizable envelope_id, letting an attacker
    // with a leaked envelope ID flip deals to "signed" and fast-track them
    // to funding.
    const headerSig =
      request.headers.get('x-docusign-signature-1') ||
      request.headers.get('X-DocuSign-Signature-1') ||
      null
    if (!verifyDocusignSignature(body, headerSig)) {
      console.error('DocuSign webhook: HMAC verification failed — rejecting')
      return new Response('Unauthorized', { status: 401 })
    }

    // DocuSign Connect payload shape (REST v2.1, aggregate mode). Using
    // `any` here because the payload nests dynamic shapes (status, recipients,
    // data, EnvelopeStatus, etc.) — we read fields defensively via optional
    // chaining below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    console.log(`DocuSign webhook: envelope ${redactEnvelopeId(envelopeId)} status: ${envelopeStatus}`)

    const supabase = createServiceRoleClient()

    // Idempotency (Finding 10): DocuSign Connect retries any non-2xx delivery
    // within ~100s and aggregate mode legitimately sends multiple events for
    // the same envelope (recipient-completed + envelope-completed). Compose a
    // canonical event_id from the Connect payload triple and INSERT into the
    // dedup table; if it already exists (23505 unique_violation), bail with
    // 200 so DocuSign stops retrying. Falls back to a random UUID only for
    // unrecognized payload shapes, in which case dedup is best-effort.
    const generatedDateTime: string | undefined =
      payload?.generatedDateTime || payload?.eventDateTime
    const eventId =
      eventName && generatedDateTime && envelopeId
        ? `${eventName}_${generatedDateTime}_${envelopeId}`
        : crypto.randomUUID()
    const eventType = eventName || envelopeStatus || 'unknown'

    const { error: dedupeErr } = await supabase
      .from('docusign_webhook_events')
      .insert({
        event_id: eventId,
        envelope_id: envelopeId,
        event_type: eventType,
        payload_summary: {
          event: eventName,
          status: envelopeStatus,
          generatedDateTime,
          recipientCount: (payload?.recipients?.signers || payload?.data?.envelopeSummary?.recipients?.signers || []).length,
        },
      })
    if (dedupeErr) {
      if (dedupeErr.code === '23505') {
        console.log(`DocuSign webhook: duplicate event ${eventId} for envelope ${redactEnvelopeId(envelopeId)} — already processed`)
        return new Response('Already processed', { status: 200 })
      }
      console.error('DocuSign webhook: dedup table write failed:', dedupeErr.message)
      return new Response('Dedup table write failed', { status: 500 })
    }

    // Find our envelope records (one per document in this envelope)
    const { data: envelopes, error: fetchErr } = await supabase
      .from('esignature_envelopes')
      .select('*')
      .eq('envelope_id', envelopeId)

    if (fetchErr || !envelopes || envelopes.length === 0) {
      console.error('DocuSign webhook: envelope not found in DB:', redactEnvelopeId(envelopeId))
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
    const updateData: Record<string, string | null> = {
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

    // Update all envelope records for this envelopeId.
    // Compare-and-swap on agent_signed_at when the new status is "signed" — if
    // a prior delivery already marked it signed, leave the existing timestamp
    // alone so re-arrivals (e.g. recipient-completed followed by
    // envelope-completed) are no-ops on the timestamp field.
    let envelopeUpdateQuery = supabase
      .from('esignature_envelopes')
      .update(updateData)
      .eq('envelope_id', envelopeId)

    if (mappedStatus === 'signed') {
      envelopeUpdateQuery = envelopeUpdateQuery.is('agent_signed_at', null)
    }

    const { error: updateErr } = await envelopeUpdateQuery

    if (updateErr) {
      console.error('DocuSign webhook: failed to update envelope:', updateErr.message)
    }

    // Tracks whether a recoverable (transient) failure happened while doing
    // the critical signed-document download/store work below. The status
    // flips above are idempotent (CAS-guarded) and authoritative on their own,
    // but losing the signed PDF is not acceptable. If this flips true we
    // release our dedup claim (DELETE the event row) and return a non-2xx so
    // DocuSign re-delivers and we get another shot at the download. A missing
    // auth token, a failed DocuSign document fetch, or a failed storage upload
    // are all transient. Genuinely bad/duplicate events never set this and
    // still return 200.
    let transientFailure = false

    // ================================================================
    // SIGNED — Download docs, store them, link to checklist, check off
    // ================================================================
    if (mappedStatus === 'signed') {
      // Three envelope kinds — BCA (brokerage-level), Remediation IDP
      // (curing a failed deal), or a regular deal envelope (CPA + IDP).
      // Each lives on a different parent row so the dispatch is on
      // document_type, not deal_id presence.
      const firstDocType = envelopes[0].document_type as string
      const isBca = firstDocType === 'bca'
      const isRemediationIdp = firstDocType === 'remediation_idp'

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
                transientFailure = true
              } else {
                console.log(`DocuSign webhook: stored signed BCA at ${storagePath}`)
              }
            } else {
              console.error(`DocuSign webhook: failed to download BCA doc: ${docRes.status}`)
              transientFailure = true
            }
          } catch (docErr: unknown) {
            const message = docErr instanceof Error ? docErr.message : 'unknown'
            console.error('DocuSign webhook: error processing BCA document:', message)
            transientFailure = true
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
          // No token is a recoverable condition (token refresh / re-auth).
          // Force a redelivery so we capture the signed BCA on retry.
          transientFailure = true
        }

        console.log(`DocuSign webhook: completed BCA processing for brokerage ${brokerageId}`)

      } else if (isRemediationIdp) {
        // ============================================================
        // REMEDIATION IDP ENVELOPE — failed-deal cure assignment
        // ============================================================
        // The envelope ties back to a remediation_deals row, NOT a deal
        // and NOT a brokerage. Flow: download the single signed PDF,
        // store it under remediation_idp/{remediationDealId}/, flip the
        // remediation row to idp_signed with signed_at, audit-log, and
        // notify the Firm Funds admin so the brokerage remittance step
        // is on the radar.
        const remediationDealId = envelopes[0].remediation_deal_id as string | null

        if (!remediationDealId) {
          console.error(`DocuSign webhook: remediation_idp envelope has no remediation_deal_id — envelope ${redactEnvelopeId(envelopeId)}`)
        } else {
          console.log(`DocuSign webhook: Remediation IDP signed — downloading doc for remediation_deal ${remediationDealId}`)

          const auth = await getValidAccessToken()
          let storagePath: string | null = null
          let pdfStored = false

          if (auth) {
            try {
              // 1. Download signed Remediation IDP PDF (documentId '1' — only one doc)
              const docRes = await fetch(
                `${auth.baseUri}/restapi/v2.1/accounts/${auth.accountId}/envelopes/${envelopeId}/documents/1`,
                { headers: { 'Authorization': `Bearer ${auth.accessToken}` } }
              )

              if (docRes.ok) {
                const pdfBuffer = await docRes.arrayBuffer()
                const pdfBytes = new Uint8Array(pdfBuffer)

                // 2. Upload to Supabase storage under a remediation-specific
                // prefix so admin tooling can find it without joining through
                // failed_deal_id.
                const timestamp = Date.now()
                const randomId = crypto.randomUUID()
                storagePath = `remediation_idp/${remediationDealId}/${timestamp}_${randomId}.pdf`

                const { error: uploadErr } = await supabase.storage
                  .from('deal-documents')
                  .upload(storagePath, pdfBytes, {
                    contentType: 'application/pdf',
                    upsert: false,
                  })

                if (uploadErr) {
                  console.error('DocuSign webhook: failed to upload Remediation IDP to storage:', uploadErr.message)
                  storagePath = null
                  transientFailure = true
                } else {
                  console.log(`DocuSign webhook: stored signed Remediation IDP at ${storagePath}`)
                  pdfStored = true
                }
              } else {
                console.error(`DocuSign webhook: failed to download Remediation IDP doc: ${docRes.status}`)
                transientFailure = true
              }
            } catch (docErr: unknown) {
              const message = docErr instanceof Error ? docErr.message : 'unknown'
              console.error('DocuSign webhook: error processing Remediation IDP document:', message)
              transientFailure = true
            }
          } else {
            console.error(`DocuSign webhook: no valid auth token — cannot download signed Remediation IDP for remediation_deal ${remediationDealId}. Admin must re-authorize DocuSign and re-trigger.`)
            // Recoverable: force a redelivery so the signed PDF is captured
            // once the token is restored. The status flip below is CAS-guarded
            // and idempotent on re-arrival.
            transientFailure = true
          }

          // 3. Flip the remediation_deals row to idp_signed regardless of
          // whether the PDF download succeeded — the signature event itself
          // is authoritative. CAS-guarded on status='idp_sent' so a re-arrival
          // (recipient-completed followed by envelope-completed) won't bump
          // signed_at twice or accidentally flip remitted/cancelled rows back.
          const signedAtIso = new Date().toISOString()
          const { data: claimed, error: remUpdateErr } = await supabase
            .from('remediation_deals')
            .update({ status: 'idp_signed', signed_at: signedAtIso })
            .eq('id', remediationDealId)
            .eq('status', 'idp_sent')
            .select('id, failed_deal_id, agent_id, brokerage_legal_name, property_address, directed_amount')
            .maybeSingle()

          if (remUpdateErr) {
            console.error('DocuSign webhook: failed to flip remediation_deals to idp_signed:', remUpdateErr.message)
          } else if (!claimed) {
            console.log(`DocuSign webhook: remediation_deal ${remediationDealId} was not in idp_sent status — leaving row unchanged (likely a duplicate webhook delivery)`)
          } else {
            console.log(`DocuSign webhook: remediation_deal ${remediationDealId} flipped to idp_signed`)

            // 4. Audit-log the signing event so the deal timeline reflects it.
            await logAuditEventServiceRole({
              action: 'remediation_deal.signed',
              entityType: 'deal',
              entityId: claimed.failed_deal_id as string,
              metadata: {
                remediation_deal_id: remediationDealId,
                envelope_id: envelopeId,
                signed_at: signedAtIso,
                storage_path: storagePath,
                pdf_stored: pdfStored,
                source_property_address: claimed.property_address,
                directed_amount: Number(claimed.directed_amount),
              },
            })

            // 5. Fetch the context we need for the admin email (agent name +
            // failed-deal property address). Service-role select bypasses RLS.
            try {
              const { data: agent } = await supabase
                .from('agents')
                .select('first_name, last_name, email')
                .eq('id', claimed.agent_id as string)
                .maybeSingle()
              const { data: failedDeal } = await supabase
                .from('deals')
                .select('property_address')
                .eq('id', claimed.failed_deal_id as string)
                .maybeSingle()

              const agentName = agent
                ? `${agent.first_name ?? ''} ${agent.last_name ?? ''}`.trim() || 'Agent'
                : 'Agent'

              await sendRemediationIdpSignedNotification({
                remediationDealId,
                envelopeId,
                agentName,
                agentEmail: agent?.email || 'unknown',
                brokerageName: claimed.brokerage_legal_name as string,
                failedDealPropertyAddress: failedDeal?.property_address || 'unknown',
                sourcePropertyAddress: claimed.property_address as string,
                directedAmount: Number(claimed.directed_amount),
                signedAt: signedAtIso,
              })
            } catch (emailErr: unknown) {
              const message = emailErr instanceof Error ? emailErr.message : 'unknown'
              console.error('DocuSign webhook: failed to send Remediation IDP signed notification:', message)
              // Email failure does not roll back the status flip.
            }
          }

          console.log(`DocuSign webhook: completed Remediation IDP processing for remediation_deal ${remediationDealId}`)
        }

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
                transientFailure = true
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
                transientFailure = true
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
                transientFailure = true
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

            } catch (docErr: unknown) {
              const message = docErr instanceof Error ? docErr.message : 'unknown'
              console.error(`DocuSign webhook: error processing ${docType} document:`, message)
              // Continue with the next document — don't fail the whole webhook,
              // but flag for redelivery so the missed document is retried.
              transientFailure = true
            }
          }
        } else {
          // No auth token — can't download the signed docs, so do NOT check off the items.
          console.error(`DocuSign webhook: no valid auth token — cannot download signed docs for deal ${envelopes[0].deal_id}. Checklist items NOT checked. Admin must re-authorize DocuSign.`)
          // Recoverable: release the dedup claim and ask DocuSign to redeliver
          // so we capture the signed docs once the token is restored.
          transientFailure = true
        }

        console.log(`DocuSign webhook: completed processing for deal ${envelopes[0].deal_id}`)
      }
    }

    // If the critical document-download/store work hit a recoverable failure,
    // release our dedup claim and ask DocuSign to redeliver. We DELETE the
    // dedup row (rather than leaving a "claimed" marker) so the next delivery
    // re-runs the full download path; the status flips already applied are
    // idempotent (CAS-guarded) and safe to re-apply. Returning a non-2xx makes
    // DocuSign Connect retry with backoff. A true duplicate never reaches here
    // (it 200s at the 23505 branch), and malformed/permanently-bad events
    // return 200 above, so this only triggers a retry for genuine transients.
    if (transientFailure) {
      const { error: delErr } = await supabase
        .from('docusign_webhook_events')
        .delete()
        .eq('event_id', eventId)
      if (delErr) {
        // Couldn't release the claim. Still return non-2xx so DocuSign retries;
        // the stale dedup row would otherwise suppress the retry, but on
        // redelivery the INSERT will collide (23505) and 200 — so log loudly.
        console.error(
          `DocuSign webhook: failed to release dedup claim for event ${eventId} after transient error:`,
          delErr.message
        )
      }
      console.error(
        `DocuSign webhook: transient processing failure for envelope ${redactEnvelopeId(envelopeId)} — released dedup claim, returning 503 for DocuSign retry`
      )
      return new Response('Transient processing failure - please retry', { status: 503 })
    }

    // Mark dedup row as successfully processed for observability/audit.
    await supabase
      .from('docusign_webhook_events')
      .update({ processed_at: new Date().toISOString(), processing_result: 'success' })
      .eq('event_id', eventId)

    return new Response('OK', { status: 200 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('DocuSign webhook error:', message)
    // Always return 200 — DocuSign retries on non-200 and we don't want to loop
    return new Response('OK', { status: 200 })
  }
}
