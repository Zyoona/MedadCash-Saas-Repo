import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PERMS, ROLES, expandPerms } from '../../common/permissions.js';
import { auditTx, type Db } from '../../common/ctx.js';

export interface UserInput {
  email: string;
  password: string;
  name: string;
  role: string;
  branchId?: string | null;
  permissionsOverride?: Record<string, boolean> | null;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  list(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, email: true, name: true, role: true, branchId: true, isActive: true, permissionsOverride: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(tenantId: string, input: UserInput, actorId: string) {
    if (!ROLES.includes(input.role as never)) throw new BadRequestException(`دور غير معروف: ${input.role}`);
    const email = input.email.toLowerCase().trim();
    const dup = await this.prisma.user.findFirst({ where: { tenantId, email } });
    if (dup) throw new ConflictException('البريد مستخدم مسبقاً');
    const hash = await bcrypt.hash(input.password, 12);
    const u = await this.prisma.$transaction(async (db: Db) => {
      const created = await db.user.create({
        data: {
          tenantId, email, name: input.name, role: input.role,
          branchId: input.branchId ?? null,
          passwordHash: hash,
          permissionsOverride: input.permissionsOverride ?? undefined,
        },
        select: { id: true, email: true, name: true, role: true, branchId: true, isActive: true, permissionsOverride: true },
      });
      await auditTx(db, { tenantId, actorId, action: 'create', entity: 'users', entityId: created.id, diff: { email, role: input.role } });
      return created;
    });
    return u;
  }

  async update(tenantId: string, id: string, patch: { name?: string; role?: string; branchId?: string | null; isActive?: boolean; permissionsOverride?: Record<string, boolean> | null }, actorId: string) {
    const u = await this.prisma.user.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!u) throw new NotFoundException('المستخدم غير موجود');
    if (patch.role && !ROLES.includes(patch.role as never)) throw new BadRequestException(`دور غير معروف`);
    const updated = await this.prisma.$transaction(async (db: Db) => {
      const row = await db.user.update({
        where: { id },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.role !== undefined ? { role: patch.role } : {}),
          ...(patch.branchId !== undefined ? { branchId: patch.branchId } : {}),
          ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
          ...(patch.permissionsOverride !== undefined ? { permissionsOverride: patch.permissionsOverride } : {}),
        },
        select: { id: true, email: true, name: true, role: true, branchId: true, isActive: true, permissionsOverride: true },
      });
      await auditTx(db, { tenantId, actorId, action: 'update', entity: 'users', entityId: id, diff: patch });
      return row;
    });
    return updated;
  }

  async resetPassword(tenantId: string, id: string, newPassword: string, actorId: string) {
    const u = await this.prisma.user.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!u) throw new NotFoundException('المستخدم غير موجود');
    const hash = await bcrypt.hash(newPassword, 12);
    await this.prisma.$transaction(async (db: Db) => {
      await db.user.update({ where: { id }, data: { passwordHash: hash } });
      await auditTx(db, { tenantId, actorId, action: 'reset_password', entity: 'users', entityId: id });
    });
    return { ok: true };
  }

  /** Effective permission matrix for UI display. */
  matrix(tenantId: string) {
    return this.prisma.user.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true, role: true, permissionsOverride: true },
    }).then((rows) =>
      rows.map((r) => ({
        id: r.id, name: r.name, role: r.role,
        perms: expandPerms(r.role, (r.permissionsOverride ?? null) as Record<string, boolean> | null),
      })),
    );
  }

  static allPerms() {
    return PERMS;
  }
}
