import { readFileSync, writeFileSync, existsSync, chmodSync } from 'fs';
import { resolve } from 'path';
import crypto from 'crypto';
import { __dirname, DEFAULT_SHOP } from './config.js';

const SESSION_FILE = resolve(__dirname, '../.sessions.json');

// Encryption for session file at rest
const SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY || null;
const ALGORITHM = 'aes-256-gcm';

function encryptData(plaintext) {
  if (!SESSION_ENCRYPTION_KEY) return plaintext;
  const key = crypto.scryptSync(SESSION_ENCRYPTION_KEY, 'gcw-session-salt', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return JSON.stringify({ iv: iv.toString('hex'), tag, data: encrypted });
}

function decryptData(ciphertext) {
  if (!SESSION_ENCRYPTION_KEY) return ciphertext;
  try {
    const { iv, tag, data } = JSON.parse(ciphertext);
    if (!iv || !tag || !data) return ciphertext; // Not encrypted, return as-is
    const key = crypto.scryptSync(SESSION_ENCRYPTION_KEY, 'gcw-session-salt', 32);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // If decryption fails, file may be unencrypted (migration); return as-is
    return ciphertext;
  }
}

function loadSessions() {
  try {
    if (existsSync(SESSION_FILE)) {
      const raw = readFileSync(SESSION_FILE, 'utf8');
      const decrypted = decryptData(raw);
      return JSON.parse(decrypted);
    }
  } catch (err) {
    console.warn('[Sessions] Failed to load session file, starting fresh:', err.message);
  }
  return {};
}

export function persistSessions() {
  try {
    const json = JSON.stringify(shopSessions, null, 2);
    const output = encryptData(json);
    writeFileSync(SESSION_FILE, output, { encoding: 'utf8', mode: 0o600 });
    // Also set permissions explicitly for existing files
    try { chmodSync(SESSION_FILE, 0o600); } catch {}
  } catch (err) {
    console.error('[Sessions] Failed to persist sessions:', err.message);
  }
}

if (!SESSION_ENCRYPTION_KEY) {
  console.warn('[Sessions] WARNING: SESSION_ENCRYPTION_KEY not set — session file will NOT be encrypted at rest. Set this env var in production.');
}

export const shopSessions = loadSessions();

// A real Admin API access token starts with shpat_ (or legacy shppa_/shpca_).
// An API *secret* starts with shpss_ — a common copy/paste mistake that must
// never be used as a token, or every request 401s with "Invalid API key or
// access token".
export function isUsableAccessToken(token) {
  return typeof token === 'string' && /^shp(at|pa|ca)_/.test(token.trim());
}

const ENV_DEFAULT_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const ENV_PROD_TOKEN = process.env.SHOPIFY_PROD_ACCESS_TOKEN;

if (ENV_DEFAULT_TOKEN && !isUsableAccessToken(ENV_DEFAULT_TOKEN)) {
  console.warn(
    `[Startup] SHOPIFY_ACCESS_TOKEN does not look like an access token (expected shpat_…, got "${ENV_DEFAULT_TOKEN.slice(0, 6)}…"). Ignoring it.`,
  );
}
if (ENV_PROD_TOKEN && !isUsableAccessToken(ENV_PROD_TOKEN)) {
  console.warn(
    `[Startup] SHOPIFY_PROD_ACCESS_TOKEN does not look like an access token (expected shpat_…, got "${ENV_PROD_TOKEN.slice(0, 6)}…"). Falling back to SHOPIFY_ACCESS_TOKEN.`,
  );
}

// Pre-seed session from env var so the app works immediately after restart
if (isUsableAccessToken(ENV_DEFAULT_TOKEN)) {
  shopSessions[DEFAULT_SHOP] = {
    accessToken: ENV_DEFAULT_TOKEN,
    scope: 'write_discounts,read_discounts',
    shop: DEFAULT_SHOP,
    installedAt: 'env-var-seed',
  };
  console.log(`[Startup] Pre-seeded session for ${DEFAULT_SHOP}`);
}

// Pre-seed production store if configured. Prefer the dedicated prod token, but
// fall back to SHOPIFY_ACCESS_TOKEN when prod token is missing/invalid so a
// single misplaced value can't take prod down.
const PROD_SHOP = process.env.SHOPIFY_PROD_SHOP_DOMAIN;
const PROD_TOKEN = isUsableAccessToken(ENV_PROD_TOKEN)
  ? ENV_PROD_TOKEN
  : isUsableAccessToken(ENV_DEFAULT_TOKEN)
    ? ENV_DEFAULT_TOKEN
    : null;
if (PROD_SHOP && PROD_TOKEN) {
  shopSessions[PROD_SHOP] = {
    accessToken: PROD_TOKEN,
    scope: 'write_discounts,read_discounts',
    shop: PROD_SHOP,
    installedAt: 'env-var-seed-prod',
  };
  console.log(`[Startup] Pre-seeded session for ${PROD_SHOP} (production)`);
}

persistSessions();

// Runtime fallback that survives even if shopSessions is cleared
let runtimeAccessToken = process.env.SHOPIFY_ACCESS_TOKEN || null;

export function setRuntimeAccessToken(token) {
  runtimeAccessToken = token;
}

export function getAccessToken(shop) {
  // Use the session token only if it actually looks like an access token.
  const sessionToken = shopSessions[shop]?.accessToken;
  if (isUsableAccessToken(sessionToken)) return sessionToken;

  // Env-var fallback for known shops — return the first value that is a real
  // access token, skipping anything misconfigured (e.g. an API secret).
  const candidates = [];
  if (shop === DEFAULT_SHOP) {
    candidates.push(runtimeAccessToken, process.env.SHOPIFY_ACCESS_TOKEN);
  }
  if (shop === process.env.SHOPIFY_PROD_SHOP_DOMAIN) {
    candidates.push(
      process.env.SHOPIFY_PROD_ACCESS_TOKEN,
      process.env.SHOPIFY_ACCESS_TOKEN,
    );
  }
  for (const candidate of candidates) {
    if (isUsableAccessToken(candidate)) return candidate;
  }
  return null;
}
