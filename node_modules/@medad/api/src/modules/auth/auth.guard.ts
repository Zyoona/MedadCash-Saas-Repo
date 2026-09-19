import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata,
  UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthService, type AuthUser } from './auth.service.js';
import { hasPerm } from '../../common/permissions.js';

export const IS_PUBLIC_KEY = 'medad:public';
export const PERMS_KEY = 'medad:perms';

/** Mark a route public (no auth): login/refresh/health. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
/** Require permission(s) on a route (RBAC §7). */
export const RequirePerm = (...perms: string[]) => SetMetadata(PERMS_KEY, perms);
/** Inject the authenticated user. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request & { user: AuthUser }>();
  return req.user;
});

export type { AuthUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = String(req.headers['authorization'] ?? '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('يجب تسجيل الدخول للمتابعة');

    const user = await this.auth.authenticate(token);
    req.user = user;

    const required = this.reflector.getAllAndOverride<string[]>(PERMS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? [];
    for (const p of required) {
      if (!hasPerm(user.perms, p)) throw new ForbiddenException(`ليست لديك صلاحية لتنفيذ هذا الإجراء (${p})`);
    }
    return true;
  }
}
