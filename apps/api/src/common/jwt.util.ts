// Minimal dependency-free HS256 JWT (sign/verify) using node:crypto.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtPayload {
  sub: string;
  tenantId: string;
  branchId: string | null;
  role: string;
  email: string;
  name: string;
  typ: 'access' | 'refresh';
  iat: number;
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(data: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  ttlSec: number,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat, exp: iat + ttlSec };
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(full)));
  return `${head}.${body}.${sign(`${head}.${body}`, secret)}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JwtPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
