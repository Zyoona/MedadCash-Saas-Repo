// RBAC: role defaults + per-user override (§7 of plan).
// manager = everything; others get scoped defaults; permissionsOverride JSON wins per key.

export const PERMS = [
  'dashboard.view',
  'users.manage',
  'settings.view', 'settings.manage',
  'accounts.view', 'accounts.manage', 'checks.manage',
  'ledger.view', 'ledger.post', 'ledger.reverse',
  'audit.view',
  'fiscal.manage',
  'catalog.view', 'catalog.manage',
  'inventory.view', 'inventory.count', 'inventory.transfer',
  'parties.view', 'parties.manage',
  'purchases.view', 'purchases.manage',
  'pos.view', 'pos.sell', 'pos.shift',
  'pos.shift_any', // ربط/إقفال ورديات كاشير آخر أو فرع آخر (مدير)
  'returns.manage',
  'quotations.view', 'quotations.manage',
  'tasks.view', 'tasks.manage',
  'labels.print',
  'reports.view',
  'sync.view', 'sync.resolve',
  'backup.view', 'backup.manage',
  'override_credit_limit',
] as const;
export type Perm = (typeof PERMS)[number];

export const ROLES = ['manager', 'accountant', 'cashier', 'inventory'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_DEFAULTS: Record<string, readonly string[]> = {
  manager: ['*'],
  accountant: [
    'dashboard.view', 'settings.view', 'accounts.view', 'accounts.manage', 'checks.manage',
    'ledger.view', 'ledger.post', 'ledger.reverse', 'audit.view', 'fiscal.manage',
    'catalog.view', 'inventory.view', 'parties.view', 'parties.manage',
    'purchases.view', 'purchases.manage', 'pos.view', 'quotations.view', 'tasks.view',
    'reports.view', 'sync.view', 'backup.view',
  ],
  cashier: [
    'dashboard.view', 'pos.view', 'pos.sell', 'pos.shift', 'returns.manage',
    'quotations.view', 'quotations.manage', 'parties.view', 'inventory.view',
    'tasks.view', 'labels.print',
  ],
  inventory: [
    'dashboard.view', 'catalog.view', 'catalog.manage', 'inventory.view',
    'inventory.count', 'inventory.transfer', 'labels.print', 'tasks.view', 'tasks.manage',
    'parties.view', 'purchases.view', 'reports.view',
  ],
};

export function expandPerms(role: string, override?: Record<string, boolean> | null): string[] {
  const base = ROLE_DEFAULTS[role] ?? [];
  const set = new Set<string>(base.includes('*') ? [...PERMS] : base);
  if (override) {
    for (const [k, v] of Object.entries(override)) {
      if (v === true) set.add(k);
      else if (v === false) set.delete(k);
    }
  }
  return [...set];
}

export function hasPerm(perms: string[], perm: string): boolean {
  return perms.includes('*') || perms.includes(perm);
}
