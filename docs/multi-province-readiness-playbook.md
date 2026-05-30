# Multi-Province Readiness Playbook

**Date:** 2026-05-29
**Purpose:** Be operationally ready to onboard a brokerage in any common-law Canadian province as soon as a relationship surfaces. Not a launch plan. A readiness reference.
**Companion document:** [multi-province-expansion-research.md](multi-province-expansion-research.md) for the deep research, sources, and competitive landscape behind every claim here.
**Posture on Quebec:** Skip as a target market. Keep Quebec-data privacy hygiene only. See section 3.
**Honesty posture:** Every delta is sourced via the underlying research. Items flagged "needs legal opinion" or "needs regulator letter" are real and should not be treated as belt-and-suspenders.

---

## 1. How to use this document

When a brokerage from outside Ontario surfaces, flip to that province's section. Each section is structured the same way and answers one question: **what is different from Ontario, and what do we need to have ready before we can sign their first deal?**

The cross-cutting setup work that applies to every province is in section 4. Use it as the master checklist, then layer the province-specific delta on top.

---

## 2. The Ontario baseline (the reference point)

Everything in section 5 is described as a delta from this baseline. Quick refresher:

| Topic | Ontario today |
|---|---|
| Regulator | RECO (Real Estate Council of Ontario) |
| Statute | TRESA (Trust in Real Estate Services Act, replaced REBBA) |
| Closing | Real estate lawyer disburses commission from buyer's lawyer trust to listing brokerage trust |
| Trust account rules | Brokerage trust under TRESA |
| Public license registry | registrantsearch.reco.on.ca |
| Security registration | Ontario PPSA via ServiceOntario |
| Unconditional deal term | "Firm date" |
| Closing day term | "Closing date" |
| Broker of record term | "Broker of Record" |
| Sales tax | HST 13% (discount fee = exempt financial service) |
| Privacy law | PIPEDA (federal) |
| Governing law clause | Ontario |
| Contract language | English |

---

## 3. Quebec verdict: skip as a market, keep the privacy hygiene

You are right to consider skipping Quebec. The relationship-by-relationship model does not work there because there is no way to be "ready in advance." Quebec requires fundamental upfront investment regardless of whether a deal ever surfaces:

- **Civil law, not common law.** The contract device shifts from "true sale of receivable" to "cession de créance" under Civil Code articles 1637 to 1646. Completely different document, drafted from scratch by Quebec counsel.
- **Notary, not lawyer.** Closings happen through a notary. The notary holds the buyer money in trust, disburses to the listing agency at signing. OACIQ rules forbid the notary from paying a non-broker third party. The Irrevocable Direction to Pay model does not translate cleanly.
- **Bill 96.** Every customer-facing contract, the agent UI, the brokerage UI, every email, every SMS, every marketing page must be French-first. Roughly a 6 to 9 month i18n project.
- **Law 25.** Quebec's privacy law (more demanding than PIPEDA) requires a Privacy Impact Assessment before any data crosses the Quebec border, a named privacy officer, mandatory breach reporting to the Commission d'accès à l'information, plus rights of erasure, portability, and automated-decision transparency.
- **MSB licence: not required** (factoring is not in the Loi sur les ESM scope). But the consumer-credit and OACIQ posture both need separate written legal opinions before any deal.
- **AccessEasyFunds (the largest Canadian commission advance company by volume) explicitly does not operate in Quebec.** That is consistent with our read of the structural friction.

Estimated total cost to be Quebec-ready: roughly **C$30K to C$60K legal**, plus 6 to 9 months of French translation and UI work, plus 2 to 4 months of privacy architecture, plus ongoing French support staff. None of that is recoverable without a clear Quebec growth thesis.

**Recommendation: explicit skip.** Communicate to any Quebec brokerage that contacts you that we currently service Ontario and English-Canada provinces only, and refer them out.

**But there is one Quebec rule you cannot skip even by skipping the market.** Law 25 attaches the moment a Quebec resident's personal information lands in our system. That can happen even without "opening" Quebec — for example, an Ontario brokerage with a Quebec-resident agent on its roster, or a co-op deal where the cooperating side is Quebec-based, or a Quebec-resident PREC director appearing in a brokerage admin role. The minimum hygiene:

1. Privacy policy explicitly states we do not service Quebec.
2. Block Quebec province as a selectable value in agent and brokerage onboarding forms.
3. If a Quebec resident's data does land in the system (someone forces it through, or a cross-province deal pulls in a Quebec party), log it, flag it, and have a documented process for either purging or putting it under Law 25 controls.
4. Designate someone internal as the privacy officer with publicly listed contact info. This satisfies Law 25's accountability rule even when we are not actively servicing Quebec.

