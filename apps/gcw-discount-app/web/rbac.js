import crypto from 'crypto';

const ALLOWED_GITHUB_LOGIN = 'ncassidy233';
const COOKIE_NAME = 'gcw_auth';
const COOKIE_SECRET = process.env.SESSION_ENCRYPTION_KEY || '';

if (!COOKIE_SECRET) {
  console.error('[Auth] SESSION_ENCRYPTION_KEY is required for GitHub authentication.');
}

// Legacy exports kept so existing code that references them doesn't break
export const ROLES = {
  viewer:  { level: 1, label: 'Viewer',  description: 'View-only' },
  builder: { level: 2, label: 'Builder', description: 'Create and edit' },
  admin:   { level: 3, label: 'Admin',   description: 'Full access' },
};
export const userRoles = {};

export function seedRolesFromEnv() {
  console.log(`[Auth] GitHub-only access enabled for ${ALLOWED_GITHUB_LOGIN}.`);
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

export function isAuthenticated(req) {
  const cookie = req.cookies?.[COOKIE_NAME];
  if (cookie && verifySignedValue(cookie) === ALLOWED_GITHUB_LOGIN) return true;

  const idToken = req.headers['x-shopify-id-token'];
  const authorization = req.headers.authorization;
  const bearerToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  return Boolean(
    (idToken && verifySessionToken(String(idToken))) ||
    (bearerToken && verifySessionToken(bearerToken)),
  );
}

export function setAuthCookie(res, githubLogin) {
  if (githubLogin !== ALLOWED_GITHUB_LOGIN) return;
  res.cookie(COOKIE_NAME, signValue(githubLogin), {
    httpOnly: true,
    secure: true,
    sameSite: 'none', // Required for Shopify embedded iframes
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });
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
  const cookie = req.cookies?.[COOKIE_NAME];
  const isGitHubAdmin = cookie && verifySignedValue(cookie) === ALLOWED_GITHUB_LOGIN;
  req.gcwAuthenticated = Boolean(isGitHubAdmin || isAuthenticated(req));
  req.userEmail = isGitHubAdmin ? ALLOWED_GITHUB_LOGIN : null;
  req.userRole = isGitHubAdmin ? 'admin' : req.gcwAuthenticated ? 'builder' : 'viewer';
  next();
}

function requireViewer(req, res, next) {
  if (req.gcwAuthenticated) return next();
  return res.status(403).json({ success: false, error: 'GitHub authentication required.' });
}

function requireBuilder(req, res, next) {
  if (req.userRole === 'admin' || req.userRole === 'builder') return next();
  return res.status(403).json({ success: false, error: 'A valid Shopify app session is required.' });
}

function requireAdmin(req, res, next) {
  if (req.userRole === 'admin') return next();
  return res.status(403).json({ success: false, error: 'GitHub administrator authentication required.' });
}

export { requireViewer, requireBuilder, requireAdmin };
