# Firm Funds — Multi-Province Expansion Research

**Date:** 2026-05-29
**Status:** Research only. No code, contracts, or operations were changed.
**Scope:** What it would take to extend the commission advance product from Ontario to every other Canadian province and territory.
**Honesty posture:** Every finding is sourced via live searches. Anything inferred, anything where the source could not be retrieved, anything we did not search for, is flagged explicitly. We do not claim a market is empty unless we name the searches that came up dry.

---

## 1. TL;DR

You can expand. None of the twelve other jurisdictions is legally impossible. But two things are true at the same time:

1. There is one big federal change that already applies to you in Ontario and gets more important in every other province: **as of April 1, 2025, Firm Funds is a "factor" under the federal AML rules (PCMLTFA / FINTRAC)**. That is mandatory, the regime has been in force for over a year, and it sits on top of any provincial work. This is the single most urgent compliance item from this report.
2. The provinces sort into three buckets:
   - **Tractable common-law provinces** (BC, AB, SK, MB, NS, NB) where the model translates with document edits, an extra-provincial corporate registration, a PPSA equivalent filing, and a written legal opinion or two.
   - **High-friction province** (QC) where the legal device shifts from "true sale + PPSA" to "cession de créance + RDPRM," the money flow is notary-driven (not brokerage-driven), Bill 96 makes everything French-first, and there is a separate Quebec privacy regime (Law 25) that already affects you the moment a Quebec resident's data lands in your Ontario stack.
   - **Low-yield small markets** (NL, PE, YT, NT, NU) that are not worth standalone entry. NL also has a fresh high-cost credit licensing trap. PE/YT/NT/NU should be bundled or skipped.

The market is contested but not saturated. The dominant national player, AccessEasyFunds, explicitly does not serve Quebec. Alberta has a structural moat (AREA Advance is owned by the Alberta REALTORS® trade body). Atlantic Canada and Saskatchewan look the most under-fished, but we did not find a regional Atlantic-only specialist, and we did not exhaustively search by every regional name. Do not enter on the assumption that any province is wide open.

Recommended sequence: **British Columbia second, Alberta third, SK + MB + Atlantic blanket year two, Quebec year three, skip the territories.**

---

## 2. The Federal Change That Applies Regardless Of Province

### 2.1 You are now a "factor" under FINTRAC, in force since April 1, 2025

This is the single most important finding in this entire report.

Canada Gazette Part II published **SOR/2025-68** on March 26, 2025, accelerated from the original draft target. Effective **April 1, 2025**, the *Proceeds of Crime (Money Laundering) and Terrorist Financing Act* defines factoring entities as reporting entities. The regulatory definition explicitly captures:

> "Persons and entities offering 'advances' to their clients, which may be reimbursed by their clients under certain conditions if the accounts receivable are not collected."

That is the commission advance business model written verbatim. There is no real ambiguity about whether this applies to Firm Funds. It does.

**What this means operationally, even before expanding to a second province:**

| Obligation | Trigger | Filing deadline |
|---|---|---|
| Suspicious Transaction Report (STR) | Any time there are reasonable grounds to suspect money laundering or terrorist financing | 3 business days |
| Large Cash Transaction Report (LCTR) | $10,000+ cash in single transaction or aggregated under 24-hour rule | 15 days |
| Large Virtual Currency Transaction Report (LVCTR) | $10,000+ in crypto | 5 business days |
| Terrorist Property Report / Listed Person Report | Any property of a listed person or entity (includes SEMA / Magnitsky additions Oct 1, 2025) | Forthwith |
| Records (factoring agreement) | Every deal | 5-year retention from last transaction |
| Records (receipt of funds) | Every brokerage closing payment ≥ $3,000 | 5-year retention |
| Compliance program | Mandatory baseline | Ongoing |

LCTR is unlikely to ever fire for our model since we are entirely electronic. STR plus the records side is the bulk of the load.

**Compliance program required elements**: designated compliance officer, written policies and procedures, documented risk assessment, training program, biennial effectiveness review.

**KYC requirements**: identify every party to a factoring agreement (the agent), beneficial ownership for corporate counterparties (relevant when an agent uses a PREC), ongoing monitoring, PEP / head of international organization screening, and re-verification (a "business relationship" is established on the second verification within five years).

If we have not formally registered with FINTRAC under the new factor category and stood up the program, that is the first thing to fix. The year-one enforcement posture is officially "education and support over enforcement" but that goodwill is not a safe harbour heading into mid-2026.

### 2.2 The 35% criminal interest rate cap (Criminal Code s.347)

As of **January 1, 2025**, the criminal interest rate dropped from 60% effective annual rate to **35% APR**. Source: Bill C-47 (Budget Implementation Act 2023 No. 1), Royal Assent June 22, 2023.

Three scenarios matter for us:

(a) **True sale stands** (the goal). s.347 does not apply because there is no "interest," just a discount on a purchase price. Standard structured finance result.

(b) **True sale recharacterized as a secured loan to an unincorporated agent**. s.347 35% APR cap applies. Math check: $0.80 per $1,000 per day = 29.2% per annum simple, daily charge. Late accrual is 24% per annum compounded daily starting day 31. Worst-case combined risk: in a scenario where a court annualizes administrative fees alongside the discount (the anti-avoidance interpretive approach), short-term small-dollar deals can edge above 35%. The base case at $0.80 with no extra fees is comfortably under.

(c) **True sale recharacterized as a commercial loan to an incorporated agent (PREC)**. Falls under the $10K to $500K commercial exemption at 48% APR. Even more headroom.

**What to do**: get a tax and finance lawyer opinion documenting the true-sale analysis, with a fallback that confirms the math under the 35% cap. This is protection if challenged and a useful credibility asset when pitching institutional brokerage partnerships.

### 2.3 Quebec Law 25 applies the moment you handle Quebec residents' data, not when you open a Quebec office

This is counterintuitive. Quebec's Law 25 (formerly Bill 64) is fully in force as of September 22, 2024. Penalties run up to **C$10 million or 2% of worldwide turnover** for administrative breaches, and **C$25 million or 4%** for penal offences.

Before transferring personal info **outside Quebec** (including to Ontario), you must conduct a **Privacy Impact Assessment** evaluating sensitivity, purpose, contractual and technical safeguards, and the legal regime of the destination. Ontario does not have a general private-sector privacy statute, so an Ontario-hosted destination requires a substantive Transfer Impact Assessment with contractual safeguards (Supabase, Netlify, DocuSign, Resend, etc.).

You also need:
- A named "person in charge of the protection of personal information" (the CEO by default if unnamed)
- Mandatory breach reporting to the Commission d'accès à l'information
- Right of erasure / de-indexation, right to data portability, automated-decision-making transparency
- PIA scaffolding before any Quebec data lands in the system

The practical implication: **you don't need a Quebec office to need Law 25 compliance. You need it the first time a Quebec realtor signs up, or even the first time a Quebec brokerage admin pastes in a Quebec agent's email.** This is currently a gap in the Ontario-only setup that will get audited the moment you cross the river.

### 2.4 Other federal items, briefly

- **Quebec MSB licence: NOT required.** Quebec's *Loi sur les entreprises de services monétaires* defines money services as currency exchange, funds transfer, traveler's cheques/money orders/drafts, cheque cashing, ATMs (including crypto ATMs since 2024). Factoring and commission advance are not in scope. Confirmed.
- **PIPEDA + provincial PIPA map**: PIPEDA governs everywhere except where displaced by AB PIPA, BC PIPA, or Quebec Law 25 for activities wholly within those provinces. Any inter-provincial flow still touches PIPEDA.
- **CASL** (anti-spam): federal, same in every province. B2B exemption likely covers cold brokerage outreach if the message is relevant to their business, but documentation matters.
- **Bank Act / Trust and Loan Companies Act**: do not apply to us. We do not take deposits.
- **CBCA vs OBCA**: If we expand to 4+ provinces, a CBCA conversion is worth the one-time cost (~$214) for nationwide name protection. Note that CBCA does NOT eliminate extra-provincial registration in each province where you do business. It just protects the name.
- **Beneficial ownership reporting (effective Oct 1, 2025)**: When verifying a PREC counterparty against Corporations Canada or a provincial registry, discrepancies must be reported.

