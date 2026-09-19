// Shared enums — must match Prisma schema exactly.

export const PurchaseStatus = {
  ORDERED: 'ordered',
  PENDING: 'pending',
  RECEIVED: 'received',
} as const;
export type PurchaseStatus = (typeof PurchaseStatus)[keyof typeof PurchaseStatus];

export const InvoiceStatus = {
  DRAFT: 'draft',
  POSTED: 'posted',
  VOID: 'void',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const TransferStatus = {
  IN_TRANSIT: 'in_transit',
  RECEIVED: 'received',
} as const;
export type TransferStatus = (typeof TransferStatus)[keyof typeof TransferStatus];

export const CountType = {
  INITIAL: 'initial',
  DAILY: 'daily',
} as const;
export type CountType = (typeof CountType)[keyof typeof CountType];

export const QuotationStatus = {
  OPEN: 'open',
  CONVERTED: 'converted',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
} as const;
export type QuotationStatus = (typeof QuotationStatus)[keyof typeof QuotationStatus];

export const JournalSourceType = {
  SALE: 'sale',
  SALE_COGS: 'sale_cogs',
  COLLECTION: 'collection',
  PURCHASE: 'purchase',
  SUPPLIER_PAYMENT: 'supplier_payment',
  SALE_RETURN: 'sale_return',
  SALE_RETURN_COGS: 'sale_return_cogs',
  OPENING_BALANCE: 'opening_balance',
  ACCOUNT_TRANSFER: 'account_transfer',
  STOCK_ADJUSTMENT: 'stock_adjustment',
  STOCK_TRANSFER_OUT: 'stock_transfer_out',
  STOCK_TRANSFER_IN: 'stock_transfer_in',
  REVERSAL: 'reversal',
} as const;
export type JournalSourceType = (typeof JournalSourceType)[keyof typeof JournalSourceType];
