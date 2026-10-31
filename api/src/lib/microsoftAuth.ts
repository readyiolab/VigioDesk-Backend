import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../config/env';
import { logger } from './logger';
import { AppError } from '../middleware/errorHandler.middleware';

/**
 * Microsoft Entra ID (v2) ID-token verification for customer sign-in.
 *
 * The browser MSAL popup returns an ID token. We verify signature against
 * Microsoft's common JWKS, audience, tenant-scoped issuer, and extract email.
 * MICROSOFT_CLIENT_SECRET is unused for this flow (no code exchange).
 */

const JWKS_URL = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(JWKS_URL));
  }
  return jwks;
}

export function isMicrosoftAuthConfigured(): boolean {
  return Boolean(env.MICROSOFT_CLIENT_ID?.trim());
}

export interface VerifiedMicrosoftIdentity {
  email: string;
  name: string | null;
  sub: string;
  emailVerified: boolean;
  tid: string;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function extractEmail(payload: JWTPayload): string | null {
  const emailClaim = typeof payload.email === 'string' ? payload.email.trim() : '';
  if (emailClaim && looksLikeEmail(emailClaim)) {
    return emailClaim.toLowerCase();
  }

  const preferred =
    typeof payload.preferred_username === 'string' ? payload.preferred_username.trim() : '';
  if (preferred && looksLikeEmail(preferred)) {
    return preferred.toLowerCase();
  }

  return null;
}

function assertIssuer(payload: JWTPayload): string {
  const tid = typeof payload.tid === 'string' ? payload.tid.trim() : '';
  if (!tid) {
    throw new AppError('Microsoft authentication failed: tenant id missing from token', 401);
  }

  const configuredTenant = (env.MICROSOFT_TENANT || 'common').trim().toLowerCase();
  if (
    configuredTenant &&
    configuredTenant !== 'common' &&
    configuredTenant !== 'organizations' &&
    configuredTenant !== 'consumers' &&
    tid.toLowerCase() !== configuredTenant
  ) {
    throw new AppError('Microsoft authentication failed: unexpected tenant', 401);
  }

  const expectedIss = `https://login.microsoftonline.com/${tid}/v2.0`;
  if (payload.iss !== expectedIss) {
    throw new AppError('Microsoft authentication failed: unexpected token issuer', 401);
  }

  return tid;
}

/**
 * Verifies a Microsoft ID token and returns the trusted identity claims.
 */
export async function verifyMicrosoftIdToken(credential: string): Promise<VerifiedMicrosoftIdentity> {
  if (!env.MICROSOFT_CLIENT_ID?.trim()) {
    throw new AppError('Microsoft sign-in is not configured on this server', 503);
  }
  if (!credential?.trim()) {
    throw new AppError('Microsoft authentication failed: credential is required', 400);
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(credential, getJwks(), {
      audience: env.MICROSOFT_CLIENT_ID,
      clockTolerance: 60,
    });
    payload = verified.payload;
  } catch (err) {
    logger.warn({ err }, 'Microsoft ID token verification failed');
    throw new AppError('Microsoft authentication failed: invalid or expired credential', 401);
  }

  const tid = assertIssuer(payload);

  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new AppError('Microsoft authentication failed: subject missing from token', 401);
  }

  const email = extractEmail(payload);
  if (!email) {
    throw new AppError(
      'Microsoft authentication failed: email missing from token. Enable the email optional claim in Entra.',
      401
    );
  }

  const name =
    (typeof payload.name === 'string' && payload.name.trim()) ||
    (typeof payload.given_name === 'string' && payload.given_name.trim()) ||
    null;

  return {
    email,
    name,
    sub: payload.sub,
    emailVerified: true,
    tid,
  };
}