---

## 3. Province-By-Province Detail

For each province we cover: **Regulator**, **Money flow at closing**, **PPSA equivalent**, **Consumer credit / licensing risk**, **Tax**, **Privacy**, **Extra-provincial registration**, **Competition**, **Document changes needed**.

### 3.1 British Columbia (recommended second province)

**Regulator and statute**: BC Financial Services Authority (BCFSA). The Real Estate Council of BC and the Office of the Superintendent of Real Estate fully integrated into BCFSA on August 1, 2021. Governing statute: *Real Estate Services Act* (SBC 2004, c.42) and *Real Estate Services Rules* (BC Reg 209/2021). February 1, 2024 amendments tightened conflict-of-interest disclosure rules, record retention, and BCFSA reporting. Licensee class structure: Brokerage > Managing Broker (the "broker of record" equivalent) > Associate Broker > Representative. Public registrant search: <https://www.bcfsa.ca/public-resources/real-estate/find-professional>.

**Money flow at closing**: Closing can be handled by a **lawyer OR a notary public** (BC permits notaries to do real estate transactions, unlike Ontario or Alberta). Lawyer or notary disburses commission to the listing brokerage at Completion, and the listing brokerage forwards the cooperating side's share. Implication: any Brokerage Cooperation Agreement template needs to address the notary channel, not just lawyers. The "firm date" terminology BC uses is **"subject removal"**, not "firm" or "waiver of conditions."

**Critical legal question to confirm before launch**: BCFSA's web guidance states "money may be paid from the brokerage commission trust account to a third party as long as the licensee's consent was first obtained." That is encouraging but **permissive, not mandatory**. We did not find a clean statutory section authorizing irrevocable assignment to a third party. The wording suggests the IDP would work in practice but does not compel the brokerage to honour it. **This needs a written opinion from BC real estate counsel** before any BC deal is processed.

**PPSA**: *Personal Property Security Act* (BC), via the BC Personal Property Registry. Cost: $5 per year of registration up to 25 years, or $500 for infinity. Accounts receivable classified as "intangibles." Note: June 1, 2024 amendments changed debtor-location rules for intangibles, meaning we may need to register in Ontario instead of BC for a BC-resident agent. Confirm with structured-finance counsel.

**Consumer credit risk**: *Business Practices and Consumer Protection Act*, enforced by Consumer Protection BC. The high-cost credit framework (BC Reg 290/2021, in force May 1, 2022) defines a "high-cost credit product" as fixed credit, open credit, or leases with APR > 32% **for a personal, family, or household purpose**. Verified the verbatim regulation text. Commission advances to licensed agents are commercial cash-flow tools, not consumer credit. Defensible but document the position. There is also a **PST expansion (Notice 2026-001) taking effect October 1, 2026**, which adds "non-residential real estate services" at 7%. It does not obviously hit a financial-service discount fee but the line is close enough that we should get written guidance from the BC Ministry of Finance before opening BC.

**Tax**: GST 5% federal + PST 7% provincial. Financial services are exempt under GST (Excise Tax Act s.123(1)). Best practice: wrap the discount fee in the purchase price, do not itemize a servicing fee. PST historically exempts stand-alone financial services. Flag the PST 2026 expansion for a written ruling.

**Privacy**: BC PIPA. Designate a privacy officer with publicly available contact info (no commissioner registration required). Breach notification is voluntary under PIPA but PIPEDA's mandatory breach reporting still applies federally. Add a BC PIPA appendix to the privacy policy.

**Extra-provincial registration**: Required. Federal corporation advantage: name protection is nationwide so an existing federal corp skips name approval. $350 government fee. Processing 10 business days standard, $100 priority surcharge for expedited. Registered office in BC required. We did not specifically verify whether a registered agent for service is mandatory; typical practice is to retain a BC corporate services provider.

**Competition**: 7+ active players. Confirmed names with BC focus: **AccessEasyFunds** ($0.75/$1,000/day, "$9B+ advanced," Vancouver landing page), **iCommission** ($0.60-$0.75/$1,000/day, multiple Royal LePage partner brokerages including BC), **Capital Growth Financial** ($0.69/$1,000/day, Calgary HQ, claims lowest in Canada), **Realserve** ($0.75/$1,000/day + admin), **FRAME Financial** ($0.66/$1,000/day), **Rocket Advance** (Vancouver page), **Agent's Equity**, **Assadi Private Capital** (Vancouver-focused, repayment via direct brokerage trust deduction). iCommission appears as the named commission advance partner on multiple Royal LePage BC brokerage landing pages, which is the most material competitive obstacle.

We did NOT search Vancouver-specific private lenders, brokerage intranet vendor pages, or specifically search "Beyond Funding" / "Wing Commission Advance" successfully (those terms surfaced no concrete Canadian entity).

**Top 5 BC blockers**:
1. No explicit statutory pathway for "irrevocable direction to pay" in RESA Rules. Permissive language in BCFSA guidance, not mandatory. Legal opinion needed.
2. PST expansion (Notice 2026-001) effective October 1, 2026 needs a written Ministry of Finance ruling that it does not capture our discount fee.
3. BC PPSA debtor-location amendments (June 2024) may push us to register in Ontario, not BC, for BC-resident agents.
4. Extra-provincial registration $350 + 10 business days standard processing.
5. iCommission's embedded Royal LePage relationships are a real competitive moat that needs a counter-strategy.

### 3.2 Alberta

**Regulator and statute**: Real Estate Council of Alberta (RECA). Still standalone as of 2026 (did not roll into a broader financial regulator). *Real Estate Act* (RSA 2000, c R-5), *Real Estate Act Rules*, *Real Estate (Ministerial) Regulation* (Alta Reg 113/1996). Bill 20 created four Industry Councils (Residential, Commercial, Property Managers, Mortgage Brokers). **Authority to approve new Rules transfers from Minister to Industry Councils on June 30, 2025**. Licensee class structure: Brokerage > Broker (broker of record equivalent) > Associate Broker > Associate. Public registrant search: RECA ProCheck at <https://procheck.reca.ca/>.

**Money flow at closing**: Closing through a real estate lawyer (mandatory, no notary alternative). Same model as Ontario, easier conceptual port than BC. AB does NOT have an Ontario-style Property Transfer Tax. **Terminology**: AB uses "condition removal" or "Notice of Fulfillment" or "Condition Waiver," not "firm date."

**Critical legal question to confirm before launch**: **Section 50(c) of the Real Estate Act Rules** restricts who can receive commission "directly or indirectly," limiting payment to the brokerage's licensees, a corporation 50%+ owned by them, or another licensed brokerage. Read literally, this could prevent direct payment to a non-brokerage assignee (us) out of trust. RECA's April 2019 Bulletin "Commissions – Payment From Trust" describes payment to a third party as allowable under written direction, but the verbatim Rules section authorizing payment to an assignee was not retrievable in this research session. **This is the single biggest substantive legal question for AB and needs an Alberta real estate counsel opinion before launch.** A possible workaround: the brokerage pays the licensee from trust, the licensee then pays us via a separate banking instruction, but our model relies on direct IDP payment, so the structure may need a tweak.

**PPSA**: Alberta Personal Property Registry, accessed through registry agents (not direct public access). $22 first year + $2 per additional year up to 25 years, or $400 infinity. Plus registry agent service fees ($10-25 typical). June 1, 2024 amendments changed debtor-location rules same as BC.

