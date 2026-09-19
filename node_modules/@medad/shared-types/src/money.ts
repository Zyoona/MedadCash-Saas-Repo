// Money: integer Agora (1 ₪ = 100 agora). Never use float for money.
// DB stores NUMERIC(18,2); code computes in integer minor units.

export const AGORA_PER_SHEKEL = 100;

/** Parse a decimal string/number to integer agora without float errors. */
export function toAgora(amount: string | number): number {
  const s = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  const neg = s.startsWith('-');
  const digits = (neg ? s.slice(1) : s).split('.');
  const shekels = parseInt(digits[0] || '0', 10);
  const frac = (digits[1] || '').padEnd(2, '0').slice(0, 2);
  const agora = shekels * AGORA_PER_SHEKEL + parseInt(frac || '0', 10);
  return neg ? -agora : agora;
}

/** Format integer agora back to "1234.56" string (2 decimals). */
export function fromAgora(agora: number): string {
  const neg = agora < 0;
  const abs = Math.abs(Math.round(agora));
  const shekels = Math.floor(abs / AGORA_PER_SHEKEL);
  const frac = String(abs % AGORA_PER_SHEKEL).padStart(2, '0');
  return `${neg ? '-' : ''}${shekels}.${frac}`;
}

/** Multiply agora by a rate (0..1 as numerator/denominator) with banker's rounding to agora. */
export function mulRate(agora: number, numerator: number, denominator: number): number {
  return Math.round((agora * numerator) / denominator);
}

/** Display: "₪ 1,234.56" */
export function formatILS(agora: number): string {
  const neg = agora < 0;
  const abs = Math.abs(Math.round(agora));
  const shekels = Math.floor(abs / AGORA_PER_SHEKEL);
  const frac = String(abs % AGORA_PER_SHEKEL).padEnd(2, '0').slice(0, 2);
  return `${neg ? '-' : ''}₪ ${shekels.toLocaleString('en-US')}.${frac}`;
}

export function assertIntegerAgora(value: number, field = 'amount'): void {
  if (!Number.isInteger(value)) throw new Error(`Money must be integer agora: ${field}=${value}`);
}
