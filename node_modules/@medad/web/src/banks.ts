// الحسابات البنكية — مصدر واحد لكل شاشات الدفع والتحصيل.
// كل حساب بنكي مرتبط بكود GL؛ خيارات الدفع = الصندوق + البنوك النشطة.
import { useEffect, useState } from 'react';
import { api } from './api.js';

export interface BankAccount {
  id: string;
  glAccountCode: string;
  bankName: string;
  accountLabel: string | null;
  accountNumber: string | null;
  iban: string | null;
  currency: string;
  notes: string | null;
  isActive: boolean;
  glAccountName?: string | null;
  glClosed?: boolean;
  debitAgora?: number;
  creditAgora?: number;
  balanceAgora?: number;
}

export interface PaySource { code: string; label: string }

export const CASH_CODE = '1000';

export const bankLabel = (b: BankAccount): string =>
  `${b.bankName}${b.accountLabel ? ' — ' + b.accountLabel : ''}`;

export function useBanks(activeOnly = true) {
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [failed, setFailed] = useState(false);
  const reload = () =>
    api<BankAccount[]>('/accounts/banks')
      .then((rows) => setBanks(activeOnly ? rows.filter((b) => b.isActive) : rows))
      .catch(() => setFailed(true));
  useEffect(() => { void reload(); }, []);
  return { banks, failed, reload };
}

/** خيارات حساب الدفع: الصندوق + كل حساب بنكي نشط (تظهر ضمن كل النوافذ المالية). */
export function usePaySources(activeOnly = true) {
  const { banks, failed, reload } = useBanks(activeOnly);
  const sources: PaySource[] = [
    { code: CASH_CODE, label: 'الصندوق (نقد)' },
    ...banks.map((b) => ({ code: b.glAccountCode, label: `${bankLabel(b)} (${b.glAccountCode})` })),
  ];
  return { sources, banks, failed, reload };
}
