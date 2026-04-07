# BCA DocuSign Flow -- Implementation Plan

## Overview

Add a Brokerage Cooperation Agreement (BCA) DocuSign signing flow to the Firm Funds project. The BCA is a brokerage-level document (one per brokerage, not per deal) signed by the Broker of Record. It should auto-send when a brokerage admin is invited, and be manageable from the admin UI.

---

## Phase 1: Database Migration (037_bca_esignature.sql)

**File:** supabase/migrations/037_bca_esignature.sql

### 1A. Extend esignature_envelopes table

The existing table has deal_id UUID NOT NULL. Make it nullable, add a brokerage_id FK, and add a CHECK constraint ensuring exactly one of the two is set.

Steps:
- ALTER TABLE esignature_envelopes ALTER COLUMN deal_id DROP NOT NULL
- ALTER TABLE esignature_envelopes ADD COLUMN brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE
- Add CHECK constraint chk_envelope_entity ensuring (deal_id IS NOT NULL AND brokerage_id IS NULL) OR (deal_id IS NULL AND brokerage_id IS NOT NULL)
- Drop existing document_type CHECK, re-add with (cpa, idp, bca)
- Add index idx_esignature_envelopes_brokerage_id

### 1B. Add bca_signed_at to brokerages table

- ALTER TABLE brokerages ADD COLUMN bca_signed_at TIMESTAMPTZ
- Add COMMENT explaining it populates the BCA_DATE template variable in deal contracts

### 1C. Signer column reuse

No schema change needed. The existing agent_signer_status and agent_signed_at columns will track the primary signer (Broker of Record for BCA envelopes, agent for deal envelopes). The document_type provides context.

---

## Phase 2: TypeScript Type Updates

**File:** types/database.ts

### 2A. Update EsignatureDocumentType (line 247)

Add bca to the union type.

### 2B. Update EsignatureEnvelope interface (line 250)

- Change deal_id: string to deal_id: string | null
- Add brokerage_id: string | null

### 2C. Update Brokerage interface (after line 62)

Add bca_signed_at: string | null

---

## Phase 3: BCA Document Template

**File:** lib/contract-docx.ts

Add generateBcaDocx(data: Record<string, string>): Promise<Buffer> following the exact pattern of generateCpaDocx() and generateIdpDocx().

### Template variables

- AGREEMENT_DATE -- Date the agreement is generated
- BROKERAGE_LEGAL_NAME -- Brokerage name
- BROKERAGE_ADDRESS -- Brokerage address
- BROKER_OF_RECORD_NAME -- Broker of Record name
- BROKER_OF_RECORD_EMAIL -- Broker of Record email
- BROKERAGE_RECO_NUMBER -- RECO registration number (if available)

### Document structure

Uses the same shared helper functions: heading2, body, richParagraph, emptyLine, makeHeader, makeFooterWithInitials, makeFooterNoInitials, infoTable.

**Section 1 -- Body pages:**
- Header: makeHeader(Brokerage Cooperation Agreement)
- Footer: makeFooterWithInitials(Broker of Record Initials)
- Content: Title, Subtitle, Date and Parties, RECITALS, ARTICLE 1 -- DEFINITIONS, ARTICLE 2 -- COOPERATION AND ACKNOWLEDGMENT, ARTICLE 3 -- IRREVOCABLE DIRECTION TO PAY PROCESS, ARTICLE 4 -- COMMISSION HANDLING AND TRUST ACCOUNT, ARTICLE 5 -- BROKERAGE OBLIGATIONS, ARTICLE 6 -- REFERRAL FEE, ARTICLE 7 -- TERM AND TERMINATION, ARTICLE 8 -- REPRESENTATIONS AND WARRANTIES, ARTICLE 9 -- CONFIDENTIALITY, ARTICLE 10 -- GENERAL PROVISIONS

**Section 2 -- Signature Page:**
- Header: makeHeader(Brokerage Cooperation Agreement -- Signature Page)
- Footer: makeFooterNoInitials()
- BROKERAGE signatory with /sig1/ and /dat1/ anchors
- FIRM FUNDS INC. signatory (static)

### Anchor tags

- /ini1/ in footer for initials on body pages (same DocuSign anchor pattern as CPA)
- /sig1/ on signature page for DocuSign SignHere tab
- /dat1/ on signature page for DocuSign DateSigned tab

---

## Phase 4: BCA Server Actions

**File:** lib/actions/esign-actions.ts

### 4A. sendBcaForSignature(brokerageId: string): Promise<ActionResult>

Core new server action. Pattern follows sendForSignature() closely.

