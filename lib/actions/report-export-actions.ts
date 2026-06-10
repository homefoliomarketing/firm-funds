'use server'

// Server action exposing the report scope picker lists to the client.
// Read-only and internal-staff gated (any tier may view per project policy).

import { getAuthenticatedAdmin } from '@/lib/auth-helpers'
import { listReportTargets } from '@/lib/reports/build'
import type { ReportTargets } from '@/lib/reports/types'

type GetReportTargetsResult =
  | ({ success: true } & ReportTargets)
  | { success: false; error: string }

export async function getReportTargets(): Promise<GetReportTargetsResult> {
  const { error } = await getAuthenticatedAdmin()
  if (error) return { success: false, error }
  const targets = await listReportTargets()
  return { success: true, ...targets }
}
