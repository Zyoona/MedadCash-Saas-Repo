import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma/prisma.service.js';
import { signJwt, verifyJwt, type JwtPayload } from '../../common/jwt.util.js';
import { ACCESS_TTL_SEC, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, REFRESH_TTL_SEC } from '../../common/env.js';
import { expandPerms } from '../../common/permissions.js';
import { AuditService } from '../audit/audit.service.js';

export interface AuthUser {
  userId: string;
  tenantId: string;
  branchId: string | null;
  role: string;
  email: string;
  name: string;
  perms: string[];
}

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private toAuthUser(u: { id: string; tenantId: string; branchId: string | null; role: string; email: string; name: string; permissionsOverride: unknown }): AuthUser {
    const override = (u.permissionsOverride ?? null) as Record<string, boolean> | null;
    return {
      userId: u.id, tenantId: u.tenantId, branchId: u.branchId,
      role: u.role, email: u.email, name: u.name,
      perms: expandPerms(u.role, override),
    };
  }

  async login(email: string, password: string, ip?: string, device?: string) {
    const u = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase().trim(), deletedAt: null },
    });
    const fail = async () => {
      if (u) {
        await this.audit.log({ tenantId: u.tenantId, actorId: u.id, action: 'login_failed', entity: 'users', entityId: u.id, ip, device }).catch(() => undefined);
      }
      throw new UnauthorizedException('بيانات الدخول غير صحيحة');
    };
    if (!u || !u.isActive) return fail();
    const ok = await bcrypt.compare(password, u.passwordHash);
    if (!ok) return fail();

    const user = this.toAuthUser(u);
    await this.audit.log({ tenantId: u.tenantId, actorId: u.id, action: 'login', entity: 'users', entityId: u.id, ip, device }).catch(() => undefined);
    return { user, ...this.tokens(user) };
  }

  private tokens(user: AuthUser) {
    const base: Omit<JwtPayload, 'iat' | 'exp' | 'typ'> = {
      sub: user.userId, tenantId: user.tenantId, branchId: user.branchId,
      role: user.role, email: user.email, name: user.name,
    };
    return {
      accessToken: signJwt({ ...base, typ: 'access' }, JWT_ACCESS_SECRET, ACCESS_TTL_SEC),
      refreshToken: signJwt({ ...base, typ: 'refresh' }, JWT_REFRESH_SECRET, REFRESH_TTL_SEC),
    };
  }

  async refresh(refreshToken: string) {
    const payload = verifyJwt(refreshToken, JWT_REFRESH_SECRET);
    if (!payload || payload.typ !== 'refresh') throw new UnauthorizedException('انتهت صلاحية الجلسة — يرجى تسجيل الدخول مرة أخرى');
    const u = await this.prisma.user.findFirst({ where: { id: payload.sub, deletedAt: null, isActive: true } });
    if (!u) throw new UnauthorizedException('هذا المستخدم غير نشط — راجع المسؤول');
    const user = this.toAuthUser(u);
    return { user, ...this.tokens(user) };
  }

  /** Per-request: verify access token and load a fresh user (perms may have changed). */
  async authenticate(token: string): Promise<AuthUser> {
    const payload = verifyJwt(token, JWT_ACCESS_SECRET);
    if (!payload || payload.typ !== 'access') throw new UnauthorizedException('انتهت صلاحية الجلسة — يرجى تسجيل الدخول مرة أخرى');
    const u = await this.prisma.user.findFirst({ where: { id: payload.sub, deletedAt: null } });
    if (!u) throw new UnauthorizedException('المستخدم غير موجود — يرجى تسجيل الدخول مرة أخرى');
    if (!u.isActive) throw new ForbiddenException('تم تعطيل هذا الحساب — راجع المسؤول');
    return this.toAuthUser(u);
  }
}