Steps:
1. Authenticate admin via getAuthenticatedAdmin()
2. Check DocuSign connection via isDocuSignConnected()
3. Fetch brokerage: supabase.from(brokerages).select(*).eq(id, brokerageId).single()
4. Validate: brokerage exists, broker_of_record_email is set, broker_of_record_name is set
5. Check for existing pending BCA envelopes (status in [sent, delivered]) for this brokerage
6. Build BCA contract data from brokerage record
7. Generate .docx via generateBcaDocx(contractData)
8. Call createAndSendEnvelope() with: emailSubject, single document (documentId 1), signer = Broker of Record (recipientId 1), tabs on /sig1/ /dat1/ /ini1/, ccRecipients = brokerage admin + ADMIN_EMAIL
9. Insert envelope record with brokerage_id (not deal_id)
10. Log audit: action esignature.bca_sent, entityType brokerage
11. Return success with envelopeId

### 4B. voidBcaEnvelope(brokerageId: string, reason: string): Promise<ActionResult>

Pattern follows voidDealEnvelopes(). Finds active BCA envelopes for the brokerage, voids via DocuSign API, updates DB.

### 4C. getBcaSignatureStatus(brokerageId: string): Promise<ActionResult>

Pattern follows getDealSignatureStatus(). Queries envelopes where brokerage_id = brokerageId and document_type = bca.

### 4D. resendBcaForSignature(brokerageId: string): Promise<ActionResult>

Convenience: voids existing active envelope (if any), then calls sendBcaForSignature().

---

## Phase 5: Webhook Updates

**File:** app/api/docusign/webhook/route.ts

### 5A. Detect envelope type

After fetching envelopes from DB (~line 36-43), determine type by checking envelopes[0].document_type and envelopes[0].deal_id.

### 5B. BCA-specific signed handler

When mappedStatus is signed AND isBcaEnvelope:
1. Get brokerage_id from envelope record
2. Download signed PDF from DocuSign (documentId 1)
3. Upload to Supabase storage: brokerages/{brokerage_id}/{timestamp}_{uuid}.pdf in deal-documents bucket
4. Create brokerage_documents record with document_type: cooperation_agreement
5. Update brokerages table: bca_signed_at = now()
6. Call sendBcaSignedNotification() to alert admin

### 5C. Preserve deal-specific logic

Wrap existing deal handler (lines 103-218) in if (isDealEnvelope) block. All existing behavior remains identical.

### 5D. Status update logic

The shared status update logic (lines 56-97) works for both deal and BCA envelopes with no changes.

---

## Phase 6: Auto-trigger on Brokerage Admin Invite

**File:** lib/actions/admin-actions.ts

### 6A. Add BCA auto-send to inviteBrokerageAdmin()

After line ~1982 (after audit log), add a non-blocking BCA send attempt:
1. Re-fetch brokerage to check broker_of_record_email and broker_of_record_name
2. If both are set, call sendBcaForSignature(input.brokerageId)
3. Wrap in try/catch -- log warnings on failure but NEVER fail the invite
4. DocuSign not being connected is a non-fatal condition

### 6B. Import dependency

Add import { sendBcaForSignature } from esign-actions at top of admin-actions.ts.

---

## Phase 7: Populate BCA_DATE in Deal Contracts

**File:** lib/actions/esign-actions.ts

### 7A. Update sendForSignature() (~line 146)

Replace the hardcoded On file with a dynamic lookup using the brokerage bca_signed_at field. If bca_signed_at is set, format it as a date. Otherwise keep On file.

---

## Phase 8: Email Notification

**File:** lib/email.ts

### 8A. sendBcaSignedNotification()

New function following existing email patterns. Uses wrap() for branded HTML.
Parameters: { brokerageName, brokerOfRecordName, signedAt }
Sent to: ADMIN_EMAIL (bud@firmfunds.ca)
Subject: BCA Signed -- {brokerageName}

---

## Phase 9: Admin UI Updates

**File:** app/(dashboard)/admin/brokerages/page.tsx

### 9A. New BCA Status section

Insert between the KYC Verification section (~line 1378) and the Brokerage Documents section (~line 1380).
Visual pattern matches the KYC section:
- Icon + title Brokerage Cooperation Agreement
- Status badge: Not Sent (grey), Sent/Awaiting Signature (blue), Signed (green) + date, Declined (red), Voided (grey)
- Action buttons: Send BCA, Resend BCA, Void BCA as appropriate

### 9B. New state variables

- bcaStatus: Record<string, { status: string; signedAt?: string; envelopeId?: string } | null>
- bcaLoading: string | null
- bcaSending: string | null

### 9C. Data loading on expand

When brokerage row expands (~line 1109), also load BCA status via getBcaSignatureStatus().

### 9D. Update local Brokerage interface

