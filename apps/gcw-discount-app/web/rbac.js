import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Simple password-based auth: a single password grants full admin access.
// The password is compared using constant-time comparison to prevent timing attacks.
// Once authenticated, a signed cookie persists the session.
// ---------------------------------------------------------------------------

const APP_PASSWORD = process.env.GCW_APP_PASSWORD || 'Sugi2.0';
const COOKIE_NAME = 'gcw_auth';
const COOKIE_SECRET = process.env.SESSION_ENCRYPTION_KEY || process.env.SHOPIFY_API_SECRET || 'gcw-fallback-key';

// Legacy exports kept so existing code that references them doesn't break
export const ROLES = {
  viewer:  { level: 1, label: 'Viewer',  description: 'View-only' },
  builder: { level: 2, label: 'Builder', description: 'Create and edit' },
  admin:   { level: 3, label: 'Admin',   description: 'Full access' },
};
export const userRoles = {};

export function seedRolesFromEnv() {
  console.log('[Auth] Password-based auth active. Single password grants full admin access.');
}

export function getUserRole(_email) {
  return 'admin';
}

export function hasPermission(_role, _requiredLevel) {
  return true;
}

// Sign a value with HMAC so the cookie can't be forged
function signValue(value) {
  return value + '.' + crypto.createHmac('sha256', COOKIE_SECRET).update(value).digest('hex');
}

function verifySignedValue(signed) {
  if (!signed || typeof signed !== 'string') return null;
  const idx = signed.lastIndexOf('.');
  if (idx < 1) return null;
  const value = signed.substring(0, idx);
  const expected = signValue(value);
  // Constant-time comparison
  if (expected.length !== signed.length) return null;
  try {
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signed))) return value;
  } catch { /* length mismatch */ }
  return null;
}

// Check if the request is authenticated (has valid cookie OR valid password header)
export function isAuthenticated(req) {
  // 1. Check signed cookie
  const cookie = req.cookies?.[COOKIE_NAME];
  if (cookie) {
    const val = verifySignedValue(cookie);
    if (val === 'authenticated') return true;
  }
  // 2. Check password in custom header (for API calls from the embedded frontend)
  const headerPw = req.headers['x-gcw-password'];
  if (headerPw && headerPw.length === APP_PASSWORD.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(headerPw), Buffer.from(APP_PASSWORD))) return true;
    } catch { /* length mismatch */ }
  }
  // 3. Accept valid Shopify session tokens (App Bridge / URL fallback)
  const idTokenHeader = req.headers['x-shopify-id-token'];
  if (idTokenHeader && verifySessionToken(String(idTokenHeader))) return true;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7);
    if (bearer && verifySessionToken(bearer)) return true;
  }
  return false;
}

// Set the auth cookie on the response
export function setAuthCookie(res) {
  res.cookie(COOKIE_NAME, signValue('authenticated'), {
    httpOnly: true,
    secure: true,
    sameSite: 'none', // Required for Shopify embedded iframes
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });
}

// Verify password (constant-time)
export function verifyPassword(password) {
  if (!password || typeof password !== 'string') return false;
  if (password.length !== APP_PASSWORD.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(password), Buffer.from(APP_PASSWORD));
  } catch { return false; }
}

// JWT verify — kept so token exchange still works for Shopify OAuth
{
  const _s = (process.env.SHOPIFY_API_SECRET || '').trim();
  console.log(`[JWT-BOOT] SHOPIFY_API_SECRET loaded — len=${_s.length}, start=${_s.substring(0,4)}..., end=...${_s.substring(_s.length - 4)}`);
}

export function verifySessionToken(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const signingInput = `${parts[0]}.${parts[1]}`;
    const secret = (process.env.SHOPIFY_API_SECRET || '').trim();
    const expectedSig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
    const gotSig = parts[2];

    let valid = false;
    if (expectedSig === gotSig) {
      valid = true;
    } else {
      const expRaw = crypto.createHmac('sha256', secret).update(signingInput).digest();
      const gotRaw = Buffer.from(gotSig.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - gotSig.length % 4) % 4), 'base64');
      if (expRaw.length === gotRaw.length) {
        try { valid = crypto.timingSafeEqual(expRaw, gotRaw); } catch { valid = false; }
      }
    }
    if (!valid) return null;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    const EXP_GRACE = 120;
    if (payload.exp && payload.exp + EXP_GRACE < now) return null;
    if (payload.nbf && payload.nbf - EXP_GRACE > now) return null;
    if (payload.aud && payload.aud !== process.env.SHOPIFY_API_KEY) return null;
    return payload;
  } catch { return null; }
}

export function emailFromIdToken(token) {
  const payload = verifySessionToken(token);
  if (payload?.email) return payload.email;
  return null;
}

// Middleware: attach role (always admin once authenticated)
export function attachUserRole(req, res, next) {
  req.gcwAuthenticated = isAuthenticated(req);
  req.userEmail = null;
  req.userRole = req.gcwAuthenticated ? 'admin' : 'viewer';
  next();
}

// All three permission levels now just check the password auth
function requireAuth(req, res, next) {
  if (req.gcwAuthenticated) return next();
  return res.status(403).json({ success: false, error: 'Authentication required. Please log in with the app password.' });
}

export const requireViewer  = requireAuth;
export const requireBuilder = requireAuth;
export const requireAdmin   = requireAuth;