**Consumer credit risk**: *Consumer Protection Act* (RSA 2000, c C-26.3) and *High Cost Credit Regulation* (Alta Reg 132/2018, in force Jan 1, 2019). **High-cost credit threshold: 32% APR or higher. License cost: $1,000/year + $500/year per additional location + $500 renewal, $10,000 security (bond, cash, or LOC).** The regulation lists installment loans, title loans, lines of credit, rent-to-own, leases, pawn loans, credit cards, retail cards, HELOCs as covered products. The list reads as consumer-flavoured, but the page does NOT explicitly say "consumer purpose only" the way BC's regulation does. **We could not retrieve the verbatim definition section of Reg 132/2018** (CanLII returned 403). Reasonable extrapolation: the AB CPA applies to "consumer transactions" so commercial advances to licensed agents should fall outside. **But this is less defensible than BC. AB counsel must give a written opinion before launching.**

**Tax**: GST 5%, no PST. Cleanest tax landscape in Canada among the major provinces. Same federal financial-service exemption applies to the discount fee. Wrap fees, do not itemize.

**Privacy**: Alberta PIPA. Designate a privacy officer (no commissioner registration). **Mandatory breach reporting** under PIPA s.34.1 when there is real risk of significant harm. **Process updated April 1, 2024 with new Privacy Breach Notification Form.** Penalties up to $10,000 (individual) / **$100,000 (corporation)** for failure to report. Stricter than BC.

**Extra-provincial registration**: Required. Government fee ~$450 plus NUANS optional ($30, but federal corps are NUANS-exempt). Registry agent service fees vary $129-$300. Processing 1-3 business days through a registry agent (faster than BC). Registered office in AB required.

**Competition**: 7+ active players including the most structurally entrenched competitor in Canada. **AREA Advance** is owned by **AREA Real Estate Services Corp, a subsidiary of the Alberta Real Estate Association** (the provincial trade body that 12,000+ AB realtors belong to). $0.66/$1,000/day, claims 24% APR. 12,100 participating agents, $27M advanced, 99% approval. This is essentially the in-house default product for every Alberta REALTOR®. Other players: Capital Growth Financial (Calgary HQ, $0.69/$1,000/day), iCommission (Calgary and Edmonton landing pages), AccessEasyFunds, Realserve, FRAME Financial, Rocket Advance (Edmonton), Agent's Equity, Assadi Private Capital (Calgary corporate registration).

**Top 5 AB blockers**:
1. Rules s.50(c) ambiguity on direct payment to non-brokerage assignees. **The biggest substantive legal question.**
2. AREA Advance is owned by the provincial REALTORS® association. Structural moat.
3. High-cost credit license definition scope unclear from publicly retrievable sources. Less defensible than BC.
4. AB PIPA mandatory breach reporting with $100K corporate fine.
5. Capital Growth at $0.69 + AREA at $0.66 vs our $0.80. Price-driven market.

### 3.3 Quebec (highest friction, defer to year 3)

Quebec is structurally different from every common-law province. It is not impossible but it is roughly **2x the work of an additional common-law province expansion**. The reason the dominant national player AccessEasyFunds does not serve Quebec is likely strategic ROI, not legal impossibility.

**Regulator and statute**: Organisme d'autoréglementation du courtage immobilier du Québec (OACIQ). *Real Estate Brokerage Act* (RLRQ c. C-73.2) and the *Regulation respecting brokerage requirements, professional conduct of brokers and advertising*. Licensee classes: chargé d'agence / dirigeant d'agence (agency executive officer), courtier immobilier résidentiel, courtier immobilier commercial. Mortgage brokers moved to AMF in 2020. Public licence registry: **Synbad** at <https://registre.oaciq.com/en/find-broker>.

**Money flow at closing — the structural difference**: In Quebec, real estate closings are handled by **NOTARIES, not lawyers**, under the Notarial Act. The notary holds buyer deposit, mortgage proceeds, and adjustments in trust (governed by N-3, r.5). **Funds must be in the notary's trust account 48 hours before signing.** The notary disburses commission to the listing agency directly at closing on the basis of instructions inserted into the promesse d'achat (Annex R for residential, clauses R2.5 and 11.4).

Critical OACIQ rule: **"The broker acting within an agency cannot under any circumstances be paid directly. The same applies to his business corporation."** Only the agency (the brokerage entity) can be instructed to receive direct notary payment. This means:

- Our **counterparty for any assignment must be the brokerage agency**, not the individual broker, not the broker's PREC.
- The broker's claim is against the agency, not against the notary.
- We **cannot** intercept money at the notary-to-agency step. The notary will not pay a non-broker third party.

We **can** intercept at the agency-to-broker step using a properly perfected cession de créance with art. 1641 CCQ notice + written agency acceptance. The agency holds funds in trust briefly under N-3, r.5 and disburses to us in place of the broker. This mirrors the Ontario model with stricter formal-acceptance requirements.

There is a stronger option (Option B) — insert a **stipulation pour autrui** clause directly in the promesse d'achat directing the notary to remit a specific dollar amount to Firm Funds. OACIQ confirms a notary must respect such a stipulation. The cost: **the agency must instruct the notary BEFORE the promesse d'achat is finalized**, so deal-by-deal cooperation must be locked in before the offer is firm. There is no clean "we send an IDP after the offer is firm" mechanism. This may not match how we typically operate.

