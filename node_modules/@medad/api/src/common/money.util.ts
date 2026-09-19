// Money helpers: integer agora everywhere (no float). DB bridge via Prisma.Decimal strings.
import { Prisma } from '@prisma/client';
import { fromAgora, toAgora } from '@medad/shared-types';

export function decToAgora(d: Prisma.Decimal | string | number | null | undefined): number {
  if (d === null || d === undefined) return 0;
  return toAgora(String(d));
}

export function agoraToDec(a: number): Prisma.Decimal {
  return new Prisma.Decimal(fromAgora(a));
}

/** Multiply by basis points with integer rounding (bps: 0=0%, 1600=16%). */
export function mulBps(amountAgora: number, bps: number): number {
  return Math.round((amountAgora * bps) / 10000);
}

/**
 * Allocate `total` across `weights` proportionally, largest-remainder,
 * so that sum(parts) === total exactly. Integer agora only.
 */
export function allocateProRata(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w * total) / sum);
  const floors = exact.map((x) => Math.floor(x));
  let remainder = total - floors.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remainder <= 0) break;
    floors[i] += 1;
    remainder -= 1;
  }
  return floors;
}
