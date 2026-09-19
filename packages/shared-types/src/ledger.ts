// Ledger contracts — single central post shape used by every module.
// LedgerService.post(entry) is the ONLY writer of journal_entries/lines.

import type { JournalSourceType } from './enums.js';

export interface JournalLineInput {
  accountCode: string; // resolved to account_id by LedgerService
  debitAgora: number; // integer >= 0
  creditAgora: number; // integer >= 0
  customerId?: string;
  supplierId?: string;
  memo?: string;
}

export interface JournalEntryInput {
  tenantId: string;
  branchId: string;
  fiscalYearId: string;
  date: Date | string;
  sourceType: JournalSourceType | string;
  sourceId: string;
  memo?: string;
  reversesEntryId?: string;
  lines: JournalLineInput[];
}

export function assertBalanced(lines: JournalLineInput[]): void {
  if (lines.length < 2) throw new Error('Journal entry must have at least 2 lines');
  let dr = 0;
  let cr = 0;
  for (const l of lines) {
    if (!Number.isInteger(l.debitAgora) || !Number.isInteger(l.creditAgora)) {
      throw new Error('Journal amounts must be integer agora');
    }
    if (l.debitAgora < 0 || l.creditAgora < 0) throw new Error('Journal amounts must be >= 0');
    if (l.debitAgora > 0 && l.creditAgora > 0)
      throw new Error('A journal line cannot be both debit and credit');
    if (l.debitAgora === 0 && l.creditAgora === 0) throw new Error('A journal line cannot be zero-sided');
    dr += l.debitAgora;
    cr += l.creditAgora;
  }
  if (dr !== cr) throw new Error(`Unbalanced entry: Dr=${dr} Cr=${cr}`);
  if (dr === 0) throw new Error('Journal entry total cannot be zero');
}