Add bca_signed_at: string | null to the Brokerage interface at lines 58-75.

### 9E. Import new server actions

Add sendBcaForSignature, voidBcaEnvelope, getBcaSignatureStatus to the import from esign-actions.

---

## Implementation Order

Execute in this exact sequence:

1. **Migration 037** -- Database changes (Phase 1)
2. **TypeScript types** -- Update types/database.ts (Phase 2)
3. **Document template** -- Add generateBcaDocx() to lib/contract-docx.ts (Phase 3)
4. **Server actions** -- Add BCA actions to lib/actions/esign-actions.ts (Phase 4)
5. **Email notification** -- Add sendBcaSignedNotification() to lib/email.ts (Phase 8)
6. **Webhook updates** -- Update app/api/docusign/webhook/route.ts (Phase 5)
7. **BCA_DATE population** -- Update sendForSignature() in esign-actions.ts (Phase 7)
8. **Auto-trigger** -- Update inviteBrokerageAdmin() in admin-actions.ts (Phase 6)
9. **Admin UI** -- Update app/(dashboard)/admin/brokerages/page.tsx (Phase 9)

---

## Key Design Decisions

### D1: Single table vs separate table for BCA envelopes

**Decision:** Extend esignature_envelopes with optional brokerage_id and nullable deal_id, with a CHECK constraint.
**Rationale:** Envelope tracking semantics are identical. A separate table would duplicate the schema and require the webhook to query two tables.

### D2: Signer column reuse

**Decision:** Reuse agent_signer_status / agent_signed_at for the Broker of Record signer.
**Rationale:** These track recipientId=1 (the primary signer). The document_type provides disambiguation.

### D3: BCA send is non-blocking during invite

**Decision:** If BCA send fails during inviteBrokerageAdmin(), log a warning but do not fail the invite.
**Rationale:** DocuSign might not be connected or Broker of Record email might not be set.

### D4: Storage path for signed BCA

**Decision:** Use brokerages/{brokerage_id}/{timestamp}_{uuid}.pdf in the existing deal-documents bucket.
**Rationale:** This exact path pattern is already used for manual brokerage doc uploads. The brokerage_documents table already has a cooperation_agreement document type.

### D5: CC recipients for BCA

**Decision:** CC the brokerage admin email and Firm Funds admin (ADMIN_EMAIL).
**Rationale:** Brokerage admin needs to know the BCA was sent/signed. Firm Funds admin needs a copy.

---

## Files Modified (Summary)

| File | Change |
|------|--------|
| supabase/migrations/037_bca_esignature.sql | NEW -- Migration for schema changes |
| types/database.ts | Update EsignatureDocumentType, EsignatureEnvelope, Brokerage |
| lib/contract-docx.ts | Add generateBcaDocx() |
| lib/actions/esign-actions.ts | Add BCA actions; update BCA_DATE in sendForSignature() |
| lib/email.ts | Add sendBcaSignedNotification() |
| app/api/docusign/webhook/route.ts | Branch on BCA vs deal envelopes in signed handler |
| lib/actions/admin-actions.ts | Add BCA auto-send in inviteBrokerageAdmin() |
| app/(dashboard)/admin/brokerages/page.tsx | Add BCA status section with send/void/resend buttons |

---

## Testing Checklist

- [ ] Migration runs cleanly on existing data
- [ ] Existing deal envelope flows still work (CPA + IDP send, webhook, void)
- [ ] BCA document generates correctly (.docx with proper formatting)
- [ ] BCA sends to Broker of Record via DocuSign
- [ ] BCA envelope tracked in esignature_envelopes with brokerage_id
- [ ] Webhook processes BCA signed event correctly
- [ ] Signed BCA PDF stored in Supabase and brokerage_documents record created
- [ ] bca_signed_at updated on brokerage record when BCA is signed
- [ ] After BCA signed, deal contracts show actual BCA date
- [ ] inviteBrokerageAdmin() auto-sends BCA when broker_of_record_email is set
- [ ] inviteBrokerageAdmin() succeeds even if BCA send fails
- [ ] Admin UI shows correct BCA status per brokerage
- [ ] Admin can manually send, void, and resend BCA from UI
- [ ] BCA send blocked if broker_of_record_email not set (with helpful message)
- [ ] Duplicate BCA send prevented (error if active envelope exists)

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Migration making deal_id nullable breaks existing queries | All existing queries filter by deal_id = X which works with nullable columns |
| Webhook failing to distinguish BCA from deal envelopes | The document_type column is always set. Check on first record is deterministic |
| DocuSign anchor string conflicts | BCA uses same anchors but in separate envelopes. No conflict |
| BCA content needs legal review | Template uses placeholder content. Infrastructure is decoupled from content |
