import { createServiceRoleClient } from '@/lib/supabase/server'
import { verifySignWellWebhook, getSignWellCompletedPdf, getSignWellDocumentStatus } from '@/lib/signwell'
import { logAuditEventServiceRole } from '@/lib/audit'
import { sendRemediationIdpSignedNotification, sendBrokerageExecutedIdpNotification } from '@/lib/email'

// SignWell webhook — receives document status updates.
// Configure in SignWell: Settings → API → Webhooks (or via the API hook field).
// URL: https://firmfunds.ca/api/signwell/webhook
// Payload shape (verified from docs):
//   { "event": { "type": "document_completed", "time": 1718049600, "hash": "<hmac hex>" },
//     "data": { "object": { "id": "<document id>", "status": "Completed", ... }, "account_id": "..." } }
// HMAC Security: SignWell signs hex(HMAC-SHA256(apiKey, `${type}@${time}`)) and
// sends it as event.hash. Verification is delegated to verifySignWellWebhook()
// in lib/signwell.ts, which fails closed (it internally honors
// SIGNWELL_HMAC_DEV_BYPASS for local dev). The webhook returns 401 if the
// signature doesn't match.
//
// This mirrors app/api/docusign/webhook/route.ts as closely as possible so the
// SignWell path produces identical DB state. Key differences from DocuSign:
//   - We store the SignWell DOCUMENT id in esignature_envelopes.envelope_id.
//   - SignWell returns ONE MERGED completed PDF per document (not per file), so
//     a CPA+IDP document yields a single PDF we store for BOTH rows.
//   - SignWell sends no stable per-delivery event id, so the dedup key is the
//     `${event.type}@${event.time}@${document id}` triple (see migration 109).

/**
 * Redact a SignWell document ID for logging — show first/last 4 chars only.
 * Like DocuSign envelope IDs, the document ID is the secret an attacker needs
 * to spoof completion events, so the unredacted ID should not hit the logs.
 */
function redactDocumentId(id: string | null | undefined): string {
  if (!id) return '<none>'
  if (id.length <= 8) return '****'
  return `${id.slice(0, 4)}...${id.slice(-4)}`
}

// SEC-D2: reject events whose authenticated timestamp is implausibly old. The
// window is deliberately generous (1h, not minutes) so legitimate SignWell
// retries are never dropped; SignWell delivers near-instantly and the SEC-D1
// live re-fetch below is the real anti-replay gate.
const WEBHOOK_MAX_AGE_MS = 60 * 60 * 1000