That hygiene is cheap and protects against the worst case (a Quebec resident files a CAI complaint).

---

## 4. The federal and cross-province baseline (applies to every province)

These four items apply regardless of which non-Ontario brokerage shows up. **Do them once. Do them now.**

### 4.1 FINTRAC factor registration and compliance program (mandatory since April 1, 2025)

This is the most overdue item in this entire document. The federal AML regime added "factors" as reporting entities effective April 1, 2025. The regulatory definition explicitly includes "persons and entities offering 'advances' to their clients, which may be reimbursed by their clients under certain conditions if the accounts receivable are not collected." That is our business model verbatim.

Required baseline:
- FINTRAC registration in the factor category
- Designated compliance officer
- Written compliance policies and procedures
- Documented risk assessment
- Biennial effectiveness review
- Training program
- KYC of every party to a factoring agreement (the agent)
- Beneficial ownership identification for any corporate counterparty (PRECs)
- Suspicious Transaction Report capability (3 business days)
- Receipt-of-funds record on every brokerage closing payment of $3,000 or more (5-year retention)
- 5-year record retention on factoring agreements

This is not optional and it is overdue. Outlier Canada is one of the named PCMLTFA consulting shops if you want outside help.

### 4.2 True-sale and 35% interest cap legal opinion

A standalone tax and finance lawyer opinion documenting:
1. The Commission Purchase Agreement structure as a true sale of a receivable (not a loan), per the *Metropolitan Toronto Police Widows v. Telus* (ONCA) multi-factor test.
2. That if recharacterized, the discount fee at $0.80 per $1,000 per day is approximately 29.2% APR, comfortably under the Criminal Code section 347 cap of 35% APR (in force January 1, 2025).
3. That if the agent is incorporated as a PREC and the advance is for business purposes between $10K and $500K, the commercial loan exemption at 48% APR applies.

This opinion is protection if challenged and a useful credibility asset when pitching institutional brokerage partnerships. Get it once, reference it everywhere.

### 4.3 Provincial privacy posture

Stand up a single privacy framework that covers every province at once:
- Named privacy officer (the CEO works if undelegated; declare it publicly)
- Privacy policy with provincial appendices for BC PIPA and AB PIPA (each is recognized as substantially similar to PIPEDA but adds province-specific obligations)
- Mandatory breach reporting workflow that is broad enough to satisfy AB PIPA section 34.1 (real risk of significant harm, $100K corporate fine for failure to report)
- Quebec data hygiene per section 3 above

You only need to do this once. It travels with you to every province.

### 4.4 Corporate structure decision

If we expect to expand to 4 or more provinces (which the relationship-driven model implies), the one-time conversion from Ontario OBCA to federal CBCA is worth the ~$214 cost. CBCA gives nationwide name protection and removes one filing burden when registering extra-provincially. CBCA does NOT eliminate extra-provincial registration in each province; it just simplifies it.

If we stay OBCA, plan on standard extra-provincial registration in each new province as the relationship surfaces.

---

## 5. Provincial deltas (operational reference)

Each section answers the same questions:
- What is the regulator and statute?
- What is different from Ontario in how a deal closes?
- What changes in our contracts and code?
- What do we need to set up before we can sign the first deal?

### 5.1 British Columbia (BC)

| Topic | BC vs Ontario |
|---|---|
| Regulator | **BCFSA** (BC Financial Services Authority) replaces RECO. The Real Estate Council of BC rolled into BCFSA on August 1, 2021. |
| Statute | *Real Estate Services Act* (RESA) and *Real Estate Services Rules* (BC Reg 209/2021) instead of TRESA |
| Closing | Lawyer OR **notary public** (notaries are licensed to do real estate closings in BC, unlike Ontario). Our docs need to allow either as the disbursing party. |
| Trust account | Two trust accounts under RESA: brokerage trust (s.26) and commission trust (s.31). Monthly bank reconciliations within 5 weeks of month-end. |
| Public registry | <https://www.bcfsa.ca/public-resources/real-estate/find-professional> |
| Security registration | BC PPSA via BC Personal Property Registry. **Fee: $5 per year up to 25 years, or $500 infinity** (cheaper than Ontario). |
| Unconditional deal term | **"Subject removal"** instead of "firm date" |
| Closing day term | **"Completion Date"** instead of "Closing Date" |
| Broker of record term | **"Managing Broker"** instead of "Broker of Record" |
| Sales tax | GST 5% + PST 7%. Discount fee should be PST-exempt as a financial service. **Note: PST expansion (Notice 2026-001) takes effect October 1, 2026 and adds non-residential real estate services. The line is close enough to want a written Ministry of Finance ruling.** |
| Privacy law | **BC PIPA** on top of PIPEDA. Designate privacy officer with publicly available contact info. No commissioner registration. |
| Extra-prov registration | **$350 government fee, 10 business days standard or +$100 priority.** Federal corporation skips name approval. Registered office in BC required. |

