import crypto from 'crypto';
import { userEmailCache } from './shopify-utils.js';

export const ROLES = {
  viewer:  { level: 1, label: 'Viewer',  description: 'View-only access to dashboard' },
  builder: { level: 2, label: 'Builder / Planner', description: 'Create and edit non-active discounts' },
  admin:   { level: 3, label: 'Admin / Activator', description: 'Full access — activate discounts, edit live campaigns, manage users' },
};

export const userRoles = {};
const DEFAULT_ROLE = 'viewer';

export function seedRolesFromEnv() {
  (process.env.GCW_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean).forEach(email => {
    userRoles[email] = 'admin';
  });
  (process.env.GCW_BUILDER_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean).forEach(email => {
    if (!userRoles[email]) userRoles[email] = 'builder';
  });
  (process.env.GCW_VIEWER_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean).forEach(email => {
    if (!userRoles[email]) userRoles[email] = 'viewer';
  });
  const count = Object.keys(userRoles).length;
  if (count) console.log(`[RBAC] Seeded ${count} user role(s) from env vars`);
}

export function getUserRole(email) {
  if (!email) return DEFAULT_ROLE;
  const normalised = email.trim().toLowerCase();
  return userRoles[normalised] || DEFAULT_ROLE;
}

export function hasPermission(role, requiredLevel) {
  return (ROLES[role]?.level || 0) >= requiredLevel;
}

let _jwtDebugLogged = false;
let _jwtMismatchCount = 0;
let _jwtCallCount = 0;

// Log secret fingerprint at startup so we can verify the right value is loaded
{
  const _s = (process.env.SHOPIFY_API_SECRET || '').trim();
  console.log(`[JWT-BOOT] SHOPIFY_API_SECRET loaded — len=${_s.length}, start=${_s.substring(0,4)}..., end=...${_s.substring(_s.length - 4)}`);
}

export function verifySessionToken(token) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());

    const signingInput = `${parts[0]}.${parts[1]}`;
    const secret = (process.env.SHOPIFY_API_SECRET || '').trim();
    _jwtCallCount++;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(signingInput)
      .digest('base64url');

    // Compare: try base64url first, then normalise both to raw bytes
    const gotSig = parts[2];
    if (expectedSig === gotSig) {
      if (_jwtCallCount <= 3) {
        const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        console.log(`[JWT-OK] #${_jwtCallCount} Signature VERIFIED for sub=${p.sub}`);
      }
    } else {
      // Try normalising both signatures to raw buffers (handles base64 vs base64url)
      const expRaw = crypto.createHmac('sha256', secret).update(signingInput).digest();
      const gotRaw = Buffer.from(gotSig.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - gotSig.length % 4) % 4), 'base64');
      if (expRaw.length !== gotRaw.length || !crypto.timingSafeEqual(expRaw, gotRaw)) {
        _jwtMismatchCount++;
        if (!_jwtDebugLogged) {
          _jwtDebugLogged = true;
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
          console.warn(`[JWT] DIAG: aud=${payload.aud}, iss=${payload.iss}, sub=${payload.sub}, secretLen=${secret.length}, secretStart=${secret.substring(0,4)}..., expected=${expectedSig.substring(0,12)}..., got=${gotSig.substring(0,12)}... — Check SHOPIFY_API_SECRET in Render matches Partners dashboard`);
        } else if (_jwtMismatchCount % 100 === 0) {
          console.warn(`[JWT] Signature mismatch x${_jwtMismatchCount} (suppressed — update SHOPIFY_API_SECRET to fix)`);
        }
        return null;
      }
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());

    const now = Math.floor(Date.now() / 1000);
    // Shopify session tokens last ~60s. Allow 2 min grace for clock skew + embedded app reload.
    const EXP_GRACE = 120;
    if (payload.exp && payload.exp + EXP_GRACE < now) {
      if (_jwtCallCount <= 5) {
        console.warn(`[JWT] Token expired — exp=${payload.exp}, now=${now}, diff=${now - payload.exp}s, grace=${EXP_GRACE}s`);
      } else {
        console.warn('[JWT] Token expired');
      }
      return null;
    }
    if (payload.nbf && payload.nbf - EXP_GRACE > now) {
      console.warn('[JWT] Token not yet valid');
      return null;
    }
    if (payload.aud && payload.aud !== process.env.SHOPIFY_API_KEY) {
      console.warn('[JWT] Audience mismatch');
      return null;
    }

    return payload;
  } catch (err) {
    console.warn('[JWT] Verification error:', err.message);
    return null;
  }
}

export function emailFromIdToken(token) {
  // Only trust signature-verified payloads
  const payload = verifySessionToken(token);
  if (payload) {
    if (payload.email) return payload.email;
    if (payload.sub && userEmailCache[payload.sub]) return userEmailCache[payload.sub];
  }
  // Never decode JWT without verification — an attacker could forge a sub claim
  return null;
}

export function attachUserRole(req, res, next) {
  const idToken = req.headers['x-shopify-id-token']
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);
  const jwtEmail = emailFromIdToken(idToken);

  // Only trust X-GCW-User-Email header if JWT already verified the user.
  // Without this guard, an attacker could spoof the header with a known admin email.
  const email = jwtEmail || null;
  req.userEmail = email;
  req.userRole  = getUserRole(email);
  next();
}

function requireRole(minLevel) {
  return (req, res, next) => {
    if (!hasPermission(req.userRole, minLevel)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions' });
    }
    next();
  };
}

export const requireViewer  = requireRole(1);
export const requireBuilder = requireRole(2);
export const requireAdmin   = requireRole(3);
