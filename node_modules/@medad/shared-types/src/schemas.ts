import { z } from 'zod';

// Shared Zod validation (used by API DTOs and web forms).

export const uuidSchema = z.string().uuid();
export const agoraSchema = z.number().int().min(0);
export const taxRateBpsSchema = z.number().int().min(0).max(10000);
export const barcodeSchema = z.string().min(1).max(64);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const journalLineSchema = z
  .object({
    accountCode: z.string().min(1).max(32),
    debitAgora: z.number().int().min(0),
    creditAgora: z.number().int().min(0),
    customerId: uuidSchema.optional(),
    supplierId: uuidSchema.optional(),
    memo: z.string().max(500).optional(),
  })
  .refine((l) => (l.debitAgora > 0) !== (l.creditAgora > 0), {
    message: 'Exactly one side must be positive',
  });

export const journalEntrySchema = z.object({
  tenantId: uuidSchema,
  branchId: uuidSchema,
  fiscalYearId: uuidSchema,
  date: z.coerce.date(),
  sourceType: z.string().min(1).max(32),
  sourceId: z.string().min(1).max(64),
  memo: z.string().max(500).optional(),
  reversesEntryId: uuidSchema.optional(),
  lines: z.array(journalLineSchema).min(2),
});

export const invoiceLineSchema = z.object({
  variantId: uuidSchema.optional(),
  productId: uuidSchema.optional(),
  qty: z.number().int().min(1),
  unitPriceAgora: agoraSchema,
  lineDiscountAgora: agoraSchema.default(0),
  taxRateBps: taxRateBpsSchema.default(0),
});

export const invoiceCreateSchema = z.object({
  branchId: uuidSchema,
  customerId: uuidSchema,
  invoiceDiscountAgora: agoraSchema.default(0),
  lines: z.array(invoiceLineSchema).min(1),
  payments: z
    .array(
      z.object({
        method: z.string().min(1).max(32),
        accountCode: z.string().min(1).max(32),
        amountAgora: z.number().int().min(1),
      }),
    )
    .min(1),
});

export const purchaseCreateSchema = z.object({
  branchId: uuidSchema,
  supplierId: uuidSchema,
  refNo: z.string().max(64).optional(),
  discountAgora: agoraSchema.default(0),
  lines: z
    .array(
      z.object({
        variantId: uuidSchema,
        qty: z.number().int().min(1),
        unitCostAgora: agoraSchema,
        lineDiscountAgora: agoraSchema.default(0),
      }),
    )
    .min(1),
  payments: z
    .array(z.object({ accountCode: z.string().min(1).max(32), amountAgora: agoraSchema }))
    .default([]),
});