**The one BC-specific blocker that needs a legal opinion before any deal:**
BCFSA guidance says brokerages "may" honour third-party payment with licensee consent. This is permissive language, not a mandatory statutory provision. We need a written BC counsel opinion confirming an Irrevocable Direction to Pay is enforceable under RESA Rules section 31.

**Contract changes for BC:**
- Substitute BCFSA Find Professional language for RECO registrant search references
- Replace REBBA / TRESA with Real Estate Services Act (SBC 2004, c.42) and Real Estate Services Rules (BC Reg 209/2021)
- Replace "firm date" with "subject removal"
- Replace "Closing Date" with "Completion Date"
- Replace "Broker of Record" with "Managing Broker"
- Allow notary OR lawyer as the disbursing party in the IDP
- Add BC PIPA appendix to privacy policy
- Confirm governing law clause: either Ontario law with BC service of process, or BC law for BC deals (counsel call)

**BC setup checklist (do these once, then we are BC-ready):**
- [ ] Extra-provincial registration ($350, 10 business days)
- [ ] BC counsel opinion on IDP enforceability under RESA s.31
- [ ] BC counsel scrub of CPA for any repurchase / put-back clause that risks recharacterization
- [ ] BC Ministry of Finance written guidance on PST Notice 2026-001 scope vs. discount fee
- [ ] BC PPR account, registered office address, BC corporate services provider
- [ ] BC variant of Commission Purchase Agreement, IDP, Brokerage Cooperation Agreement
- [ ] BC PIPA appendix to privacy policy
- [ ] Update `lib/constants.ts` to swap RECO URL when brokerage province is BC
- [ ] Update KYC document type list (BC Services Card, BC Driver's Licence)
- [ ] Brokerage onboarding flow: capture BCFSA managing broker information instead of RECO broker of record

### 5.2 Alberta (AB)

| Topic | AB vs Ontario |
|---|---|
| Regulator | **RECA** (Real Estate Council of Alberta) replaces RECO. Industry Council governance phasing in through 2025 to 2028. |
| Statute | *Real Estate Act* (RSA 2000, c R-5) and *Real Estate Act Rules*. Authority to approve new Rules transferred from Minister to Industry Councils on June 30, 2025. |
| Closing | Lawyer only (matches Ontario). No notary alternative. |
| Trust account | Brokerage trust required. Brokerages have the option to segregate commissions in an "other" account since 2019. |
| Public registry | RECA ProCheck at <https://procheck.reca.ca/> |
| Security registration | AB PPR (Personal Property Registry) accessed through registry agents. **Fee: $22 first year + $2 per additional year up to 25, or $400 infinity.** Plus registry agent service fees ($10 to $25). |
| Unconditional deal term | **"Condition removal"** or **"Notice of Fulfillment"** instead of "firm date" |
| Closing day term | "Closing Date" (same as ON) |
| Broker of record term | **"Broker"** (the broker of record equivalent) |
| Sales tax | **GST 5% only. No PST.** Cleanest tax landscape in the country. |
| Privacy law | **AB PIPA**. **Mandatory breach reporting under section 34.1 with $100,000 corporate fine.** Process updated April 1, 2024 with a new Privacy Breach Notification Form. Stricter than BC. |
| Extra-prov registration | **~$450 + registry agent service fees, 1 to 3 business days.** Federal corporation NUANS-exempt. Registered office in AB required. |

**The one AB-specific blocker that needs a legal opinion before any deal:**
**Section 50(c) of the Real Estate Act Rules** restricts who can be paid commission "directly or indirectly" to the brokerage's licensees, a corporation 50%+ owned by them, or another licensed brokerage. Read literally, that could block direct payment to us (a non-brokerage assignee) out of trust. RECA's April 2019 "Commissions Payment From Trust" bulletin describes third-party payment under written direction as allowable, but the verbatim Rules section needs an AB counsel opinion to confirm our IDP model works. There is a possible workaround (brokerage pays the licensee from trust, licensee remits to us via a separate banking instruction) but it changes our money flow. **This is the highest substantive question for AB.**

There is also a smaller AB-specific watchout: the AB *High Cost Credit Regulation 132/2018* defines a 32% APR threshold for licensing. The regulation lists consumer-flavoured products but does NOT explicitly say "consumer purpose only" the way BC's regulation does. Less defensible than BC. AB counsel should give a written opinion on whether commission advances to licensed agents are outside the regulation's scope.

**Contract changes for AB:**
- Substitute RECA ProCheck for RECO registrant search references
- Replace REBBA / TRESA with Real Estate Act (RSA 2000, c R-5) and Real Estate Act Rules
- Replace "firm date" with "condition removal" or "Notice of Fulfillment"
- Address s.50(c) directly: structure the IDP so brokerage is acting on the licensee's irrevocable written instruction via the bulletin pathway, rather than as a direct payment to a non-brokerage assignee
- Add AB PIPA appendix with mandatory-breach-reporting SOP

**AB setup checklist:**
- [ ] Extra-provincial registration (~$450 + agent fees, 1 to 3 days)
- [ ] AB counsel opinion on Rules s.50(c) and IDP enforceability
- [ ] AB counsel opinion on High Cost Credit Regulation scope (commercial exemption)
- [ ] AB PPR registry agent relationship
- [ ] AB variant of contract suite
- [ ] AB PIPA appendix and breach-reporting SOP with April 2024 form integration
- [ ] Update `lib/constants.ts` regulator URL for AB
- [ ] KYC document types for AB (AB Driver's Licence, AB Photo ID Card)

### 5.3 Saskatchewan (SK)

| Topic | SK vs Ontario |
|---|---|
| Regulator | **SREC** (Saskatchewan Real Estate Commission) replaces RECO |
| Statute | *The Real Estate Act* (SS 1995, c R-1.3) instead of TRESA |
| Closing | Lawyer-based (matches ON) |
| Trust account | Brokerage trust under the Real Estate Act |
| Public registry | <https://ols.srec.ca/aspx/pubinquiry> |
| Security registration | SPPR (Saskatchewan Personal Property Registry) operated by ISC. **Fee: $12 per year. Fee increase effective April 15, 2026.** |
| Unconditional deal term | Similar to ON, confirm with SK counsel |
| Closing day term | "Closing Date" (same) |
| Broker of record term | "Broker" |
| Sales tax | GST 5% + PST 6%. Discount fee should be PST-exempt as a financial service. **SK PST has been expanded in recent budgets — get a written Ministry of Finance ruling before opening.** |
| Privacy law | PIPEDA only. No SK-specific private-sector privacy law. |
| Extra-prov registration | **~$265 government fee + $20 to $60 name search.** Same-week through ISC online. Annual maintenance ~$45. SK-resident agent for service required. |

**No SK-specific blocker requiring a legal opinion before opening.** The model translates cleanly.

**Contract changes for SK:**
- Substitute SREC registry for RECO
- Replace REBBA / TRESA with Real Estate Act (SS 1995, c R-1.3)
- Confirm "firm date" equivalent with SK counsel (likely same usage)
- No privacy appendix needed (PIPEDA)

**SK setup checklist:**
- [ ] Extra-provincial registration (~$285)
- [ ] SK-resident agent for service
- [ ] SK Ministry of Finance written ruling on PST treatment of discount fee
- [ ] SPPR account with ISC
- [ ] SK variant of contract suite
- [ ] Update `lib/constants.ts` regulator URL for SK
- [ ] KYC document types for SK (SK Driver's Licence, SK Photo ID Card)

### 5.4 Manitoba (MB) — biggest single-province regulatory trap

| Topic | MB vs Ontario |
|---|---|
| Regulator | **Manitoba Securities Commission Real Estate Division** operating under the **Manitoba Financial Services Agency (MFSA)** brand |
| Statute | *The Real Estate Services Act* (RESA, CCSM c R21). **Replaced the Real Estate Brokers Act on January 1, 2022.** Most recent amendments in force June 3, 2025. |
| Closing | Lawyer-based |
| Trust account | **Must be at a Manitoba-branch financial institution.** Interest is payable to the Commission, not the agent or client. Commission can request bank-account info at any time. |
| Public registry | <https://themfsa.ca/enforcement/public-search/> |
| Security registration | MB PPR via Teranet Manitoba. **New PPR system launched November 28, 2025.** Historical fees ~$7 to $15 per year. |
| Sales tax | GST 5% + RST 7%. Discount fee likely outside RST scope as a financial service. Verify with Manitoba Finance. |
| Privacy law | PIPEDA only |
| Extra-prov registration | $350 + $50 NUANS. Annual return. |

**The MB-specific blocker that MUST be resolved before any MB deal:**

**Manitoba's Consumer Protection Act high-cost credit provisions require licensing for high-cost credit grantors at $5,500 per location per year plus a $500 annual financial literacy levy.** The definition of "high-cost credit product" includes loans where the secured interest is registered under the PPSA. If MFSA characterizes a commission advance as a loan in substance, even with our true-sale structure, we trigger this license requirement.

**Get a written no-action or interpretation letter from the Manitoba Consumer Protection Office BEFORE opening Manitoba to any deal.** This is the biggest single-province regulatory risk in the entire country.

**Contract changes for MB:**
- Substitute MFSA public search for RECO
- Replace TRESA with Real Estate Services Act (CCSM c R21)
- Document the brokerage trust account requirement for Manitoba-branch institution in the Brokerage Cooperation Agreement
- No privacy appendix (PIPEDA)

**MB setup checklist:**
- [ ] **Manitoba Consumer Protection Office interpretation letter (BEFORE any MB deal)**
- [ ] Extra-provincial registration ($400)
- [ ] Teranet MB PPR account on the new system
- [ ] MB variant of contract suite
- [ ] Update `lib/constants.ts` regulator URL for MB
- [ ] KYC document types for MB
- [ ] Verify brokerage cooperation form captures Manitoba-branch trust account information

### 5.5 Nova Scotia (NS)

| Topic | NS vs Ontario |
|---|---|
| Regulator | **NSREC** (Nova Scotia Real Estate Commission) replaces RECO |
| Statute | *Real Estate Trading Act* (RSNS 1989, c 384) + NSREC By-laws (notably By-law 605 for trust funds) |
| Closing | Lawyer-based |
| Trust account | Under the supervision of a designated broker. NSREC conducts annual audits + spot audits (strict posture). Unclaimed funds escheat to the Commission after 2+4 years. |
| Public registry | <https://licensees.nsrec.ns.ca/search> |
| Security registration | NS PPR via Service Nova Scotia. Historical ~$22 + $5-9/year. Search $10 per criterion. |
| Sales tax | **HST 15% (NS 10% + federal 5%). Discount fee EXEMPT as a financial service** under ETA s.123(1)(d) and (l). Cleaner tax than SK/MB. |
| Privacy law | PIPEDA only |
| Extra-prov registration | **$274.10 ANNUALLY (recurring same fee).** NS-resident recognized agent required. 1 to 2 weeks. |

**No NS-specific blocker requiring a legal opinion before opening.** Just stricter trust audit posture — be prepared for NSREC scrutiny of any brokerage we work with.

**Contract changes for NS:**
- Substitute NSREC for RECO references
- Replace TRESA with Real Estate Trading Act (RSNS 1989, c 384)
- Reference NSREC By-law 605 trust fund rules in the Brokerage Cooperation Agreement
- No privacy appendix (PIPEDA)

**NS setup checklist:**
- [ ] Extra-provincial registration ($274.10, recurring)
- [ ] NS-resident recognized agent
- [ ] NS PPR account
- [ ] NS variant of contract suite
- [ ] Update `lib/constants.ts` regulator URL for NS
- [ ] KYC document types for NS

### 5.6 New Brunswick (NB)

| Topic | NB vs Ontario |
|---|---|
| Regulator | **FCNB** (Financial and Consumer Services Commission of New Brunswick) administers the *Real Estate Agents Act* (RSNB 2011, c 215). Co-regulated with NBREA. |
| Statute | *Real Estate Agents Act* (RSNB 2011, c 215) instead of TRESA |
| Closing | Lawyer-based |
| Trust account | FCNB authority to investigate, audit trust funds. Active enforcement posture. |
| Public registry | Through FCNB at <https://fcnb.ca/en/real-estate/real-estate-agents> |
| Security registration | NB PPR via **ACOL (Atlantic Canada On-Line)**. Shared platform with NS, NL, PE, YT, NT, NU (one account works for 7 jurisdictions). Historical ~$25 base + $5/year. |
| Sales tax | **HST 15%. Discount fee EXEMPT** as a financial service. |
| Privacy law | PIPEDA only |
| Extra-prov registration | **~$225 one-time** ($200 + $13.80 name reservation + $12 Royal Gazette). **NB-resident Attorney for Service required.** Annual fee $12. |

**The NB-specific blocker that needs a regulator letter before opening:**

NB's *Cost of Credit Disclosure and Payday Loans Act* (SNB 2002, c C-28.3) requires **credit grantors, credit brokers, and lessors who extend or arrange consumer credit to register with FCNB**. NB's registration requirement is broader than typical "lender" definitions. Even with our true-sale structure, FCNB might take the position that buying a receivable from an agent constitutes "extending credit," especially given the FINTRAC factoring inclusion (April 2025). **Get a written FCNB no-action / interpretation letter before opening NB.**

There is also a pending **Consumer Protection Act (Bill 64, introduced 2023)** that could expand FCNB jurisdiction. Track its status.

**Contract changes for NB:**
- Substitute FCNB for RECO references
- Replace TRESA with Real Estate Agents Act (RSNB 2011, c 215)
- No privacy appendix (PIPEDA)

**NB setup checklist:**
- [ ] **FCNB no-action / interpretation letter (BEFORE any NB deal)**
- [ ] Extra-provincial registration (~$225)
- [ ] NB-resident Attorney for Service
- [ ] ACOL account (covers NB plus 6 other jurisdictions)
- [ ] NB variant of contract suite
- [ ] Update `lib/constants.ts` regulator URL for NB
- [ ] KYC document types for NB

### 5.7 Newfoundland and Labrador (NL)

| Topic | NL vs Ontario |
|---|---|
| Regulator | **DGSNL** (Digital Government and Service NL) replaces RECO |
| Statute | *Real Estate Trading Act, 2019* (SNL 2019, c R-2.1). Modernized statute in force September 1, 2020. |
| Closing | Lawyer-based |
| Trust account | Streamlined deposit release. Broker can hold money in trust with express authorization from the entitled person (useful for IDP scenarios). |
| Public registry | Through DGSNL at <https://www.gov.nl.ca/gs/real-estate/> |
| Security registration | NL PPR via ACOL (same shared account as NB) |
| Sales tax | HST 15%. Discount fee exempt. |
| Privacy law | PIPEDA only |
| Extra-prov registration | **$560 (with share capital), $260 (without). PAPER-ONLY filing — cannot be done online.** Highest one-time fee in the country. |

**The NL-specific blocker that needs a regulator letter before opening:**

NL's **High-Cost Credit Business License** has been in force since **June 1, 2024**. Definition: any loan with interest at or above **Bank of Canada rate + 22%** is high-cost credit. **License application fee $1,000, branch fee $1,000.** Same recharacterization risk as MB and NB. Our $0.80 per $1,000 per day discount-fee implied APR (~29%) sits above the BoC+22% threshold currently, so if DGSNL characterizes the advance as a loan we are pulled in. **Get a written DGSNL interpretation before opening NL.**

**Contract changes for NL:**
- Substitute DGSNL for RECO
- Replace TRESA with Real Estate Trading Act, 2019
- No privacy appendix (PIPEDA)

**NL setup checklist:**
- [ ] **DGSNL interpretation letter (BEFORE any NL deal)**
- [ ] Extra-provincial registration paper filing ($560)
- [ ] ACOL account (already covers NB/NL/NS/PE/YT/NT/NU)
- [ ] NL variant of contract suite
- [ ] Update `lib/constants.ts` regulator URL for NL
- [ ] KYC document types for NL

### 5.8 Prince Edward Island (PE)

| Topic | PE vs Ontario |
|---|---|
| Regulator | **Registrar of Real Estate** (Government of PEI, Justice and Public Safety / Consumer Affairs). PEI Real Estate Association (PEIREA) is a member body, NOT the licensing regulator. |
| Statute | *Real Estate Trading Act* (RSPEI 1988, c R-2) + Regulations (EC516/68) |
| Closing | Lawyer-based |
| Public registry | princeedwardisland.ca real estate licensing |
| Security registration | PE PPR via ACOL (same shared account) |
| Sales tax | HST 15%. Discount fee exempt. |
| Privacy law | PIPEDA only |
| Extra-prov registration | **~$265 to $275 one-time + ~$70 NUANS. Annual government fee $12, annual return $30.** **Must register within 30 days of starting business in PEI.** |

**No PE-specific blocker.** Smallest provincial real estate market in Canada but easy to be ready for.

**PE setup checklist:**
- [ ] Extra-provincial registration (~$340 including NUANS)
- [ ] PE variant of contract suite (likely a near-identical copy of NS variant)
- [ ] ACOL account (already covered)
- [ ] Update `lib/constants.ts` regulator URL for PE
- [ ] KYC document types for PE

### 5.9 Yukon (YT)

| Topic | YT vs Ontario |
|---|---|
| Regulator | Department of Community Services PLRA |
| Statute | *Real Estate Agents Act* (RSY 2002, c 188) |
| Closing | Lawyer-based |
| Public registry | <https://yukon.ca/en/check-if-real-estate-agency-professional-licensed> |
| Security registration | YT PPR via ACOL |
| Sales tax | **GST 5% only** |
| Privacy law | PIPEDA only |
| Extra-prov registration | **$300 + $40 name reservation** |

**No YT-specific blocker.** Whitehorse is essentially the only meaningful market.

**YT setup checklist:** Minimal. If a Yukon brokerage surfaces, follow the same NS/PE pattern with the YT-specific government fees and ACOL access.

### 5.10 Northwest Territories (NT)

| Topic | NT vs Ontario |
|---|---|
| Regulator | Municipal and Community Affairs (MACA) Consumer Affairs and Licensing |
| Statute | *Real Estate Agents' Licensing Act* (RSNWT 1988, c 48 (Supp)). **MACA is doing a full legislative review in 2024-2026, regime may change materially.** |
| Closing | Lawyer-based |
| Public registry | MACA real estate licensing page |
| Security registration | NT PPR via ACOL |
| Sales tax | GST 5% only |
| Privacy law | PIPEDA only |
| Extra-prov registration | **$262 + $30 name search** |

**Yellowknife is the only meaningful market.** Watch for the legislative review outcome.

### 5.11 Nunavut (NU)

| Topic | NU vs Ontario |
|---|---|
| Regulator | Community and Government Services Consumer Affairs |
| Statute | *Real Estate Agents' Licensing Act* (RSNWT (Nu) 1988, c 48 (Supp)) |
| Closing | Lawyer-based |
| Public registry | Government of Nunavut Consumer Affairs |
| Security registration | NU PPR via ACOL |
| Sales tax | GST 5% only |
| Privacy law | PIPEDA only |
| Extra-prov registration | **$300 (for-gain)** |

**Structural blocker:** Real estate licensee eligibility in Nunavut requires **maintaining a business office in Nunavut, being a NU resident, or being a NU-registered corporation/partnership**. We can't service Nunavut without a NU-based brokerage partner. If a Nunavut brokerage call comes in, it is workable, but it requires more than just an extra-provincial registration.

---

## 6. Code and system changes we need to make ourselves multi-province ready

These are not blockers per province but they are the system-level work that lets us flip a switch when a relationship surfaces. None of this needs to happen today, but doing it once is cheaper than doing it under deadline pressure when a BC brokerage wants to onboard next week.

| File / area | Current state | Multi-province version |
|---|---|---|
| `lib/constants.ts` — `RECO_PUBLIC_REGISTER_URL` | Hardcoded Ontario URL | Lookup by `brokerage.province` returning the right regulator's public search URL |
| `lib/constants.ts` — `KYC_DOCUMENT_TYPES` | Includes "Ontario Driver's Licence" and "Ontario Photo Card" as defaults | Per-province driver's licence options + universal Canadian Passport / PR Card / Citizenship Card |
| `lib/constants.ts` — `calcDaysUntilClosing` | Uses `America/Toronto` for date math | Timezone per province (America/Vancouver, America/Edmonton, America/Halifax, America/St_Johns) sourced from brokerage record |
| `brokerages.reco_registration_number` field | Ontario-specific name | Rename to `regulator_registration_number` (or add a sibling `regulator_jurisdiction` field that drives which regulator the number belongs to) |
| `brokerages.province` | Already exists, currently mostly cosmetic | Drive contract template selection, license verification URL, PPSA registry, privacy policy variant from this field |
| `lib/contract-docx.ts` | Single Ontario template | Per-province variants for CPA, IDP, and Brokerage Cooperation Agreement. Same structure, swap regulator name, statute name, closing terminology, governing law clause |
| `components/AgentKycGate.tsx`, `lib/actions/kyc-actions.ts` | Verifies against RECO | Provincial regulator lookup based on agent's province |
| `app/(dashboard)/brokerage/settings/page.tsx` | "RECO Registration Number" label | Localized label per province |
| `app/(dashboard)/brokerage/deals/new/page.tsx` | Ontario-default closing-date logic | Province-aware closing-date logic and disbursement-date logic |
| Privacy policy page | Single PIPEDA page | Base PIPEDA + BC PIPA appendix + AB PIPA appendix; Quebec section that says "we do not service Quebec" |
| Email templates | English only | Same English templates work for everywhere except Quebec; defer the French-language stack since Quebec is skipped |
| Onboarding province dropdown | Includes all 13 jurisdictions | Block Quebec selection at the UI; show "we do not service Quebec at this time" message |

The lift here is real but it is one project, not thirteen. The biggest piece is per-province contract template generation in `lib/contract-docx.ts`, since each province needs subtly different language. Everything else is constants + UI mapping.

---

## 7. Ready-state summary table

Quick-reference for "what is the gating item before we can take a deal in this province."

| Province | Can we take a deal today? | Gating item |
|---|---|---|
| ON | Yes (home base) | None |
| BC | Not yet | Extra-prov registration + BC counsel opinion on IDP enforceability + contract variant |
| AB | Not yet | Extra-prov registration + AB counsel opinion on Rules s.50(c) + contract variant |
| SK | Not yet | Extra-prov registration + SK PST ruling + contract variant |
| MB | Not yet — highest risk | **Manitoba Consumer Protection Office interpretation letter (mandatory before any deal)** + extra-prov registration + contract variant |
| NS | Not yet | Extra-prov registration ($274/yr) + NS-resident agent + contract variant |
| NB | Not yet | **FCNB interpretation letter (mandatory before any deal)** + extra-prov registration + NB-resident Attorney for Service + contract variant |
| NL | Not yet | **DGSNL interpretation letter (mandatory before any deal)** + paper-filing extra-prov registration ($560) + contract variant |
| PE | Not yet | Extra-prov registration + contract variant (low-effort, near-identical to NS) |
| YT | Not yet | Extra-prov registration + contract variant (low-effort) |
| NT | Not yet | Extra-prov registration + contract variant (watch legislative review) |
| NU | Special case | Need a NU-based brokerage relationship (structural eligibility), plus extra-prov registration |
| QC | Intentionally skipped | See section 3. Keep Law 25 hygiene only. |

---

## 8. What to actually build in what order

Given the relationship-driven model, the question is not "which province first" but "what is the smallest amount of generic prep work that makes us ready for any of them."

**Tier 1: federal prep (does not depend on any province)**
1. FINTRAC factor registration + compliance program (overdue)
2. True-sale + s.347 legal opinion
3. Privacy policy with BC PIPA / AB PIPA appendices and Quebec hygiene
4. Decide CBCA conversion (only if expanding to 4+ provinces, which we are)

**Tier 2: code prep that lets the system handle any non-QC province (one project, not thirteen)**
1. Constants refactor: regulator URL lookup by province, KYC document types by province, timezone by province
2. Rename `reco_registration_number` to `regulator_registration_number` (or add `regulator_jurisdiction` field)
3. Per-province contract template variants for CPA, IDP, Brokerage Cooperation Agreement
4. Privacy policy provincial appendix rendering
5. Block Quebec at the onboarding UI; soft-detect Quebec data and flag

**Tier 3: per-province paperwork when the relationship lands**
- Extra-provincial registration in the target province
- Regulator interpretation letter for MB, NB, NL (these three are mandatory pre-deal)
- Legal opinion for BC (IDP enforceability), AB (Rules s.50(c)), QC (skipped)
- PPSA registry account setup (ACOL covers 7 jurisdictions at once)
- Resident agent / attorney for service in NS and NB

Tiers 1 and 2 are one-time. Tier 3 is per-province but most of it is paperwork that takes days to weeks, not months.

The only provinces where the gating item is genuinely slow are MB, NB, and NL — because they require regulator interpretation letters, and regulators move at their own pace. If we expect any chance of a relationship in those three, get the interpretation letters started now even without a specific brokerage in sight. They can take 3 to 6 months.

---

## 9. Honest caveats

This playbook is built on the research in [multi-province-expansion-research.md](multi-province-expansion-research.md). The same caveats apply: we did not retrieve verbatim regulatory text for AB Rules s.50(c), AB High-Cost Credit Regulation 132/2018, or Quebec Civil Code art. 1801. Anything in this document about those specific provisions is sourced from secondary materials and should be vetted against the live text before any deal is signed in that province.

For the three regulator-letter provinces (MB, NB, NL), the recharacterization risk is real but it is not certain we would be captured by the high-cost-credit regimes. The interpretation letter is the cheapest way to remove the uncertainty. We have not asked counsel to predict the answer.

**End of document.**