**The legal device shifts from "true sale + PPSA" to "cession de créance + RDPRM"**:
- Civil Code articles 1637-1646 govern assignment of claims ("cession de créance"). Art. 1641 makes the assignment opposable to the brokerage (the debtor) only on (a) acquiescence, (b) receipt of a copy of the act of assignment, or (c) "any other evidence" including email or fax.
- Art. 1642 makes a *universality* of claims (e.g., all of an agent's current and future commissions) require RDPRM publication to be opposable to non-acquiescing debtors and third parties.
- **Article 1801 risk**: clauses that look like a loan with security can be recharacterized. An assignment of receivables purely for security purposes is not valid in Quebec, the creditor must hypothecate them. Substance over form. We could not retrieve the verbatim text of art. 1801 in this research session, so the verbatim wording must be vetted by Quebec counsel before any structuring decision.

To survive recharacterization risk, our Quebec documents must:
- Be a cession at a discount with no buy-back, no top-up, no shortfall indemnity from the agent (clean economic transfer).
- Include explicit written acquiescence by the agency (cleanest art. 1641 mechanism).
- For repeat business with the same agent, file a hypothec or universal cession in RDPRM.

**RDPRM** (Registre des droits personnels et réels mobiliers): the provincial equivalent of PPSA for movable security. Publication is a condition of opposability, not validity. Cost: not surfaced in research, anchor estimate ~$50/registration is an inference not verified.

**AMF / Revenu Québec MSB licensing**: not required. Quebec MSB definition (currency exchange, funds transfer, traveler's cheques/money orders/drafts, cheque cashing, ATMs) does not include factoring. Confirmed via the Act and the AMF / Revenu Québec materials. **However**, if any Quebec regulator argued our model is a "money loan" in substance, we could be pulled in. Get an opinion letter from a Montreal financial-services lawyer.

**Quebec Consumer Protection Act**: real estate brokers acting as professionals are not "consumers" under the LPC. Likely safe to be outside scope. **Have counsel confirm**, since some Quebec case law drags individuals into "consumer" status when they are functionally retail.

**Bill 96 (Charter of the French Language)**: in force June 1, 2023. All contracts of adhesion and related documents must be presented in French first. The adhering party must explicitly state in writing that they want to proceed in English, and they must have actually seen a French version first. "No payment whatsoever may be claimed in association with the drafting of the French version." Our Commission Purchase Agreement is an adhesion contract by design (pre-drafted, take-it-or-leave-it). **Treat all Quebec-facing contracts as adhesion contracts requiring French-first presentation.** This includes:
- Commission Purchase Agreement → "Acte de cession de créance"
- Irrevocable Direction to Pay → "Délégation/instruction irrévocable de paiement" or "Stipulation pour autrui"
- Brokerage Cooperation Agreement → "Convention de coopération avec l'agence"
- All marketing pages, agent UI, brokerage UI, email and SMS notifications, statements.

**Business name**: "Firm Funds Inc." needs a French version declared in the immatriculation. Options: "Fonds Firm Inc.," "Firm Funds Inc. (Fonds Firm)," or operate under a registered French trade name.

**Law 25** (privacy): see Section 2.3 above. Fully in force Sept 22, 2024. PIA required for any data transfer out of Quebec. Designate a privacy officer publicly. Mandatory breach reporting to the Commission d'accès à l'information. Right to erasure, right to portability, automated-decision-making transparency. Cross-border data transfer to Ontario systems (Supabase, Netlify, DocuSign US) requires PIA and contractual safeguards. **Expect a 2-4 month privacy architecture review** before launch.

**Tax**: GST 5% + QST 9.975%. Revenu Québec administers both. **Financial services are exempt from both** (Excise Tax Act s.123(1)(d) for GST, parallel QST rules). Receivable purchase at a discount is widely treated as an exempt financial service. Get a Revenu Québec written ruling specifically on commission advance / real estate factoring before launch. Register for NEQ (Numéro d'entreprise du Québec) and QST.

**Extra-provincial registration**: File immatriculation with REQ (Registraire des entreprises). Get a NEQ. Declare a French business name. Annual updating declaration required. Estimated ~C$400-500 fee (inference, not verified for 2026). 2-4 week paper exercise.

**Competition**: less crowded than ROC but not empty.
- **Flexicom** (Montreal HQ, est. 2009): 7,500+ brokers nationally, up to $25K per transaction / $75K per broker, bilingual French-primary, calculator pricing. <https://flexicom.ca/>
- **CommExpress**: bilingual Quebec commission advance brand, "$2,000 for as little as $85" advertised, testimonials from Via Capitale, Re/Max Action, Sotheby's. <https://www.commexpress.ca/>
- **Prêts Québec** (referral platform, not a direct lender): quotes per-advance max $15K, per-broker $50K, 30-day grace, fees 5-25%.
- **Capital Growth Financial** claims to work "with hundreds of real estate brokerages and offices in every province in Canada including Quebec" but actual operational Quebec presence is uncertain.
- **Rocket Advance** has a Montreal landing page but Quebec is not in their operational list.
- **AccessEasyFunds** explicitly does not operate in Quebec.

We did NOT search for Caisse Desjardins or Quebec credit union competitor products, embedded brokerage-internal advance programs (Via Capitale, Royal LePage Québec corporate), or French-only "affacturage commissions immobilières" terms. **The market may have additional Quebec-resident competitors we did not discover.**

**What Quebec entry actually costs (rough order of magnitude)**:
- Scoping opinion from a Quebec firm (Lavery, Miller Thomson, Stikeman, Fasken, McCarthy, BLG, Langlois): ~C$10K
- Full structuring + bilingual document drafting package: ~C$30-60K (inference)
- French translation and dual-UI build: 6-9 month i18n project plus ongoing translation costs
- Law 25 PIA + cross-border privacy architecture: 2-4 months
- 1-2 Quebec notaires on retainer for transaction support and opinion briefs
- Possibly a 10-15% rate premium ($0.85-$0.95 / $1,000 / day) to absorb structural overhead

**Quebec verdict**: doable, but defer until BC + AB + Atlantic + SK + MB are running. Use the cash flow from those to fund Quebec entry. Quebec is roughly 22% of the Canadian real estate market by volume, so it matters at scale.

### 3.4 Saskatchewan

**Regulator and statute**: Saskatchewan Real Estate Commission (SREC). *The Real Estate Act* (SS 1995, c R-1.3). License classes: Salesperson, Associate Broker, Broker, Branch Manager, with streams for residential / commercial / farm / property management. Public search: <https://ols.srec.ca/aspx/pubinquiry>.

**Money flow at closing**: SK brokerages hold deposits and commissions in trust accounts under the Real Estate Act. We did not pull the verbatim section on whether commission portions sit in trust pre-disbursement to the agent. Anti-assignment / recharacterization risk: standard true-sale documentation should hold under SK PPSA's "deemed security interest" treatment of receivable sales. Confirm before launch.

**PPSA**: The Personal Property Security Act, 1993, via Saskatchewan Personal Property Registry (SPPR) operated by ISC. Online at <https://www.saskregistries.ca/sppr>. **$12 per year of registration**, online. Searches $11. Fee increase effective April 15, 2026. Accounts receivable are intangibles, perfection by registration.

**Consumer credit risk**: *Cost of Credit Disclosure Act, 2002* + *Payday Loans Act*, both enforced by FCAA Saskatchewan. Payday lender licensing exists (rate cap 23% of principal). We did NOT find a dedicated Saskatchewan "high-cost credit" license analog to Manitoba or Newfoundland. Confirm with FCAA. Recharacterization risk low if true-sale clean.

**Tax**: GST 5% + PST 6%. PST application to financial services: Saskatchewan PST applies to enumerated taxable services, not financial services generally. The discount fee should be PST-exempt as a financial service, **but Saskatchewan PST has been incrementally expanded in recent budgets** and warrants a written ruling from the SK Ministry of Finance before launch. Federal: discount fee = GST-exempt financial service.

**Privacy**: No SK-specific substantially-similar private-sector privacy law. PIPEDA applies.

**Extra-provincial registration**: Ontario is not an NWPTA member so no streamlining benefits apply. Standard filing with ISC Corporate Registry. ~$265 government fee + $20-60 name search. Annual maintenance ~$45. SK-resident agent for service required. Typically same-week through ISC online portal.

**Competition**: iCommission explicitly lists **Regina** as a serviced city. AccessEasyFunds covers SK ("all across Canada except Quebec"). Agent's Equity national. Rocket Advance's province list does not visibly include SK. We did NOT search by named smaller/regional players (e.g. "Funds Direct," "Commission Now," "RealCash"). Do not assume the field is just the four above.

### 3.5 Manitoba (highest single-province regulatory risk in this batch)

**Regulator and statute**: Manitoba Securities Commission Real Estate Division, operating under the Manitoba Financial Services Agency (MFSA) brand. *The Real Estate Services Act* (RESA, CCSM c R21), replaced *The Real Estate Brokers Act* on **January 1, 2022** (Bill 70). Most recent amendments in force **June 3, 2025**. License classes: brokerage, broker, salesperson, branch manager. Public search: <https://themfsa.ca/enforcement/public-search/>.

**Money flow at closing**: RESA requires brokerages to maintain an interest-bearing trust account at a Manitoba-branch financial institution. Interest on the trust account is payable to the Commission (not the agent or client). Commission can request bank-account info at any time. No statutory bar on third-party assignment of an agent's net commission share surfaced, but RESA was substantially modernized and brokers may push back unless the regulator has issued bulletins clarifying the practice. Confirm with MFSA Real Estate Division before scaling.

**PPSA**: The Personal Property Security Act (CCSM c P35) via Manitoba Personal Property Registry, operated by Teranet Manitoba. **New PPR system launched November 28, 2025.** Online filing: <https://teranetmanitoba.ca/personal-property/>. Fee schedule not surfaced in research, historically $7-15 per year of term. Confirm at Teranet help centre.

**Consumer credit risk — the biggest single-province flag**: *Manitoba Consumer Protection Act* (CCSM c C200) **High-Cost Credit Products** provisions, in force since September 1, 2016. **High-cost credit grantor must be LICENSED.** Annual license fee **$5,500 per location + $500 annual financial literacy support levy**. Definition of "high-cost credit product" includes loans where the secured interest is registered under the PPSA. **This is a real risk for a true-sale-but-PPSA-registered structure if the regulator characterizes the advance as a loan in substance.** A bad recharacterization here triggers a $5,500/year license requirement plus potential 32% APR cap exposure. **Get a no-action or interpretation letter from the Manitoba Consumer Protection Office before opening MB to advances.**

**Tax**: GST 5% + RST 7% (Manitoba Retail Sales Tax). RST on the discount fee: Manitoba RST historically follows "taxable unless exempt" for enumerated services. Bulletin 030 lists exempt services. Financial services generally outside RST scope. Verify with Manitoba Finance before launch. Manitoba removed the vendor commission allowance on RST in the 2024-25 budget.

**Privacy**: No MB-specific substantially-similar private-sector privacy law. PIPEDA applies.

**Extra-provincial registration**: $350 government fee + $50 NUANS. Annual return required.

**Competition**: AccessEasyFunds, iCommission (Winnipeg listed), Rocket Advance (lists Manitoba), Agent's Equity. **Manitoba is the most contested smaller market in this batch.**

### 3.6 Nova Scotia (recommended next-best Atlantic entry)

**Regulator and statute**: Nova Scotia Real Estate Commission (NSREC). *Real Estate Trading Act* (RSNS 1989, c 384) + Commission By-laws (notably By-law 605 for trust funds). License classes: brokerage, broker, associate broker, salesperson, broker of record. Public search: <https://licensees.nsrec.ns.ca/search>.

**Money flow at closing**: Every brokerage's trust account is under the supervision of a designated broker. Trust funds held per Commission By-law. Unclaimed funds escheat to the Commission after 2+4 years. NSREC conducts annual audits + spot audits. No anti-assignment statute surfaced. Standard receivable-purchase model with IDP should function. Trust account audit posture is strict.

**PPSA**: *Personal Property Security Act* (SNS 1995-96, c 13) via Nova Scotia Personal Property Registry through Service Nova Scotia / Access Nova Scotia. Online at <https://www.novascotia.ca/programs-and-services/personal-property-registry>. Search $10 per criterion. Historically initial registration ~$22 + $5-9/year, current 2026 specifics not pulled.

**Consumer credit risk**: *Consumer Protection Act* + *Consumer Creditors' Conduct Act*, administered by Service Nova Scotia. Payday Lender Permit required for payday loans ($14/$100 cap, permit per location). We did NOT find a dedicated NS high-cost credit grantor license equivalent to Manitoba or NL. Confirm with Service Nova Scotia. Recharacterization risk low if true-sale clean.

**Tax**: HST 15% (NS 10% + federal 5%). **HST on commission advance discount fee: EXEMPT** as a financial service under ETA s.123(1) paragraphs (d) and (l) (transfer of ownership of a financial instrument). Cleaner tax treatment than SK and MB.

**Privacy**: No NS-specific substantially-similar private-sector privacy law. PIPEDA applies.

**Extra-provincial registration**: Registry of Joint Stock Companies. **$274.10, payable annually** (same fee on renewal). NS-resident recognized agent required. 1-2 weeks. Note: NB-incorporated entity is exempt from NS registration, but Ontario is NOT exempt.

**Competition**: Rocket Advance (Nova Scotia / Halifax listed), AccessEasyFunds, Agent's Equity. iCommission does NOT explicitly list NS on its city pages. We did NOT search for regional Atlantic-Canada-only players, branded Maritime services, or any AREA-equivalent association-owned product. Bud should not assume the field is just the names above.

### 3.7 New Brunswick

**Regulator and statute**: Co-regulated. **Financial and Consumer Services Commission (FCNB)** administers the *Real Estate Agents Act* (RSNB 2011, c 215). New Brunswick Real Estate Association (NBREA) administers the *New Brunswick Real Estate Association Act*. License classes: real estate agent (brokerage), salesperson. Public search via FCNB at <https://fcnb.ca/en/real-estate/real-estate-agents>.

**Money flow at closing**: REA grants FCNB authority to investigate complaints and order financial audits, particularly for trust funds. Trust account misconduct is actively enforced (Century 21 A&T Countryside Realty 2022 case). Specific NB trust account rules not pulled in this session, likely standard model. No anti-assignment statute surfaced.

**PPSA**: *Personal Property Security Act* (SNB 1993, c P-7.1) via NB Personal Property Registry through **ACOL (Atlantic Canada On-Line)**, shared platform with NS, NL, PE, YT, NT, NU. Online via ACOL client account. Historically ~$25 base + $5/year, 2026 specifics not pulled.

**Consumer credit risk — second-biggest flag in this batch**: *Cost of Credit Disclosure and Payday Loans Act* (SNB 2002, c C-28.3), administered by FCNB. **Credit grantors, credit brokers, and lessors who extend or arrange consumer credit must register with FCNB.** NB's registration requirement for "credit grantors" is broader than the typical "lender" definition. Even with true-sale receivable purchase structure, FCNB may take the position that buying a receivable from an agent constitutes "extending credit" in substance, especially given the FINTRAC factoring inclusion (April 2025). **Get a written FCNB no-action / interpretation letter before opening NB.** Also: NB has a proposed Consumer Protection Act (Bill 64, introduced 2023) that could expand FCNB jurisdiction. Track its status.

**Tax**: HST 15%. Discount fee = exempt financial service.

**Privacy**: No NB-specific substantially-similar private-sector privacy law. PIPEDA applies.

**Extra-provincial registration**: Corporate Registry of New Brunswick (Service New Brunswick). **$200 registration + $13.80 name reservation + $12 Royal Gazette publication = ~$225 one-time.** Annual $12. **NB-resident Attorney for Service required.**

**Competition**: AccessEasyFunds, Agent's Equity. Rocket Advance NOT explicitly listed for NB (their visible province set is ON/BC/AB/MB/NS though they claim 10 provinces total). iCommission NOT explicitly listed. We did NOT search for regional NB-specific competitors.

### 3.8 Newfoundland & Labrador (skip until later)

**Regulator and statute**: Digital Government and Service NL (DGSNL). *Real Estate Trading Act, 2019* (SNL 2019, c R-2.1), modernized statute in force September 1, 2020. Regulations NLR 66/20. Public lookup via DGSNL at <https://www.gov.nl.ca/gs/real-estate/>.

**Money flow at closing**: 2019 modernization included streamlined trust deposit release plus aged-deposit mechanism plus facilitation of electronic trust deposits. Broker can hold money in trust with express authorization from the entitled person — useful for IDP scenarios.

**PPSA**: *Personal Property Security Act* (SNL 1998, c P-7.1) via NL Personal Property Registry through ACOL. Operates Mon-Sat 8:00am-8:30pm.

**Consumer credit risk — major flag**: **High-Cost Credit Business License** in force as of **June 1, 2024**. Definition: any loan with interest rate at or above **Bank of Canada rate + 22%** is high-cost credit. **License application fee $1,000, branch fee $1,000.** Same recharacterization risk as MB / NB. If the discount-fee implied APR exceeds BoC+22% (which at ~29% it almost certainly does), the regulator could pull commission advances into this regime if they characterize as credit. Mitigant: true-sale purchase should be outside "loan" scope. Get a written DGSNL interpretation before opening NL.

**Tax**: HST 15%. Discount fee = exempt financial service.

**Privacy**: No NL-specific substantially-similar private-sector privacy law. PIPEDA applies.

**Extra-provincial registration**: Registry of Companies (DGSNL). **NL extra-provincial registration CANNOT be filed online, paper filing only.** **$560 with share capital** ($260 without). Highest one-time fee in this batch.

**Competition**: AccessEasyFunds nominally covers (national except QC). Major Canadian advance companies do not list NL on city pages. Small market in practice. We did NOT search for NL-specific players.

### 3.9 Prince Edward Island (bundle, do not target individually)

**Regulator and statute**: **Registrar of Real Estate** (Government of PEI, Justice and Public Safety / Consumer Affairs). NOT an independent "Real Estate Industry Council" (the PEI Real Estate Association (PEIREA) is a non-profit member association, not the licensing regulator). *Real Estate Trading Act* (RSPEI 1988, c R-2) + Regulations (EC516/68). License is 2-year term, pre-licensing course via PEIREA.

**Money flow at closing**: Standard provincial trust account model. Specifics not pulled in this research session.

**PPSA**: *Personal Property Security Act* (RSPEI 1988, c P-3.1) via PEI Personal Property Registry through ACOL. Lien Check Service available without ACOL account for serial-number searches.

**Consumer credit risk**: No dedicated PEI high-cost credit licensing regime surfaced. Standard payday loan rules likely apply. Confirm before launch.

**Tax**: HST 15%. Discount fee exempt.

**Privacy**: No PE-specific substantially-similar private-sector privacy law. PIPEDA applies.

**Extra-provincial registration**: Under Part 21 of the Business Corporations Act. **~$265-275 one-time + ~$70 NUANS. Annual government fee $12, annual return filing $30.** Must register within 30 days of starting business in PEI.

**Competition**: AccessEasyFunds nominally covers. No major player explicitly lists PE. Smallest provincial real estate market in Canada.

### 3.10, 3.11, 3.12 Yukon, Northwest Territories, Nunavut (skip indefinitely)

These three are bundled because the conclusion is the same: not worth standalone entry. National players reach in opportunistically if at all, the entire market is too small to justify dedicated structure, and Nunavut has a residency requirement that would force a partner brokerage relationship.

**Yukon (YT)**: Department of Community Services PLRA, *Real Estate Agents Act* (RSY 2002, c 188). Public registry at <https://yukon.ca/en/check-if-real-estate-agency-professional-licensed>. PPSA via ACOL. GST 5% only. Extra-prov $300 + $40 name. Whitehorse is essentially the only meaningful market.

**Northwest Territories (NT)**: Municipal and Community Affairs (MACA) Consumer Affairs and Licensing. *Real Estate Agents' Licensing Act* (RSNWT 1988, c 48 (Supp)). MACA is doing a full legislative review in 2024-2026 — regime may change materially. PPSA via ACOL. GST 5% only. Extra-prov $262 + $30 name. Yellowknife only.

**Nunavut (NU)**: Community and Government Services Consumer Affairs. *Real Estate Agents' Licensing Act* (RSNWT (Nu) 1988, c 48 (Supp)). **Eligibility requires maintaining a business office in Nunavut, being a NU resident, or being a NU-registered corporation/partnership.** This is a hard structural blocker — we would need a NU-based brokerage relationship or physical office. PPSA via ACOL. GST 5% only. Extra-prov $300.

---

## 4. Consolidated Comparison Table

| Province | Regulator | Top blocker | License risk | Tax surface | Extra-prov reg | Estimated complexity |
|---|---|---|---|---|---|---|
| BC | BCFSA | IDP enforceability under RESA Rules s.31 is permissive not mandatory, plus PST expansion Oct 2026 | Low (high-cost credit is consumer-only, verified) | GST 5% + PST 7% | $350, 10 business days | Medium |
| AB | RECA | Rules s.50(c) ambiguity on direct payment to non-brokerage assignees | Medium (HCC regulation text not verbatim-confirmed as commercial-exempt) | GST 5% only | ~$450 + agent fees, 1-3 days | Medium |
| QC | OACIQ + AMF + Revenu Québec | Notary money flow + Bill 96 + Law 25 + civil law structural overhaul | Low for MSB (factoring not in scope) | GST 5% + QST 9.975% | ~C$400-500, 2-4 weeks | **High** |
| SK | SREC | PST treatment of discount fee needs Ministry of Finance ruling | Low (no surfaced HCC regime) | GST 5% + PST 6% | ~$265, same-week | Medium |
| MB | MSC Real Estate (MFSA) | High-cost credit license $5,500/loc/yr if recharacterized | **HIGH** (HCC includes PPSA-secured products) | GST 5% + RST 7% | $350 + $50 NUANS | **High** |
| NS | NSREC | NS-resident recognized agent required, strict trust audit posture | Low (no surfaced HCC regime) | HST 15% (exempt) | $274.10 annually | Medium |
| NB | FCNB | FCNB credit grantor registration may capture commission advances | **HIGH** (CCDPLA registration scope is broad) | HST 15% (exempt) | ~$225 + $12/yr | **High** |
| NL | DGSNL | High-cost credit business license (BoC + 22%) + paper-only registration | **HIGH** (HCC + $1,000 fee) | HST 15% (exempt) | $560 paper filing | High |
| PE | Registrar of Real Estate | Tiny market, not worth standalone | Low (no surfaced HCC regime) | HST 15% (exempt) | ~$265-275 + annual fees | Low-Medium |
| YT | Community Services PLRA | Tiny market (~700-1000 sales/yr) | Low (no surfaced HCC regime) | GST 5% only | $300 + $40 name | Low |
| NT | MACA Consumer Affairs | Tiny market, legislative review pending | Low (no surfaced HCC regime) | GST 5% only | $262 + $30 name | Low |
| NU | CGS Consumer Affairs | NU residency / NU office required | Low (no surfaced HCC regime) | GST 5% only | $300 | Low (blocked) |

---

## 5. What Our Documents Need

This section identifies the specific Ontario-isms in our contract suite and what each province requires.

### 5.1 Commission Purchase Agreement

The CPA is the master document. It will need provincial variants, not a single multi-province version, because the legal devices differ.

| Change | Affected provinces |
|---|---|
| Replace "RECO registrant search" verification language with the provincial regulator's public registry (BCFSA, RECA, SREC, MFSA, NSREC, FCNB, DGSNL, etc.) | All |
| Replace "REBBA / TRESA" references with the provincial statute name | All |
| Replace "firm date" with provincial terminology (BC: "subject removal," AB: "condition removal / Notice of Fulfillment," QC: notarial signing date) | All |
| Add BCFSA-specific licensee class verification (managing broker for whom the agent works) | BC |
| Address AB Rules s.50(c) on direct vs. indirect commission payment | AB |
| Rewrite from scratch as "Acte de cession de créance" in French-primary, structured under CCQ arts. 1637-1646, with explicit agency acquiescence | QC |
| Scrub for any repurchase, put-back, top-up, or shortfall indemnity clause that risks recharacterization under Telus/Metropolitan principles | All |
| Add explicit "true sale" intention language and "no recourse" representations | All |
| Governing law decision: keep Ontario law and add provincial-licensee representations, or switch to provincial law for that province's deals | All |

### 5.2 Irrevocable Direction to Pay

| Change | Affected provinces |
|---|---|
| Rely on RESA s.31 commission trust account, cite BCFSA permissive-payment guidance, allow notary OR lawyer as the disbursing party | BC |
| Cite RECA "Commissions Payment From Trust" bulletin pathway, frame brokerage as acting on licensee's irrevocable written instruction | AB |
| New device: either insert as "stipulation pour autrui" in promesse d'achat, or as a written acquiescence-and-undertaking from the agency under art. 1641 CCQ. Both require active agency cooperation BEFORE the offer is firm. | QC |
| Cite NSREC By-law 605 trust fund rules | NS |
| Cite FCNB authority under REA and Cost of Credit Disclosure Act framework | NB |
| Cite Section 6 of the SREC by-laws on trust disbursement | SK |
| Cite MFSA RESA trust account rules | MB |

### 5.3 Brokerage Cooperation Agreement

| Change | Affected provinces |
|---|---|
| Replace ON regulator references with provincial regulator. Reference Completion Date (BC), or condition-removal-date (AB), or notarial closing (QC) instead of Closing Date. Allow notary as disbursing party where applicable. | All |
| **In Quebec, rewrite as "Convention de coopération avec l'agence," French-primary, including art. 1641 acquiescence language** | QC |
| Document the brokerage trust account jurisdiction (e.g. NB-branch financial institution for NB, MB-branch for MB) | NB, MB |

### 5.4 Privacy Policy

| Change | Affected provinces |
|---|---|
| BC PIPA appendix, designated BC-facing privacy officer with public contact | BC |
| AB PIPA appendix, mandatory breach-reporting SOP referencing PIPA s.34.1 and the April 2024 form | AB |
| **Full Quebec Law 25 compliance**: French-primary, named "person in charge of the protection of personal information," PIA template, cross-border transfer impact assessments, mandatory breach reporting to CAI, right to erasure / portability, automated-decision-making transparency | QC |
| No changes needed (PIPEDA backstop) | SK, MB, NS, NB, NL, PE, YT, NT, NU |

### 5.5 PPSA / RDPRM Registration Templates

| Province | Registry | Filing fee structure |
|---|---|---|
| ON | ServiceOntario | Existing, no change |
| BC | BC Personal Property Registry | $5/year up to 25 years, $500 infinity |
| AB | Alberta Personal Property Registry (via registry agent) | $22 first year + $2/year up to 25, $400 infinity |
| QC | RDPRM | Per-deal art. 1641 notice usually sufficient; universality publication for master agreements |
| SK | SPPR (ISC) | $12/year, fee increase April 15, 2026 |
| MB | MB PPR (Teranet) | New system Nov 28, 2025; historical $7-15/year |
| NS, NB, NL, PE, YT, NT, NU | ACOL shared platform | Single client account works for 7 of 9; per-year fees |

For all provinces other than QC: confirm with structured-finance counsel which registry is correct (debtor location vs. asset location, especially after the June 1, 2024 BC and AB intangibles amendments).

### 5.6 KYC / Compliance Documents (federal FINTRAC factor obligations)

These are not province-specific but they ARE the most urgent baseline:
- Designated compliance officer
- Written compliance policies and procedures
- Documented risk assessment
- Training program
- Biennial effectiveness review
- KYC verification of every party to a factoring agreement (the agent), beneficial ownership for any PREC counterparty
- Receipt-of-funds record on every brokerage closing payment ≥ $3,000
- 5-year retention from last transaction
- FINTRAC reporting integration (STR, LCTR, LVCTR, TPR, sanctions evasion)

---

## 6. What Our Code / System Needs

These are the Ontario-isms we identified in a quick code scan. None of these blocks expansion immediately but each becomes a real issue at provincial launch.

| File / area | Ontario assumption | What needs to happen |
|---|---|---|
| `lib/constants.ts` `RECO_PUBLIC_REGISTER_URL` | Hardcoded to RECO Ontario | Provincial regulator URL lookup keyed off brokerage province |
| `lib/constants.ts` `KYC_DOCUMENT_TYPES` | Includes "Ontario Driver's Licence" and "Ontario Photo Card" by default | Provincial driver's licence types per province (BC Services Card, AB Driver's Licence + photo ID card, QC Driver's Licence, etc.); Canadian Passport and PR Card stay universal |
| `lib/constants.ts` `calcDaysUntilClosing` | Uses `America/Toronto` timezone | Brokerage or deal-level timezone selection (America/Vancouver, America/Edmonton, America/Halifax, etc.) for date math at closing |
| `brokerages.reco_registration_number` field | Ontario-specific regulator number | Generic `regulator_registration_number` + `regulator_jurisdiction` columns, or a per-province lookup table |
| `brokerages.province` field | Already exists, used in admin UI | Drive license verification URL, contract template selection, privacy policy variant, and PPSA registry from this field |
| Contract generation (`lib/contract-docx.ts`) | Hardcoded "FIRM FUNDS INC.," Ontario governing law assumed | Template per province with regulator name, statute name, terminology, French-language variant for QC |
| Agent KYC flow (`components/AgentKycGate.tsx`, `lib/actions/kyc-actions.ts`) | Verifies against RECO registry | Provincial regulator lookup, multi-language support for QC |
| Brokerage settings UI (`app/(dashboard)/brokerage/settings/page.tsx`) | RECO field labels | Localize labels per province |
| Deal form (`app/(dashboard)/brokerage/deals/new/page.tsx`) | Ontario-default closing-date logic | Province-aware closing-date and disbursement-date logic, especially for QC notary 48-hour rule |
| Email templates (`lib/email.ts`) | English only | French-primary versions for QC |
| Privacy policy page | Ontario-only / PIPEDA-only | Multi-jurisdiction with QC Law 25 / BC PIPA / AB PIPA sections |
| Audit log | Ontario regulator references | Generic |
| Sample logos, demo content | Ontario brand assumptions | Multi-province brand assets if doing white-label per province |

**None of these are immediate code edits**, since you asked for research only. They are a punch list for whenever we actually open the second province.

---

## 7. Competitive Landscape Summary

We found 15 named competitors. The full inventory is in the per-province sections. Three patterns:

**Pattern 1: AccessEasyFunds is the brand leader nationally except Quebec.** $0.75/$1,000/day, "$9B+ advanced," partners with most major franchise networks. Toronto HQ. We do not know the exact reason they exclude Quebec but the structural barriers identified in section 3.3 are sufficient explanation.

**Pattern 2: Alberta has a structural moat.** AREA Advance is owned by AREA Real Estate Services Corp, a subsidiary of the Alberta Real Estate Association. $0.66/$1,000/day, 12,100 participating agents. This is essentially the in-house default product for every Alberta REALTOR®. We did NOT confirm whether OREA, BCREA, CREA, or any Atlantic real estate association has built an equivalent product. **Worth a follow-up sweep.**

**Pattern 3: White-label is happening, but locked to specific software ecosystems.**
- **myAbode** has built **myCommission** as a white-label product inside its brokerage software ecosystem (Ontario primarily).
- **Loft47** has an integration with **Liquify / Liquid Commission Funding** (powered by Upfront), "soon launching across Canada" as of January 2025.
- Both are closed ecosystems: a brokerage running Loft47 will use Liquify, a brokerage running myAbode will use myCommission. **Our white-label pitch competes against these incumbents whenever a target brokerage already has one of these software vendors.**

**Pattern 4: Real Brokerage explicitly works with third-party advance providers and blocks structures where the brokerage carries the debt** (the AREA variant). Our agent-as-debtor model fits Real Brokerage; the AREA-style model does not.

**Provinces with the thinnest visible competition: Atlantic (NB, NS, PE, NL).** We did NOT confirm "thin" — we confirmed that we did not find a regional Atlantic-only specialist after searching for AccessEasyFunds, Agent's Equity, Rocket Advance, iCommission, Capital Growth, AREA Advance, Realserve, FRAME, Commission Capital, MR Commission Advance, myCommission, Assadi, Liquify, eCommission, Beyond Funding, Wing Commission Advance, Realtor Capital, Trusted Commission, Brokers Funding, FundThrough, and Flexicom. There may be regional players we did not surface.

---

## 8. Recommended Sequencing

**Year 1 (now through end of 2026):**
- Complete FINTRAC factor compliance program (overdue, mandatory since April 1, 2025).
- Get an outside compliance review (Outlier Canada is one of the named PCMLTFA consulting shops).
- Get a tax and finance lawyer opinion documenting true-sale analysis and the s.347 35% APR fallback.
- Stand up Quebec Law 25 PIA framework BEFORE serving Quebec, because the moment a Quebec resident's data lands in our Ontario stack, we are exposed. This is independent of whether we have opened Quebec as a market.
- Decide CBCA conversion vs. stay-OBCA.
- Continue Ontario operations, sharpen unit economics.

**Year 1.5 (late 2026): British Columbia entry.**
- BC extra-provincial registration ($350, 10 business days).
- Written legal opinion on IDP enforceability under RESA Rules s.31.
- Written guidance from BC Ministry of Finance on PST Notice 2026-001 scope vs. our discount fee.
- BC PIPA privacy officer designation + appendix.
- BC PPSA registration template.
- Independent brokerage targeting (Macdonald Realty, Oakwyn, Stilhavn, Sutton-West Coast) before chasing franchise networks. iCommission is locked in with multiple Royal LePage BC brokerages.
- Position pricing against AccessEasyFunds at $0.75: we are at $0.80, so the differentiation is product, service, tech, and brokerage white-label revenue share, not price.

**Year 2 (2027): Alberta + Saskatchewan + Manitoba.**
- Alberta requires the Rules s.50(c) legal opinion BEFORE any AB deal.
- AREA Advance is the price-pressured incumbent ($0.66/$1,000/day). Differentiate on something other than rate.
- Saskatchewan and Manitoba bolted on because the regulatory regimes are similar to Ontario (PIPEDA, federal AML, simple trust mechanics).
- **Manitoba requires a written no-action / interpretation letter from the Manitoba Consumer Protection Office BEFORE opening, given the $5,500/year HCC license trap.**
- AB PIPA mandatory breach reporting SOP.

**Year 2.5 (mid-2027 to early 2028): Atlantic blanket (NS, NB, NL, PEI).**
- Single GTM motion across all four.
- NS is the cleanest. Open first within the Atlantic cluster.
- NB requires FCNB credit grantor interpretation letter BEFORE opening.
- NL has the BoC+22% high-cost credit license + paper-only $560 extra-prov registration. Defer within the Atlantic cluster.
- PEI piggybacks on whatever Atlantic operational rhythm we set up.

**Year 3 (2028): Quebec.**
- Engage a Quebec firm for a C$10K scoping opinion FIRST (Lavery, Miller Thomson, Stikeman, Fasken, McCarthy, BLG, Langlois).
- If green-lit, full structuring package C$30-60K including bilingual document drafting.
- Translation + French UI build, 6-9 month i18n project.
- Quebec-region data hosting or formal Transfer Impact Assessment for the Ontario stack.
- 1-2 Quebec notaires on retainer.
- Pilot with 1-2 willing agencies (likely smaller independents in Montréal and Québec City).

**Skip:** Yukon, Northwest Territories, Nunavut.

---

## 9. Honest Coverage Gaps

What this report does NOT confirm, in plain English so you know the limits:

- **BC RESA section** authorizing irrevocable assignment to a third party: we found permissive language, not a clean statutory authorization. Counsel needed.
- **AB Rules s.50(c)** verbatim text: PDF returned 403 or unreadable in this session. Counsel needed.
- **AB High-Cost Credit Regulation 132/2018** verbatim text: CanLII returned 403. We could not directly confirm whether the regulation explicitly excludes commercial transactions the way BC's regulation does.
- **Quebec Civil Code art. 1801** verbatim text: official sources returned 403. We described it from secondary sources. Counsel must vet against the live article text.
- **RDPRM 2026 published fee schedule**: not pulled.
- **REQ extra-provincial immatriculation 2026 fee**: not pulled.
- **Whether commercial factoring is inside the Loi sur les ESM (Quebec MSB Act)**: the Act's enumeration does not list factoring, so probably outside. Counsel opinion still needed.
- **OACIQ's specific written position on assigning broker remuneration to a non-broker third party**: inferred from the third-party-payment rule. No direct OACIQ bulletin pulled.
- **Whether SK / MB sales tax actually treats our discount fee as exempt**: extrapolated from federal ETA financial-service logic. Need written ministry rulings.
- **Atlantic-specific competitor sweep**: we searched by national-player names and by generic terms; we did NOT search by every plausible regional name or by brokerage intranet vendor pages.
- **Whether OREA, BCREA, CREA, or any Atlantic real estate association has built an AREA-Advance-equivalent in-house product**: not searched. Worth a follow-up.
- **Westlaw/Lexis/CanLII case law search for 2020-2025 factoring or commission-advance recharacterization decisions**: not conducted in this session. The Miller Thomson roundup we relied on stops at 2015.
- **Trust account anti-assignment provisions** in the verbatim regulations of each province's real estate act: we relied on the general permissive framework. A real estate / structured finance lawyer in each target province must pull the actual regulations and confirm IDP enforceability before launch.
- **Whether the AccessEasyFunds Quebec exclusion is for legal, operational, or strategic reasons.** Unconfirmed.
- **Embedded brokerage-internal advance programs** (e.g. Via Capitale, Royal LePage Québec, Royal LePage Atlantic) and Caisse Desjardins or Quebec credit union products: not searched.
- **NU/NT/YT regional one-off arrangements**: not searched. Absence of national marketing presence does not prove absence of any local arrangement.

---

## 10. Sources

The complete URL list is too long to inline here without padding the report. Key categories:

**Federal AML / FINTRAC**: BLG, Stikeman, Osler, Norton Rose Fulbright, McCarthy Tétrault, FINTRAC factor guidance and record-keeping pages, Canada Gazette Part I (Nov 2024) and Part II SOR/2025-68 (March 2025), Substance Law.

**Section 347**: Dentons, McMillan, Cassels, Stewart McKelvey, Nanda Law, FINTRAC.app.

**True sale case law**: Miller Thomson roundup. *Metropolitan Toronto Police Widows and Orphans Fund v. Telus Communications Inc.* (ONCA).

**Privacy**: Office of the Privacy Commissioner of Canada, BLG, McCarthy Tétrault, OneTrust, Secure Privacy, CFIB.

**Quebec**: Légis Québec (CCQ arts. 1637, 1641; Real Estate Brokerage Act C-73.2; Loi sur les ESM E-12.000001; N-3 r.5), OACIQ guidelines on trust accounts and notary remuneration, Synbad registry, RDPRM, Revenu Québec MSB pages, AMF, BLG, McCarthy Tétrault, Stikeman Elliott, Langlois, Miller Thomson, McMillan, Lavery, D.G. Chait, Educaloi, Immovision, Xpertsource, Chambre des notaires du Québec.

**BC**: BCFSA (RESA, RESA Rules, Trust Account Guidelines, Find Professional registry), BC Laws (RESA, BC PIPA, High-Cost Credit Regulation 290/2021), BC PPR fee schedule, Torys, Crowe Soberman, Gowling.

**AB**: RECA (legislation, ProCheck, Public Search, 2025-2028 Strategy), Alberta.ca (high-cost credit, PPR, extra-provincial registration), Fasken, OIPC AB, Gowling, Lexology.

**SK**: SREC, ISC PPR, CanLII Real Estate Act, FCAA Saskatchewan.

**MB**: CanLII RESA, MFSA Public Search, Teranet Manitoba PPR (incl. Nov 28, 2025 update), Manitoba Companies Office, Manitoba High-Cost Credit FAQ.

**NS**: NSREC, Real Estate Trading Act + regs, NS Personal Property Registry, NS Payday Lender Permit page, novascotia.ca extra-provincial registration.

**NB**: FCNB real estate page, GNB Real Estate Agents Act, SNB PPR, CanLII Cost of Credit Disclosure and Payday Loans Act, SNB Corporate Registry Fees, Torys (Bill 64 CPA NB).

**NL**: CanLII Real Estate Trading Act 2019, DGSNL pages, NL Schedule of Corporate Fees, ACOL NL PPR.

**PE**: princeedwardisland.ca real estate licensing, PEIREA, CanLII Real Estate Trading Act PEI, PEI Business Corporations Act, ACOL PEI PPR.

**Territories**: yukon.ca licensing, Yukon REA Act, MACA real estate licensing, Nunavut Legal Registries BCA extra-territorial, ACOL YT/NT/NU PPR.

**Competitors**: company websites confirmed for AccessEasyFunds, iCommission, Capital Growth Financial, Area Advance, Agent's Equity, Realserve, Rocket Advance, Flexicom, CommExpress, Commission Capital, MR Commission Advance, myCommission/myAbode, Assadi Private Capital, Liquify, eCommission. Plus Pretsquebec.ca.

---

**End of report.**