export async function POST(request: Request) {
  try {
    // Read the raw body, then parse. SignWell hashes `${type}@${time}` (NOT the
    // raw body), so we need the parsed event object to verify the signature.
    const body = await request.text()

    // SignWell webhook payload. Using `any` because the nested data.object shape
    // is dynamic across event types; fields are read defensively below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let payload: any
    try {
      payload = JSON.parse(body)
    } catch {
      console.error('SignWell webhook: received non-JSON payload')
      return new Response('OK', { status: 200 })
    }

    const eventType: string | undefined = payload?.event?.type
    const eventTime: string | number | undefined = payload?.event?.time
    const providedHash: string | undefined = payload?.event?.hash

    // HMAC verification (fail closed). An attacker with a leaked document id
    // could otherwise flip deals to "signed" and fast-track them to funding.
    if (
      eventType === undefined ||
      eventTime === undefined ||
      typeof providedHash !== 'string' ||
      !verifySignWellWebhook(eventType, eventTime, providedHash)
    ) {
      console.error('SignWell webhook: HMAC verification failed — rejecting')
      return new Response('Unauthorized', { status: 401 })
    }

    // SEC-D2: freshness. eventTime is the HMAC-authenticated Unix epoch (seconds)
    // at which the event occurred. Drop events older than the generous window
    // above (acknowledge with 200 so SignWell stops retrying a genuinely stale
    // event).
    const eventEpochMs = Number(eventTime) * 1000
    if (Number.isFinite(eventEpochMs) && Date.now() - eventEpochMs > WEBHOOK_MAX_AGE_MS) {
      console.error(
        `SignWell webhook: event ${eventType} timestamp is stale (older than ${WEBHOOK_MAX_AGE_MS}ms) — ignoring`
      )
      return new Response('OK', { status: 200 })
    }

    const documentId: string | undefined = payload?.data?.object?.id
    const documentStatus: string | undefined = payload?.data?.object?.status

    if (!documentId) {
      console.error('SignWell webhook: no document id in payload')
      return new Response('OK', { status: 200 })
    }

    // Map SignWell event types to our esignature_envelopes.status values.
    // document_completed (all signers done) is the analogue of DocuSign's
    // 'completed' → 'signed'. Per-signer document_signed, document_sent, and
    // document_viewed are NOT terminal and are ignored with a 200.
    const eventToStatus: Record<string, string> = {
      document_completed: 'signed',
      document_declined: 'declined',
      document_canceled: 'voided',
    }
    const mappedStatus = eventToStatus[eventType]

    console.log(
      `SignWell webhook: document ${redactDocumentId(documentId)} event ${eventType} (status ${documentStatus ?? 'n/a'})`
    )

    if (!mappedStatus) {
      // Non-terminal event (document_sent, document_viewed, document_signed,
      // etc.). Acknowledge so SignWell stops retrying, but do nothing.
      console.log(`SignWell webhook: ignoring non-terminal event ${eventType}`)
      return new Response('OK', { status: 200 })
    }

    // SEC-D1: the HMAC signs only `${type}@${time}` — the document id and status
    // ride in the UNSIGNED body. Before mutating anything, re-fetch the document
    // from SignWell and confirm its live status matches the claimed event, so a
    // captured hash cannot flip an unrelated (e.g. still-pending) document to
    // "signed" and fast-track it to funding. The financial completed path
    // requires a live "Completed"; on a transient fetch error we force a
    // redelivery (503, before the dedup claim) rather than act on unverified
    // data. Decline/cancel are non-financial, so a fetch failure there falls
    // through, but a live "Completed" still blocks an inconsistent void attempt.
    if (eventType === 'document_completed') {
      let liveStatus: string | null = null
      try {
        liveStatus = await getSignWellDocumentStatus(documentId)
      } catch (statusErr: unknown) {
        const message = statusErr instanceof Error ? statusErr.message : 'unknown'
        console.error(
          `SignWell webhook: live status re-fetch failed for document ${redactDocumentId(documentId)}: ${message} — forcing redelivery`
        )
        return new Response('Status verification unavailable', { status: 503 })
      }
      if ((liveStatus ?? '').toLowerCase() !== 'completed') {
        console.error(
          `SignWell webhook: live status "${liveStatus ?? 'unknown'}" does not match completed event for document ${redactDocumentId(documentId)} — rejecting as spoofed/stale`
        )
        return new Response('OK', { status: 200 })
      }
    } else {
      try {
        const liveStatus = await getSignWellDocumentStatus(documentId)
        if (liveStatus && liveStatus.toLowerCase() === 'completed') {
          console.error(
            `SignWell webhook: ${eventType} event but live status is "Completed" for document ${redactDocumentId(documentId)} — ignoring as inconsistent`
          )
          return new Response('OK', { status: 200 })
        }
      } catch {
        // Non-financial path: a transient fetch failure should not block a
        // legitimate decline/cancel. Fall through and process normally.
      }
    }

    const supabase = createServiceRoleClient()

    // Idempotency (mirrors migration 067/109). SignWell has no stable
    // per-delivery event id, so synthesize one from the (type, time, document)
    // triple — the same triple SignWell signs. INSERT at the start of
    // processing; a unique violation (23505) means we've already handled this
    // event and we return 200 so SignWell stops retrying.
    const eventId = `${eventType}@${eventTime}@${documentId}`

    const { error: dedupeErr } = await supabase
      .from('signwell_webhook_events')
      .insert({
        event_id: eventId,
        document_id: documentId,
        event_type: eventType,
        payload_summary: {
          event: eventType,
          status: documentStatus,
          time: eventTime,
          account_id: payload?.data?.account_id ?? null,
        },
      })
    if (dedupeErr) {
      if (dedupeErr.code === '23505') {
        console.log(
          `SignWell webhook: duplicate event ${eventId} for document ${redactDocumentId(documentId)} — already processed`
        )
        return new Response('Already processed', { status: 200 })
      }
      console.error('SignWell webhook: dedup table write failed:', dedupeErr.message)
      return new Response('Dedup table write failed', { status: 500 })
    }

    // Find our envelope records. For a CPA+IDP send there are TWO rows (cpa,
    // idp) sharing the same SignWell document id stored in envelope_id; BCA and
    // remediation_idp have a single row each.
    const { data: envelopes, error: fetchErr } = await supabase
      .from('esignature_envelopes')
      .select('*')
      .eq('envelope_id', documentId)

    if (fetchErr || !envelopes || envelopes.length === 0) {
      console.error('SignWell webhook: document not found in DB:', redactDocumentId(documentId))
      return new Response('OK', { status: 200 })
    }

    // Build the envelope update. Mirrors the DocuSign route field-for-field.
    const updateData: Record<string, string | null> = {
      status: mappedStatus,
    }

    if (mappedStatus === 'signed') {
      updateData.completed_at = new Date().toISOString()
      updateData.agent_signer_status = 'signed'
      updateData.agent_signed_at = new Date().toISOString()
    } else if (mappedStatus === 'declined') {
      updateData.agent_signer_status = 'declined'
    } else if (mappedStatus === 'voided') {
      updateData.voided_at = new Date().toISOString()
    }

    // Update all envelope rows for this document id. Compare-and-swap on
    // agent_signed_at when the new status is "signed" so a re-delivery never
    // re-stamps the timestamp.
    let envelopeUpdateQuery = supabase
      .from('esignature_envelopes')
      .update(updateData)
      .eq('envelope_id', documentId)

    if (mappedStatus === 'signed') {
      envelopeUpdateQuery = envelopeUpdateQuery.is('agent_signed_at', null)
    }

    const { error: updateErr } = await envelopeUpdateQuery

    if (updateErr) {
      console.error('SignWell webhook: failed to update envelope:', updateErr.message)
    }

    // Tracks whether a recoverable (transient) failure happened while doing the
    // critical signed-document download/store work below. The status flips above
    // are idempotent (CAS-guarded) and authoritative on their own, but losing
    // the signed PDF is not acceptable. If this flips true we release our dedup
    // claim (DELETE the event row) and return a non-2xx so SignWell re-delivers
    // and we get another shot at the download.
    let transientFailure = false

    // ================================================================
    // SIGNED — Download the merged signed PDF, store it, link to checklist
    // ================================================================
    if (mappedStatus === 'signed') {
      // Three envelope kinds — BCA (brokerage-level), Remediation IDP (curing a
      // failed deal), or a regular deal envelope (CPA + IDP). Dispatch on
      // document_type, not deal_id presence — same as the DocuSign route.
      const firstDocType = envelopes[0].document_type as string
      const isBca = firstDocType === 'bca'
      const isRemediationIdp = firstDocType === 'remediation_idp'

      // SignWell returns ONE merged completed PDF per document (not per file),
      // unlike DocuSign which exposes each document by numeric documentId. We
      // fetch it once and reuse the buffer for every row on this document. For
      // the CPA+IDP case that means BOTH deal_documents rows are linked to the
      // same merged PDF.
      //
      // TODO(signwell): revisit if/when we need true per-file PDFs — SignWell's
      // completed_pdf endpoint supports `?file_format=zip` to retrieve the
      // individual source files. For now the merged PDF is the signed record of
      // record for all documents in the envelope.
      let mergedPdf: Buffer | null = null
      try {
        mergedPdf = await getSignWellCompletedPdf(documentId)
      } catch (pdfErr: unknown) {
        const message = pdfErr instanceof Error ? pdfErr.message : 'unknown'
        console.error(
          `SignWell webhook: failed to download completed PDF for document ${redactDocumentId(documentId)}:`,
          message
        )
        // Recoverable: force a redelivery so we capture the signed PDF on retry.
        transientFailure = true
      }

      if (isBca) {
        // ============================================================
        // BCA ENVELOPE — Brokerage Cooperation Agreement
        // ============================================================
        const brokerageId = envelopes[0].brokerage_id
        console.log(`SignWell webhook: BCA signed — storing doc for brokerage ${brokerageId}`)

        // Capture where we store the signed PDF so it's persisted on the
        // brokerage row, not just left orphaned in storage.
        let signedBcaPath: string | null = null

        if (mergedPdf && brokerageId) {
          try {
            const pdfBytes = new Uint8Array(mergedPdf)

            // Upload to Supabase storage (brokerage-level path).
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
              console.error('SignWell webhook: failed to upload BCA to storage:', uploadErr.message)
              transientFailure = true
            } else {
              signedBcaPath = storagePath
              console.log(`SignWell webhook: stored signed BCA at ${storagePath}`)
            }
          } catch (docErr: unknown) {
            const message = docErr instanceof Error ? docErr.message : 'unknown'
            console.error('SignWell webhook: error processing BCA document:', message)
            transientFailure = true
          }
        } else if (!mergedPdf) {
          // PDF download already flagged transientFailure above — no token/PDF
          // means we can't store the signed BCA, so force a redelivery.
          transientFailure = true
        }

        if (brokerageId) {
          // Update bca_signed_at — and the stored PDF path so the signed BCA is
          // downloadable/viewable from the brokerage record.
          const bcaUpdate: { bca_signed_at: string; bca_signed_pdf_path?: string } = {
            bca_signed_at: new Date().toISOString(),
          }
          if (signedBcaPath) bcaUpdate.bca_signed_pdf_path = signedBcaPath

          const { error: bcaUpdateErr } = await supabase
            .from('brokerages')
            .update(bcaUpdate)
            .eq('id', brokerageId)

          if (bcaUpdateErr) {
            console.error('SignWell webhook: failed to update bca_signed_at:', bcaUpdateErr.message)
          } else {
            console.log(`SignWell webhook: brokerage ${brokerageId} bca_signed_at + path updated`)
          }
        }

        console.log(`SignWell webhook: completed BCA processing for brokerage ${brokerageId}`)

      } else if (isRemediationIdp) {
        // ============================================================
        // REMEDIATION IDP ENVELOPE — failed-deal cure assignment
        // ============================================================
        const remediationDealId = envelopes[0].remediation_deal_id as string | null

        if (!remediationDealId) {
          console.error(
            `SignWell webhook: remediation_idp envelope has no remediation_deal_id — document ${redactDocumentId(documentId)}`
          )
        } else {
          console.log(
            `SignWell webhook: Remediation IDP signed — storing doc for remediation_deal ${remediationDealId}`
          )

          let storagePath: string | null = null
          let pdfStored = false

          if (mergedPdf) {
            try {
              const pdfBytes = new Uint8Array(mergedPdf)

              // Upload under a remediation-specific prefix so admin tooling can
              // find it without joining through failed_deal_id.
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
                console.error(
                  'SignWell webhook: failed to upload Remediation IDP to storage:',
                  uploadErr.message
                )
                storagePath = null
                transientFailure = true
              } else {
                console.log(`SignWell webhook: stored signed Remediation IDP at ${storagePath}`)
                pdfStored = true
              }
            } catch (docErr: unknown) {
              const message = docErr instanceof Error ? docErr.message : 'unknown'
              console.error('SignWell webhook: error processing Remediation IDP document:', message)
              transientFailure = true
            }
          } else {
            // PDF download already flagged transientFailure above. Force a
            // redelivery so the signed PDF is captured on retry. The status flip
            // below is CAS-guarded and idempotent on re-arrival.
            transientFailure = true
          }

          // Flip the remediation_deals row to idp_signed regardless of whether
          // the PDF download succeeded — the signature event itself is
          // authoritative. CAS-guarded on status='idp_sent' so a re-delivery
          // won't bump signed_at twice or flip remitted/cancelled rows back.
          const signedAtIso = new Date().toISOString()
          const { data: claimed, error: remUpdateErr } = await supabase
            .from('remediation_deals')
            .update({ status: 'idp_signed', signed_at: signedAtIso })
            .eq('id', remediationDealId)
            .eq('status', 'idp_sent')
            .select('id, failed_deal_id, agent_id, brokerage_id, brokerage_legal_name, broker_of_record_email, property_address, directed_amount')
            .maybeSingle()

          if (remUpdateErr) {
            console.error('SignWell webhook: failed to flip remediation_deals to idp_signed:', remUpdateErr.message)
          } else if (!claimed) {
            console.log(
              `SignWell webhook: remediation_deal ${remediationDealId} was not in idp_sent status — leaving row unchanged (likely a duplicate webhook delivery)`
            )
          } else {
            console.log(`SignWell webhook: remediation_deal ${remediationDealId} flipped to idp_signed`)

            // Audit-log the signing event so the deal timeline reflects it.
            await logAuditEventServiceRole({
              action: 'remediation_deal.signed',
              entityType: 'deal',
              entityId: claimed.failed_deal_id as string,
              metadata: {
                remediation_deal_id: remediationDealId,
                envelope_id: documentId,
                signed_at: signedAtIso,
                storage_path: storagePath,
                pdf_stored: pdfStored,
                source_property_address: claimed.property_address,
                directed_amount: Number(claimed.directed_amount),
              },
            })

            // Fetch context for the admin email (agent name + failed-deal
            // property address). Service-role select bypasses RLS.
            try {
              const { data: agent } = await supabase
                .from('agents')
                .select('first_name, last_name, email')
                .eq('id', claimed.agent_id as string)
                .maybeSingle()
              const { data: failedDeal } = await supabase
                .from('deals')
                .select('deal_number, property_address')
                .eq('id', claimed.failed_deal_id as string)
                .maybeSingle()

              const agentName = agent
                ? `${agent.first_name ?? ''} ${agent.last_name ?? ''}`.trim() || 'Agent'
                : 'Agent'

              await sendRemediationIdpSignedNotification({
                remediationDealId,
                envelopeId: documentId,
                agentName,
                agentEmail: agent?.email || 'unknown',
                brokerageName: claimed.brokerage_legal_name as string,
                dealNumber: failedDeal?.deal_number,
                failedDealPropertyAddress: failedDeal?.property_address || 'unknown',
                sourcePropertyAddress: claimed.property_address as string,
                directedAmount: Number(claimed.directed_amount),
                signedAt: signedAtIso,
              })
            } catch (emailErr: unknown) {
              const message = emailErr instanceof Error ? emailErr.message : 'unknown'
              console.error('SignWell webhook: failed to send Remediation IDP signed notification:', message)
              // Email failure does not roll back the status flip.
            }

            // Email the brokerage its executed copy of the Remediation IDP.
            // Like the regular deal IDP, this is a direction to pay the
            // brokerage, so the brokerage should receive the executed copy.
            // Best-effort and exactly once (this branch runs only on the
            // CAS-claimed transition to idp_signed). We reuse the SAME merged
            // buffer — no re-download — and only attach when the PDF actually
            // downloaded (mergedPdf present). Unlike a regular deal, the
            // remediation row carries the broker-of-record email directly
            // (rem.broker_of_record_email), so that is our sole recipient.
            try {
              const borEmail =
                typeof claimed.broker_of_record_email === 'string'
                  ? claimed.broker_of_record_email.trim()
                  : ''

              if (!mergedPdf) {
                console.warn(
                  `SignWell webhook: remediation_deal ${remediationDealId} signed PDF unavailable — skipping brokerage executed-IDP email (admin already notified).`
                )
              } else if (!borEmail) {
                console.warn(
                  `SignWell webhook: remediation_deal ${remediationDealId} has no broker_of_record_email on file — cannot email executed Remediation IDP. Skipping.`
                )
              } else {
                const { data: remAgent } = await supabase
                  .from('agents')
                  .select('first_name, last_name')
                  .eq('id', claimed.agent_id as string)
                  .maybeSingle()
                const remAgentName = remAgent
                  ? `${remAgent.first_name ?? ''} ${remAgent.last_name ?? ''}`.trim() || 'Agent'
                  : 'Agent'

                await sendBrokerageExecutedIdpNotification({
                  to: [borEmail],
                  brokerageName: (claimed.brokerage_legal_name as string) || 'your brokerage',
                  agentName: remAgentName,
                  propertyAddress: (claimed.property_address as string) || 'the property',
                  dealNumber: null,
                  brokerageId: (claimed.brokerage_id as string | null) ?? null,
                  pdf: mergedPdf,
                  pdfFileName: 'Remediation_Direction_to_Pay_Signed.pdf',
                })
                console.log(
                  `SignWell webhook: emailed executed Remediation IDP for remediation_deal ${remediationDealId} to broker of record`
                )
              }
            } catch (emailErr: unknown) {
              const message = emailErr instanceof Error ? emailErr.message : 'unknown'
              console.error(
                `SignWell webhook: failed to email executed Remediation IDP to brokerage for remediation_deal ${remediationDealId}:`,
                message
              )
              // Best-effort: never roll back the status flip or fail the webhook.
            }
          }

          console.log(`SignWell webhook: completed Remediation IDP processing for remediation_deal ${remediationDealId}`)
        }

      } else {
        // ============================================================
        // DEAL ENVELOPE — CPA + IDP
        // ============================================================
        const dealId = envelopes[0].deal_id
        console.log(`SignWell webhook: document signed — storing docs for deal ${dealId}`)

        if (mergedPdf) {
          // SignWell returns a single merged PDF for the whole document, so we
          // store the SAME bytes for each row (cpa, idp). Both deal_documents
          // records point at their own storage object (separate paths) holding
          // identical merged content — see the merged-PDF note above.
          for (const envelope of envelopes) {
            const docType = envelope.document_type // 'cpa' or 'idp'

            try {
              const pdfBytes = new Uint8Array(mergedPdf)

              // Upload to Supabase storage (deal-level path).
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
                console.error(`SignWell webhook: failed to upload ${docType} to storage:`, uploadErr.message)
                transientFailure = true
                continue
              }

              // Create deal_documents record.
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
                  notes: `Signed via SignWell (document ${documentId})`,
                })
                .select('id')
                .single()

              if (insertErr || !docRecord) {
                console.error(`SignWell webhook: failed to insert ${docType} document record:`, insertErr?.message)
                transientFailure = true
                continue
              }

              console.log(`SignWell webhook: stored signed ${docType} as document ${docRecord.id}`)

              // Link document to the matching checklist item and auto-check it.
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
                    notes: `Auto-completed by system: Signed document received from SignWell`,
                  })
                  .eq('id', checklistItem.id)

                if (checkErr) {
                  console.error(`SignWell webhook: failed to update checklist item ${checklistItem.id}:`, checkErr.message)
                } else {
                  console.log(`SignWell webhook: linked ${docType} to checklist item ${checklistItem.id} and marked complete`)
                }
              }

            } catch (docErr: unknown) {
              const message = docErr instanceof Error ? docErr.message : 'unknown'
              console.error(`SignWell webhook: error processing ${docType} document:`, message)
              // Continue with the next document, but flag for redelivery so the
              // missed document is retried.
              transientFailure = true
            }
          }

          // ----------------------------------------------------------------
          // Email the brokerage its executed copy of the Direction to Pay.
          // The IDP is the brokerage's written authorization to remit the
          // agent's commission to Firm Funds, so the brokerage MUST receive
          // the executed copy. The DocuSign flow did this by CC'ing the
          // brokerage on the envelope; SignWell dropped CC, so we deliver it
          // ourselves via Resend (more reliable + branded + logged).
          //
          // BEST-EFFORT and EXACTLY ONCE per deal completion (outside the
          // per-row loop above): the signed PDF is already stored, so a Resend
          // hiccup must NOT throw or trigger a 503 redelivery (that would
          // duplicate stored objects). We reuse the SAME merged buffer — no
          // re-download. The attachment is the merged completed PDF, which
          // currently also contains the signed CPA (matching the prior
          // DocuSign CC, which copied the whole envelope). If a brokerage
          // should receive the IDP page only, narrow this later via
          // SignWell's `completed_pdf?file_format=zip`.
          try {
            const { data: deal } = await supabase
              .from('deals')
              .select('property_address, deal_number, agent:agents(first_name, last_name, brokerage:brokerages(id, name, email, broker_of_record_email))')
              .eq('id', dealId)
              .maybeSingle()

            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested join shape is dynamic
            const agent = (deal as any)?.agent
            const brokerage = agent?.brokerage

            // Only send the "Executed Direction to Pay" notice when an actual
            // IDP was signed. A regular deal send writes two envelope rows
            // (cpa + idp) under one SignWell document; a CPA Amendment send
            // writes a single cpa row. An amendment is not a Direction to Pay,
            // so a cpa-only document must NOT trigger this brokerage email
            // (it would arrive mislabeled as an executed IDP).
            const hasIdp = envelopes.some((e) => e.document_type === 'idp')

            // Dedupe recipients, drop nulls/blanks, case-insensitive compare.
            const recipients: string[] = []
            const seenEmails = new Set<string>()
            for (const addr of [brokerage?.broker_of_record_email, brokerage?.email]) {
              const trimmed = typeof addr === 'string' ? addr.trim() : ''
              if (!trimmed) continue
              const key = trimmed.toLowerCase()
              if (seenEmails.has(key)) continue
              seenEmails.add(key)
              recipients.push(trimmed)
            }

            if (!hasIdp) {
              console.log(
                `SignWell webhook: deal ${dealId} document has no IDP envelope (likely a CPA amendment) — skipping brokerage Executed Direction to Pay email.`
              )
            } else if (recipients.length === 0) {
              console.warn(
                `SignWell webhook: deal ${dealId} brokerage has no broker_of_record_email or email on file — cannot email executed Direction to Pay. Skipping (signed PDF already stored).`
              )
            } else {
              const agentName = agent
                ? `${agent.first_name ?? ''} ${agent.last_name ?? ''}`.trim() || 'Agent'
                : 'Agent'

              await sendBrokerageExecutedIdpNotification({
                to: recipients,
                brokerageName: brokerage?.name || 'your brokerage',
                agentName,
                propertyAddress: (deal as { property_address?: string })?.property_address || 'the property',
                dealNumber: (deal as { deal_number?: string | null })?.deal_number ?? null,
                brokerageId: brokerage?.id ?? null,
                pdf: mergedPdf,
                pdfFileName: 'Irrevocable_Direction_to_Pay_Signed.pdf',
              })
              console.log(
                `SignWell webhook: emailed executed Direction to Pay for deal ${dealId} to ${recipients.length} brokerage recipient(s)`
              )
            }
          } catch (emailErr: unknown) {
            const message = emailErr instanceof Error ? emailErr.message : 'unknown'
            // Best-effort: never fail the webhook over an email problem. The
            // signed PDF is already stored; do NOT flip transientFailure.
            console.error(
              `SignWell webhook: failed to email executed Direction to Pay to brokerage for deal ${dealId}:`,
              message
            )
          }
        } else {
          // No merged PDF — already flagged transientFailure above. Do NOT check
          // off the items; release the dedup claim and ask SignWell to redeliver
          // so we capture the signed docs.
          console.error(
            `SignWell webhook: no completed PDF available — cannot store signed docs for deal ${dealId}. Checklist items NOT checked.`
          )
          transientFailure = true
        }

        console.log(`SignWell webhook: completed processing for deal ${dealId}`)
      }
    }

    // If the critical document-download/store work hit a recoverable failure,
    // release our dedup claim (DELETE the event row) and ask SignWell to
    // redeliver. The status flips already applied are CAS-guarded and safe to
    // re-apply; a non-2xx makes SignWell retry. A true duplicate never reaches
    // here (it 200s at the 23505 branch), and malformed/non-terminal events
    // return 200 above, so this only triggers a retry for genuine transients.
    if (transientFailure) {
      const { error: delErr } = await supabase
        .from('signwell_webhook_events')
        .delete()
        .eq('event_id', eventId)
      if (delErr) {
        // Couldn't release the claim. Still return non-2xx so SignWell retries;
        // on redelivery the INSERT will collide (23505) and 200 — so log loudly.
        console.error(
          `SignWell webhook: failed to release dedup claim for event ${eventId} after transient error:`,
          delErr.message
        )
      }
      console.error(
        `SignWell webhook: transient processing failure for document ${redactDocumentId(documentId)} — released dedup claim, returning 503 for SignWell retry`
      )
      return new Response('Transient processing failure - please retry', { status: 503 })
    }

    // Mark dedup row as successfully processed for observability/audit.
    await supabase
      .from('signwell_webhook_events')
      .update({ processed_at: new Date().toISOString(), processing_result: 'success' })
      .eq('event_id', eventId)

    return new Response('OK', { status: 200 })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown'
    console.error('SignWell webhook error:', message)
    // Always return 200 — we don't want SignWell to loop on a bug in our handler.
    return new Response('OK', { status: 200 })
  }
}
