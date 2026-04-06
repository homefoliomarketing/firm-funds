import { z } from 'zod'
import {
  MIN_GROSS_COMMISSION,
  MAX_GROSS_COMMISSION,
  MIN_DAYS_UNTIL_CLOSING,
  MAX_DAYS_UNTIL_CLOSING,
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
  newStatus: z.enum(['under_review', 'approved', 'funded', 'completed', 'denied', 'cancelled']),
  denialReason: z.string().max(500).optional().nullable(),
})

export type DealSubmission = z.infer<typeof DealSubmissionSchema>
export type DealStatusChange = z.infer<typeof DealStatusChangeSchema>

// ============================================================================
// Admin Action Schemas (H6 security fix)
// ============================================================================

/** Sanitize text fields — strip potential XSS */
const sanitizedString = (maxLen = 500) =>
  z.string().max(maxLen).transform(val => val.replace(/<[^>]*>/g, '').trim())

const emailSchema = z.string().email('Invalid email address').max(254).transform(val => val.toLowerCase().trim())
const phoneSchema = z.string().max(30).regex(/^[\d\s\-+().ext]*$/, 'Invalid phone number format').optional().nullable()

export const CreateBrokerageSchema = z.object({
  name: sanitizedString(200).pipe(z.string().min(1, 'Brokerage name is required')),
  email: emailSchema,
  brand: sanitizedString(200).optional().nullable(),
  address: sanitizedString(300).optional().nullable(),
  phone: phoneSchema,
  referralFeePercentage: z.number().min(0).max(1, 'Referral fee must be between 0 and 1'),
  transactionSystem: sanitizedString(100).optional().nullable(),
  notes: sanitizedString(2000).optional().nullable(),
  brokerOfRecordName: sanitizedString(200).optional().nullable(),
  brokerOfRecordEmail: emailSchema.optional().nullable(),
  logoUrl: z.string().url().max(2000).optional().nullable(),
  brandColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Must be a valid hex color').optional().nullable(),
})

export const UpdateBrokerageSchema = CreateBrokerageSchema.extend({
  id: z.string().uuid('Invalid brokerage ID'),
  status: z.enum(['active', 'inactive', 'suspended']),
})

export const CreateAgentSchema = z.object({
  brokerageId: z.string().uuid('Invalid brokerage ID'),
  firstName: sanitizedString(100).pipe(z.string().min(1, 'First name is required')),
  lastName: sanitizedString(100).pipe(z.string().min(1, 'Last name is required')),
  email: emailSchema,
  phone: phoneSchema,
  recoNumber: sanitizedString(50).optional().nullable(),
})

export const UpdateAgentSchema = CreateAgentSchema.extend({
  id: z.string().uuid('Invalid agent ID'),
  status: z.enum(['active', 'inactive', 'archived']),
  flaggedByBrokerage: z.boolean(),
  outstandingRecovery: z.number().min(0),
})

export const CreateUserAccountSchema = z.object({
  email: emailSchema,
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: sanitizedString(200).pipe(z.string().min(1, 'Full name is required')),
  role: z.enum(['agent', 'brokerage_admin']),
  agentId: z.string().uuid().optional().nullable(),
  brokerageId: z.string().uuid().optional().nullable(),
})
