import { z } from 'zod'
import {
  MIN_GROSS_COMMISSION,
  MAX_GROSS_COMMISSION,
  MIN_DAYS_UNTIL_CLOSING,
  MAX_DAYS_UNTIL_CLOSING,
  VALID_DOCUMENT_TYPE_VALUES,
  VALID_UPLOAD_SOURCES,
  MAX_UPLOAD_SIZE_BYTES,
} from './constants'

/** Schema for deal submission */
export const DealSubmissionSchema = z.object({
  propertyAddress: z
    .string()
    .min(5, 'Property address must be at least 5 characters')
    .max(200, 'Property address must be under 200 characters')
    .trim(),
  closingDate: z
    .string()
    .refine((val) => {
      const date = new Date(val + 'T00:00:00')
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      return date > today
    }, 'Closing date must be in the future')
    .refine((val) => {
      const date = new Date(val + 'T00:00:00')
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const diffDays = Math.ceil((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
      return diffDays <= MAX_DAYS_UNTIL_CLOSING
    }, `Closing date must be within ${MAX_DAYS_UNTIL_CLOSING} days`),
  grossCommission: z
    .number()
    .min(MIN_GROSS_COMMISSION, `Gross commission must be at least $${MIN_GROSS_COMMISSION}`)
    .max(MAX_GROSS_COMMISSION, `Gross commission must be under $${MAX_GROSS_COMMISSION.toLocaleString()}`),
  brokerageSplitPct: z
    .number()
    .min(0, 'Brokerage split must be 0% or higher')
    .max(100, 'Brokerage split must be 100% or lower'),
  notes: z
    .string()
    .max(1000, 'Notes must be under 1000 characters')
    .optional()
    .nullable(),
})

/** Schema for deal status change */
export const DealStatusChangeSchema = z.object({
  dealId: z.string().uuid('Invalid deal ID'),
  newStatus: z.enum(['under_review', 'approved', 'funded', 'repaid', 'closed', 'denied', 'cancelled']),
  denialReason: z.string().max(500).optional().nullable(),
})

/** Schema for document upload metadata */
export const DocumentUploadSchema = z.object({
  dealId: z.string().uuid('Invalid deal ID'),
  documentType: z.enum(VALID_DOCUMENT_TYPE_VALUES as unknown as [string, ...string[]]),
  fileName: z.string().min(1).max(255),
  filePath: z.string().min(1),
  fileSize: z.number().min(1).max(MAX_UPLOAD_SIZE_BYTES),
  uploadSource: z.enum(VALID_UPLOAD_SOURCES as unknown as [string, ...string[]]),
})

export type DealSubmission = z.infer<typeof DealSubmissionSchema>
export type DealStatusChange = z.infer<typeof DealStatusChangeSchema>
export type DocumentUpload = z.infer<typeof DocumentUploadSchema>
