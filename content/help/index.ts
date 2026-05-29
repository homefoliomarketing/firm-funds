/**
 * Help Center content registry.
 *
 * Every article and FAQ in `content/help/articles/**` and
 * `content/help/faqs/*` is imported here, then re-exported as a flat list
 * plus a lookup helper. The Help layout and the search palette consume
 * these.
 *
 * Adding a new article:
 *   1. Create the .tsx module under `articles/<role>/<slug>.tsx`.
 *   2. Default-export a `HelpArticle` with `meta` and `Body`.
 *   3. Import it below and add it to ALL_ARTICLES.
 *
 * Adding a new FAQ:
 *   1. Add the entry to the matching role file in `faqs/`.
 *   2. Those files export arrays which are concatenated here.
 *
 * The search index is computed once at module load.
 */

import type {
  HelpArticle,
  HelpFaq,
  HelpRole,
  HelpSearchEntry,
} from './types'

// --- Agent articles ---
import firstTimeSigningIn from './articles/agent/first-time-signing-in'
import submitADeal from './articles/agent/submit-a-deal'
import uploadKycDocuments from './articles/agent/upload-kyc-documents'
import readingYourDashboard from './articles/agent/reading-your-dashboard'
import accountBalanceAndLedger from './articles/agent/account-balance-and-ledger'
import updateBankingInfo from './articles/agent/update-banking-info'
import whatHappensIfDealFallsThrough from './articles/agent/what-happens-if-deal-falls-through'
import payRemediationIdp from './articles/agent/pay-remediation-idp'

// --- Brokerage articles ---
import brokerageDashboardTour from './articles/brokerage/brokerage-dashboard-tour'
import submitOnBehalfOfAgent from './articles/brokerage/submit-on-behalf-of-agent'
import acceptOrDeclineFirmOffer from './articles/brokerage/accept-or-decline-firm-offer'
import settleAFundedDeal from './articles/brokerage/settle-a-funded-deal'
import recordAPayment from './articles/brokerage/record-a-payment'
import lateStrikesAndTheFourteenDayBump from './articles/brokerage/late-strikes-and-the-14-day-bump'
import payRemediationRemittance from './articles/brokerage/pay-remediation-remittance'
import manageTeamAdmins from './articles/brokerage/manage-team-admins'

// --- Shared (money + policy) articles ---
import howTheAdvanceIsCalculated from './articles/shared/how-the-advance-is-calculated'
import lateInterestRules from './articles/shared/late-interest-rules'
import settlementWindow from './articles/shared/settlement-window'
import whatARemediationIdpIs from './articles/shared/what-a-remediation-idp-is'
import securityAndData from './articles/shared/security-and-data'
import contactingFirmFunds from './articles/shared/contacting-firm-funds'

// --- FAQs ---
import { agentFaqs } from './faqs/agent'
import { brokerageFaqs } from './faqs/brokerage'
import { sharedFaqs } from './faqs/shared'

export const ALL_ARTICLES: HelpArticle[] = [
  // Agent
  firstTimeSigningIn,
  submitADeal,
  uploadKycDocuments,
  readingYourDashboard,
  accountBalanceAndLedger,
  updateBankingInfo,
  whatHappensIfDealFallsThrough,
  payRemediationIdp,
  // Brokerage
  brokerageDashboardTour,
  submitOnBehalfOfAgent,
  acceptOrDeclineFirmOffer,
  settleAFundedDeal,
  recordAPayment,
  lateStrikesAndTheFourteenDayBump,
  payRemediationRemittance,
  manageTeamAdmins,
  // Shared
  howTheAdvanceIsCalculated,
  lateInterestRules,
  settlementWindow,
  whatARemediationIdpIs,
  securityAndData,
  contactingFirmFunds,
]

export const ALL_FAQS: HelpFaq[] = [
  ...sharedFaqs,
  ...agentFaqs,
  ...brokerageFaqs,
]

/** Fetch a single article by role + slug. Returns `undefined` if not found. */
export function getArticle(role: HelpRole, slug: string): HelpArticle | undefined {
  return ALL_ARTICLES.find(a => a.meta.role === role && a.meta.slug === slug)
}

/** Filter articles by role. `'all'` returns everything. Shared articles surface in every role. */
export function getArticlesByRole(role: HelpRole | 'all'): HelpArticle[] {
  if (role === 'all') return ALL_ARTICLES
  return ALL_ARTICLES.filter(a => a.meta.role === role || a.meta.role === 'shared')
}

/** Filter FAQs by role. Shared FAQs surface in every role's view. */
export function getFaqsByRole(role: HelpRole | 'all'): HelpFaq[] {
  if (role === 'all') return ALL_FAQS
  return ALL_FAQS.filter(f => f.role === role || f.role === 'shared')
}

/** All valid (role, slug) pairs. Used for `generateStaticParams`. */
export function getAllArticleParams(): Array<{ role: HelpRole; slug: string }> {
  return ALL_ARTICLES.map(a => ({ role: a.meta.role, slug: a.meta.slug }))
}

/**
 * Pre-built search index. Articles use href `<role>/<slug>`; FAQs use
 * `faq#<id>` so clicking the result scrolls to the question on the FAQ
 * page.
 */
export const SEARCH_INDEX: HelpSearchEntry[] = [
  ...ALL_ARTICLES.map<HelpSearchEntry>(a => ({
    type: 'article',
    href: `${a.meta.role}/${a.meta.slug}`,
    role: a.meta.role,
    category: a.meta.category,
    title: a.meta.title,
    summary: a.meta.summary,
    haystack: [
      a.meta.title,
      a.meta.summary,
      a.meta.role,
      a.meta.category,
    ].join(' ').toLowerCase(),
  })),
  ...ALL_FAQS.map<HelpSearchEntry>(f => ({
    type: 'faq',
    href: `faq#${f.id}`,
    role: f.role,
    category: f.category,
    title: f.question,
    summary: '',
    haystack: [
      f.question,
      f.role,
      f.category,
    ].join(' ').toLowerCase(),
  })),
]
