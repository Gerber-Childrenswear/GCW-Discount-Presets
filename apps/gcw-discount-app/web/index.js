import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';

// Shared modules
import { PORT, SHOPIFY_API_VERSION, appUrl, hostName, hostScheme, DEFAULT_SHOP } from './config.js';
import { makeGqlClient } from './graphql-client.js';
import { errorLog, reportError, ERROR_LOG_MAX } from './error-logger.js';
import {
  shopSessions, persistSessions, getAccessToken, setRuntimeAccessToken,
} from './session-store.js';
import {
  ROLES, userRoles, seedRolesFromEnv, getUserRole, hasPermission,
  verifySessionToken, emailFromIdToken, attachUserRole,
  requireViewer, requireBuilder, requireAdmin,
} from './rbac.js';
import { verifyHmac } from './security.js';
import {
  isValidShopDomain, resolveShopifyAccess, getOrExchangeToken, exchangeToken,
  autoActivateDiscounts, autoActivateAsFunction, autoActivateAsBasic, setDiscountMetafield,
} from './shopify-utils.js';
import {
  AVAILABLE_FUNCTION_TAGS, AVAILABLE_BXGY_TAGS, validateTags, AVAILABLE_FUNCTION_VENDORS,
} from './tag-validation.js';
import { discountsStore, registerDiscount, unregisterDiscount, getRegisteredGids } from './discount-store.js';

// Route modules
import authRouter from './routes/auth.js';
import webhooksRouter from './routes/webhooks.js';
import rolesRouter from './routes/roles.js';
import discountStoreRouter from './routes/discount-store.js';

let runtimeAccessToken = process.env.SHOPIFY_ACCESS_TOKEN || null;

const app = express();

seedRolesFromEnv();

// Request timing middleware
app.use((req, res, next) => {
  req._startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - req._startTime;
    if (duration > 5000) {
      console.warn(`[Slow Request] ${req.method} ${req.path} took ${duration}ms`);
      reportError(new Error(`Slow request: ${req.method} ${req.path} (${duration}ms)`), { area: 'performance', method: req.method, path: req.path, duration });
    }
  });
  next();
});

// Rate limiter (sliding window)
const rateLimitStore = {};
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 300; // max requests per window per IP
const RATE_LIMIT_MAX_KEYS = 10000; // max tracked IPs before forced eviction
function rateLimit(req, res, next) {
  // Skip rate limiting for static assets
  if (req.path.startsWith('/gcw-logo') || req.path.endsWith('.svg') || req.path.endsWith('.ico')) return next();
  const key = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rateLimitStore[key]) rateLimitStore[key] = [];
  rateLimitStore[key] = rateLimitStore[key].filter(ts => now - ts < RATE_LIMIT_WINDOW);
  if (rateLimitStore[key].length >= RATE_LIMIT_MAX) {
    res.set('Retry-After', '60');
    return res.status(429).json({ success: false, error: 'Too many requests. Please try again later.' });
  }
  rateLimitStore[key].push(now);
  // Evict oldest entries if we exceed max tracked IPs
  const keys = Object.keys(rateLimitStore);
  if (keys.length > RATE_LIMIT_MAX_KEYS) {
    const oldest = keys.sort((a, b) => (rateLimitStore[a][0] || 0) - (rateLimitStore[b][0] || 0));
    for (let i = 0; i < keys.length - RATE_LIMIT_MAX_KEYS; i++) {
      delete rateLimitStore[oldest[i]];
    }
  }
  next();
}
// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const key of Object.keys(rateLimitStore)) {
    rateLimitStore[key] = rateLimitStore[key].filter(ts => now - ts < RATE_LIMIT_WINDOW);
    if (rateLimitStore[key].length === 0) delete rateLimitStore[key];
  }
  for (const key of Object.keys(heavyRateLimitStore)) {
    heavyRateLimitStore[key] = heavyRateLimitStore[key].filter(ts => now - ts < 60000);
    if (heavyRateLimitStore[key].length === 0) delete heavyRateLimitStore[key];
  }
}, 300000);
app.use(rateLimit);

// Stricter per-user rate limiter for expensive endpoints (GraphQL searches, deploys)
const heavyRateLimitStore = {};
function heavyRateLimit(maxPerMinute) {
  return (req, res, next) => {
    const key = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    if (!heavyRateLimitStore[key]) heavyRateLimitStore[key] = [];
    heavyRateLimitStore[key] = heavyRateLimitStore[key].filter(ts => now - ts < 60000);
    if (heavyRateLimitStore[key].length >= maxPerMinute) {
      res.set('Retry-After', '60');
      return res.status(429).json({ success: false, error: 'Rate limit exceeded for this endpoint. Please wait.' });
    }
    heavyRateLimitStore[key].push(now);
    next();
  };
}

// Handle empty POST bodies with Content-Type: application/json gracefully
// (prevents body-parser from returning 400 on JSON.parse(''))
app.use((req, res, next) => {
  const cl = req.headers['content-length'];
  if (req.method !== 'GET' && req.method !== 'HEAD' && cl === '0' &&
      req.headers['content-type']?.includes('application/json')) {
    req.body = {};
    return next();
  }
  next();
});
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => {
    // Preserve raw bytes for webhook HMAC verification
    if (req.url === '/api/webhooks' || req.url.startsWith('/api/webhooks/')) {
      req.rawBody = buf;
    }
  },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Add headers for Shopify iframe embedding + security hardening
app.use((req, res, next) => {
  // Use Content-Security-Policy frame-ancestors (replaces deprecated X-Frame-Options)
  // Per Shopify embedded app docs: allow Shopify Admin + the shop domain
  const shop = req.query.shop || DEFAULT_SHOP;
  const shopOrigin = `https://${shop.replace(/[^a-zA-Z0-9.\-]/g, '')}`;
  res.header(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.shopify.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https: data:; connect-src 'self' https://*.shopify.com https://*.myshopify.com; frame-ancestors https://admin.shopify.com ${shopOrigin}`
  );
  // Security best-practice headers (Shopify 2025-07 guidelines)
  res.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-DNS-Prefetch-Control', 'off');
  res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Restrict CORS to Shopify domains in production
  const allowedOrigins = process.env.NODE_ENV === 'production' 
    ? ['https://admin.shopify.com', `https://${DEFAULT_SHOP}`]
    : ['http://localhost:8081', 'http://localhost:3000', '*'];
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Shopify-Id-Token, X-Shopify-Shop, X-GCW-User-Email');
  next();
});

// Attach user role to every request
app.use(attachUserRole);

app.use(express.static('public'));

// Diagnostic endpoint - admin only (never expose credentials to unauthenticated users)
app.get('/api/diagnostics', requireAdmin, (req, res) => {
  const installedShops = Object.keys(shopSessions).filter(k => !k.startsWith('nonce_'));
  res.json({
    environment: {
      PORT,
      NODE_ENV: process.env.NODE_ENV,
      SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL,
    },
    shopify_config: {
      appUrl,
      hostName,
      hostScheme,
      callbackUrl: `${hostScheme}://${hostName}/api/auth/callback`,
      apiKey: process.env.SHOPIFY_API_KEY?.substring(0, 12) + '...',
      scopes: 'write_discounts,read_discounts',
    },
    sessions: {
      installedShops,
      hasAccessToken: installedShops.map(s => ({ shop: s, hasToken: !!shopSessions[s]?.accessToken, source: shopSessions[s]?.installedAt })),
    },
    runtimeToken: runtimeAccessToken ? 'SET' : 'NOT_SET',
    envToken: process.env.SHOPIFY_ACCESS_TOKEN ? 'SET' : 'NOT_SET',
    discountsCount: Object.keys(discountsStore || {}).length,
    status: process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET ? 'READY' : 'MISSING_CREDENTIALS',
    tip: !process.env.SHOPIFY_ACCESS_TOKEN ? 'Set SHOPIFY_ACCESS_TOKEN env var in Render to persist auth across restarts' : 'Token persisted via env var',
  });
});

// Route modules
app.use(authRouter);
app.use(webhooksRouter);
app.use(rolesRouter);
app.use(discountStoreRouter);

const DISCOUNT_DISCOVERY_SCAN_TTL_MS = Math.max(
  60000,
  Number(process.env.GCW_DISCOUNT_DISCOVERY_SCAN_TTL_MS || (15 * 60 * 1000))
);
const DISCOUNT_DISCOVERY_RECOVERY_STATUSES = ['active', 'scheduled'];
const ACTIVE_FUNCTION_STATUSES = new Set(['ACTIVE', 'SCHEDULED']);

function getDiscountDiscoveryScanCache() {
  if (!globalThis.__gcwDiscountDiscoveryScans) {
    globalThis.__gcwDiscountDiscoveryScans = {};
  }
  return globalThis.__gcwDiscountDiscoveryScans;
}

function shouldRunDiscountDiscoveryScan(shop) {
  if (!shop) return true;
  const cache = getDiscountDiscoveryScanCache();
  const entry = cache[shop];
  return !entry || (Date.now() - entry.lastCompletedAt) > DISCOUNT_DISCOVERY_SCAN_TTL_MS;
}

function markDiscountDiscoveryScanComplete(shop, stats = {}) {
  if (!shop) return;
  const cache = getDiscountDiscoveryScanCache();
  cache[shop] = {
    lastCompletedAt: Date.now(),
    stats,
  };
}

function normalizeDiscountLookupText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasKnownDiscountConfig(node) {
  return !!(
    node?.discount_config?.value ||
    node?.shipping_config?.value ||
    node?.tiered_config?.value ||
    node?.bxgy_config?.value
  );
}

function classifyDiscountFunctionSource(fn) {
  const title = normalizeDiscountLookupText(fn?.title);
  const apiType = String(fn?.apiType || '').toLowerCase();

  if (title.includes('shipping')) return 'shipping-function';
  if (title.includes('tiered')) return 'tiered-discount';
  if (title.includes('bxgy') || (title.includes('buy') && title.includes('get'))) return 'bxgy-discount';
  if (title.includes('discountfunction')) return 'function-engine';
  if (title.includes('discount') && !title.includes('shipping') && !title.includes('tiered') && !title.includes('bxgy')) {
    return 'function-engine';
  }
  if (!title && (apiType.includes('delivery') || apiType.includes('shipping'))) return 'shipping-function';

  return null;
}

function inferDiscountSourceFromNode(node, functionSourcesById = new Map()) {
  if (node?.discount_config?.value) return 'function-engine';
  if (node?.shipping_config?.value) return 'shipping-function';
  if (node?.tiered_config?.value) return 'tiered-discount';
  if (node?.bxgy_config?.value) return 'bxgy-discount';

  const functionId = node?.discount?.appDiscountType?.functionId;
  if (functionId && functionSourcesById.has(functionId)) {
    return functionSourcesById.get(functionId);
  }

  const title = normalizeDiscountLookupText(node?.discount?.title);
  if (title.includes('freeshipping')) return 'shipping-function';

  return null;
}

async function assertAppManagedDiscountForDelete(shop, accessToken, discountId, expectedKeys = []) {
  const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const callGql = makeGqlClient(graphqlUrl, accessToken);
  const checkResp = await callGql(
    `query checkDeleteTarget($id: ID!) {
      discountNode(id: $id) {
        id
        discountConfig: metafield(namespace: "gcw", key: "discount_config") { value }
        shippingConfig: metafield(namespace: "gcw", key: "shipping_config") { value }
        tieredConfig: metafield(namespace: "gcw", key: "tiered_config") { value }
        bxgyConfig: metafield(namespace: "gcw", key: "bxgy_config") { value }
      }
    }`,
    { id: discountId }
  );

  if (!checkResp.ok) {
    return { ok: false, status: 400, error: 'Unable to validate discount before delete.' };
  }

  const node = checkResp.result?.data?.discountNode;
  if (!node) {
    return { ok: false, status: 404, error: 'Discount not found.' };
  }

  const keyToAlias = {
    discount_config: 'discountConfig',
    shipping_config: 'shippingConfig',
    tiered_config: 'tieredConfig',
    bxgy_config: 'bxgyConfig',
  };

  const appManagedKeys = Object.keys(keyToAlias).filter((key) => {
    const alias = keyToAlias[key];
    return !!node?.[alias]?.value;
  });

  if (appManagedKeys.length === 0) {
    return { ok: false, status: 403, error: 'Refusing to delete non-app-managed discount.' };
  }

  if (expectedKeys.length > 0 && !expectedKeys.some(k => appManagedKeys.includes(k))) {
    return { ok: false, status: 403, error: 'Refusing to delete discount from a different discount engine.' };
  }

  return { ok: true, appManagedKeys };
}

app.post('/api/function-engine/deploy', requireAdmin, heavyRateLimit(5), async (req, res) => {
  try {
    const {
      title, percentage, message, included_tags, exclude_tags,
      included_vendors, exclude_product_types, exclude_vendors, exclude_gift_cards,
      starts_at, ends_at, combines_with_order, combines_with_product, combines_with_shipping,
      allowed_code_prefixes,
    } = req.body;

    if (!title || !percentage) {
      return res.status(400).json({ error: 'Title and percentage are required.' });
    }

    const pctNum = Number(percentage);
    if (!Number.isFinite(pctNum) || pctNum <= 0 || pctNum > 100) {
      return res.status(400).json({ error: 'Percentage must be a number between 0.01 and 100.' });
    }

    // Validate tags — warn if any aren't in the function's hasTags() list
    const allSubmittedTags = [
      ...(Array.isArray(included_tags) ? included_tags : (included_tags ? String(included_tags).split(',') : [])),
      ...(Array.isArray(exclude_tags) ? exclude_tags : (exclude_tags ? String(exclude_tags).split(',') : [])),
    ].map(t => t.trim()).filter(Boolean);
    const tagCheck = validateTags(allSubmittedTags);
    const tagWarnings = tagCheck.warnings || [];

    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) {
      return res.status(401).json({ error: 'Missing shop or access token.' });
    }

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const callGql = makeGqlClient(graphqlUrl, accessToken);

    // 1. Find the deployed PRODUCT discount function (gcw-discount-function)
    const fnResp = await callGql(`query { shopifyFunctions(first: 50) { nodes { id apiType title } } }`);
    if (!fnResp.ok) return res.status(400).json({ error: 'Cannot query functions', details: fnResp.error });
    const fns = fnResp.result.data?.shopifyFunctions?.nodes || [];
    console.log('[FunctionEngine] Available functions:', fns.map(f => `${f.title} (${f.apiType})`).join(', '));
    const isDiscount = (f) => f.apiType && f.apiType.toLowerCase().includes('discount');
    // Prefer exact match on "gcw-discount-function", then fallback to title containing "discount" (but NOT "shipping")
    const fn = fns.find(f => isDiscount(f) && (f.title || '').toLowerCase() === 'gcw-discount-function')
            || fns.find(f => isDiscount(f) && (f.title || '').toLowerCase().includes('discount') && !(f.title || '').toLowerCase().includes('shipping'))
            || null;
    if (!fn) return res.status(400).json({ error: 'No deployed product discount function found. Run "shopify app deploy" first.' });

    // Delete any existing discount with the same title to avoid uniqueness errors
    // Paginate through ALL automatic discounts to find title matches
    let allFeDupeNodes = [];
    let feDupeCursor = null;
    for (let page = 0; page < 5; page++) {
      const afterClause = feDupeCursor ? `, after: "${feDupeCursor}"` : '';
      const dupeSearch = await callGql(`query { discountNodes(first: 50${afterClause}) { nodes { id discount { ... on DiscountAutomaticApp { title } ... on DiscountAutomaticBasic { title } } } pageInfo { hasNextPage endCursor } } }`);
      if (!dupeSearch.ok) break;
      const nodes = dupeSearch.result.data?.discountNodes?.nodes || [];
      allFeDupeNodes = allFeDupeNodes.concat(nodes);
      const pi = dupeSearch.result.data?.discountNodes?.pageInfo;
      if (!pi?.hasNextPage) break;
      feDupeCursor = pi.endCursor;
    }
    const feNormalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const feNormalizedTitle = feNormalize(title);
    const existing = allFeDupeNodes.filter(n => {
      const t = n.discount?.title;
      return t === title || feNormalize(t) === feNormalizedTitle;
    });
    console.log(`[FunctionEngine] Scanned ${allFeDupeNodes.length} automatic discounts, found ${existing.length} with title "${title}"`);
    if (existing.length) {
      console.log('[FunctionEngine] Duplicate-title auto-delete is disabled for safety; keeping existing discounts unchanged.');
    }

    // Allow Shopify time to propagate deletions
    let finalFeTitle = title + ' #' + Date.now().toString(36).slice(-4);

    // 2. Build the config metafield
    const functionConfig = {
      percentage: pctNum,
      message: message || `Extra ${pctNum}% Off Applied!`,
      exclude_gift_cards: exclude_gift_cards !== false,
      included_tags: Array.isArray(included_tags) ? included_tags : (included_tags ? String(included_tags).split(',').map(t => t.trim()).filter(Boolean) : []),
      exclude_tags: Array.isArray(exclude_tags) ? exclude_tags : (exclude_tags ? String(exclude_tags).split(',').map(t => t.trim()).filter(Boolean) : []),
      included_vendors: Array.isArray(included_vendors) ? included_vendors : (included_vendors ? String(included_vendors).split(',').map(t => t.trim()).filter(Boolean) : []),
      exclude_product_types: Array.isArray(exclude_product_types) ? exclude_product_types : (exclude_product_types ? String(exclude_product_types).split(',').map(t => t.trim()).filter(Boolean) : []),
      exclude_vendors: Array.isArray(exclude_vendors) ? exclude_vendors : (exclude_vendors ? String(exclude_vendors).split(',').map(t => t.trim()).filter(Boolean) : []),
      exclude_product_ids: [],
      allowed_code_prefixes: Array.isArray(allowed_code_prefixes) ? allowed_code_prefixes : [],
    };

    const startsAt = starts_at ? new Date(starts_at).toISOString() : new Date().toISOString();
    const endsAt = ends_at ? new Date(ends_at).toISOString() : null;

    // 3. Create automatic app discount with metafield
    const createMut = `
      mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { discountId title status }
          userErrors { field message }
        }
      }`;

    const buildFeVars = (discountTitle) => ({
      automaticAppDiscount: {
        title: discountTitle,
        functionId: fn.id,
        startsAt,
        endsAt,
        discountClasses: ['PRODUCT'],
        combinesWith: {
          orderDiscounts: !!combines_with_order,
          productDiscounts: !!combines_with_product,
          shippingDiscounts: !!combines_with_shipping,
        },
        metafields: [{
          namespace: 'gcw',
          key: 'discount_config',
          type: 'json',
          value: JSON.stringify(functionConfig),
        }],
      },
    });

    // Try with original title first; if uniqueness error, retry with a timestamp suffix
    let createResp = await callGql(createMut, buildFeVars(finalFeTitle));
    let createData = createResp.ok ? createResp.result.data?.discountAutomaticAppCreate : null;
    const hasFeTitleError = createData?.userErrors?.some(e => e.message && e.message.toLowerCase().includes('title must be unique'));
    if (hasFeTitleError) {
      console.warn(`[FunctionEngine] Title "${finalFeTitle}" still conflicts — retrying with random suffix`);
      finalFeTitle = title + ' #' + Math.random().toString(36).slice(2, 8);
      createResp = await callGql(createMut, buildFeVars(finalFeTitle));
      createData = createResp.ok ? createResp.result.data?.discountAutomaticAppCreate : null;
    }
    if (!createResp.ok) return res.status(400).json({ error: createResp.error });
    if (createData?.userErrors?.length) {
      const errMsg = createData.userErrors.map(e => `${e.field ? e.field + ': ' : ''}${e.message}`).join('; ');
      console.error('[FunctionEngine] userErrors:', errMsg);
      return res.status(400).json({ error: errMsg, details: errMsg });
    }

    const disc = createData?.automaticAppDiscount;
    if (disc?.discountId) registerDiscount(disc.discountId, shop, 'function-engine');
    console.log(`[FunctionEngine] Created function discount: ${disc?.title} (${disc?.discountId})`);

    res.json({ success: true, discount: disc, config: functionConfig, warnings: tagWarnings });
  } catch (error) {
    reportError(error, { area: 'function_engine_deploy' });
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// UNIFIED DISCOUNT LIST — single paginated query for ALL discount types
// Uses GraphQL field aliases to fetch all 4 metafield keys in one pass.
// Reduces Shopify API calls from ~20 (4 endpoints × 5 pages) to ~5 (1 endpoint × 5 pages).
// =============================================================================
app.get('/api/discounts/list-all', requireViewer, heavyRateLimit(15), async (req, res) => {
  try {
    const startTime = Date.now();
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

    const parseConfig = (raw) => {
      if (!raw?.value) return { hasValue: false, invalid: false, config: {} };
      try {
        return { hasValue: true, invalid: false, config: JSON.parse(raw.value) };
      } catch {
        return { hasValue: true, invalid: true, config: {} };
      }
    };

    const gql = async (query) => {
      const r = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({ query }),
      });
      return r.json();
    };

    // Keep the fast path focused on app-managed records only:
    // direct registry lookups plus a narrow title search for shipping campaigns.
    const discountNodeFragment = `
      id
      discount {
        ... on DiscountAutomaticApp {
          discountId
          title status startsAt endsAt
          appDiscountType { appKey functionId }
        }
      }
      discount_config: metafield(namespace: "gcw", key: "discount_config") { value }
      shipping_config: metafield(namespace: "gcw", key: "shipping_config") { value }
      tiered_config: metafield(namespace: "gcw", key: "tiered_config") { value }
      bxgy_config: metafield(namespace: "gcw", key: "bxgy_config") { value }
    `;
    const automaticDiscountNodeFragment = `
      id
      discount: automaticDiscount {
        ... on DiscountAutomaticApp {
          discountId
          title status startsAt endsAt
          appDiscountType { appKey functionId }
        }
      }
      discount_config: metafield(namespace: "gcw", key: "discount_config") { value }
      shipping_config: metafield(namespace: "gcw", key: "shipping_config") { value }
      tiered_config: metafield(namespace: "gcw", key: "tiered_config") { value }
      bxgy_config: metafield(namespace: "gcw", key: "bxgy_config") { value }
    `;

    // Known title patterns the app creates:
    // - Shipping: "Free Shipping $XX+" (threshold 10-100)
    // - Function Engine: user-provided title
    // - Tiered: user-provided title
    // - BXGY: user-provided title
    // For user-titled discounts we rely on GID registry (future).
    // For now, search by "Free Shipping" (covers shipping discounts)
    // plus registered GIDs for everything else.
    const registeredGids = getRegisteredGids(shop);
    const requests = [
      gql(`query { shopifyFunctions(first: 50) { nodes { id apiType title } } }`),
      gql(`query { discountNodes(first: 50, query: "Free Shipping") { nodes { ${discountNodeFragment} } } }`),
    ];

    // Also fetch any registered GIDs directly
    if (registeredGids.length > 0) {
      const fragments = registeredGids.map((gid, idx) => `
        n${idx}: node(id: "${gid}") {
          ... on DiscountNode { ${discountNodeFragment} }
          ... on DiscountAutomaticNode { ${automaticDiscountNodeFragment} }
        }
      `).join('\n');
      requests.push(gql(`query { ${fragments} }`));
    }

    const results = await Promise.all(requests);
    const functionNodes = results[0]?.data?.shopifyFunctions?.nodes || [];
    const searchNodes = results[1]?.data?.discountNodes?.nodes || [];
    const registryNodes = registeredGids.length > 0 && results[2]?.data ? results[2].data : null;
    const functionSourcesById = new Map();

    for (const fn of functionNodes) {
      const source = classifyDiscountFunctionSource(fn);
      if (source) {
        functionSourcesById.set(fn.id, source);
      }
    }

    // Merge results, dedup by the underlying automatic discount ID when available.
    const seen = new Set();
    const allNodes = [];
    const addNode = (node) => {
      const dedupeId = node?.discount?.discountId || node?.id;
      if (!dedupeId || seen.has(dedupeId)) return false;
      seen.add(dedupeId);
      allNodes.push(node);
      return true;
    };

    // From title search
    for (const n of searchNodes) {
      addNode(n);
    }

    // From GID registry
    if (registryNodes) {
      for (const key of Object.keys(registryNodes)) {
        const n = registryNodes[key];
        if (n) addNode(n);
      }
    }

    // Hardened recovery scan: supplement partial results and backfill the
    // registry with any active app-managed discounts that the fast path missed.
    const recoveryMeta = { ran: false, queriesRun: 0, recovered: 0 };
    const appKey = process.env.SHOPIFY_API_KEY;
    if (shouldRunDiscountDiscoveryScan(shop) && (functionSourcesById.size > 0 || appKey)) {
      recoveryMeta.ran = true;
      const scans = await Promise.all(
        DISCOUNT_DISCOVERY_RECOVERY_STATUSES.map((status) =>
          gql(`query {
            automaticDiscountNodes(first: 250, sortKey: ID, query: "type:app status:${status}") {
              nodes { ${automaticDiscountNodeFragment} }
            }
          }`)
        )
      );
      recoveryMeta.queriesRun = scans.length;
      for (const scan of scans) {
        const scanNodes = scan?.data?.automaticDiscountNodes?.nodes || [];
        for (const n of scanNodes) {
          const source = inferDiscountSourceFromNode(n, functionSourcesById);
          const functionId = n?.discount?.appDiscountType?.functionId;
          const functionOwned = !!functionId && functionSourcesById.has(functionId);
          const appOwned = !!appKey && n?.discount?.appDiscountType?.appKey === appKey;
          const activeLike = ACTIVE_FUNCTION_STATUSES.has(n?.discount?.status);
          const knownConfig = hasKnownDiscountConfig(n);

          if (!source) continue;
          if (!knownConfig && !activeLike) continue;
          if (!functionOwned && !appOwned) continue;

          const registryId = n?.discount?.discountId || n.id;
          if (registryId) registerDiscount(registryId, shop, source);
          if (addNode(n)) {
            recoveryMeta.recovered += 1;
          }
        }
      }
      markDiscountDiscoveryScanComplete(shop, recoveryMeta);
    }

    const mapNode = (n, configField, source) => {
      const parsed = parseConfig(n[configField]);
      const inferredSource = inferDiscountSourceFromNode(n, functionSourcesById);
      if (inferredSource !== source) return null;
      if (!parsed.hasValue && !ACTIVE_FUNCTION_STATUSES.has(n?.discount?.status)) return null;
      const d = n.discount;
      return {
        id: n.id,
        title: d?.title,
        status: d?.status,
        startsAt: d?.startsAt,
        endsAt: d?.endsAt,
        functionId: d?.appDiscountType?.functionId,
        config: parsed.config,
        configMissing: !parsed.hasValue,
        configInvalid: parsed.invalid,
        _source: source,
      };
    };

    const feDiscounts = allNodes.map(n => mapNode(n, 'discount_config', 'function-engine')).filter(Boolean);
    const sfDiscounts = allNodes.map(n => mapNode(n, 'shipping_config', 'shipping-function')).filter(Boolean);
    const tdDiscounts = allNodes.map(n => mapNode(n, 'tiered_config', 'tiered-discount')).filter(Boolean);
    const bxDiscounts = allNodes.map(n => mapNode(n, 'bxgy_config', 'bxgy-discount')).filter(Boolean);
    const totalFound = feDiscounts.length + sfDiscounts.length + tdDiscounts.length + bxDiscounts.length;

    const elapsed = Date.now() - startTime;
    const listAllKey = `${feDiscounts.length}:${sfDiscounts.length}:${tdDiscounts.length}:${bxDiscounts.length}`;
    if (global._listAllLastKey !== listAllKey) {
      const recoverySummary = recoveryMeta.ran
        ? ` | recovery +${recoveryMeta.recovered} in ${recoveryMeta.pagesScanned} page(s)`
        : '';
      console.log(`[ListAll] Found ${totalFound} app-managed in ${elapsed}ms — FE:${feDiscounts.length} SF:${sfDiscounts.length} TD:${tdDiscounts.length} BX:${bxDiscounts.length}${recoverySummary}`);
      global._listAllLastKey = listAllKey;
    }

    res.json({
      success: true,
      feDiscounts,
      sfDiscounts,
      tdDiscounts,
      bxDiscounts,
      _meta: { found: totalFound, elapsed, recovery: recoveryMeta },
    });
  } catch (error) {
    reportError(error, { area: 'discounts_list_all' });
    res.status(500).json({ error: error.message });
  }
});

// Diagnostic endpoint: raw discount query to debug why discounts don't appear
app.get('/api/discounts/debug-query', requireViewer, heavyRateLimit(10), async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const searchTerm = req.query.q || '';
    const cursor = req.query.cursor || null;

    // Use GraphQL variables to prevent injection
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        query: `query debugQuery($first: Int!, $query: String, $after: String) {
          discountNodes(first: $first, query: $query, after: $after) {
            nodes {
              id
              discount {
                __typename
                ... on DiscountAutomaticApp {
                  title
                  status
                  startsAt
                  endsAt
                  appDiscountType { appKey functionId title }
                }
                ... on DiscountAutomaticBasic {
                  title
                  status
                }
                ... on DiscountAutomaticBxgy {
                  title
                  status
                }
                ... on DiscountAutomaticFreeShipping {
                  title
                  status
                }
                ... on DiscountCodeApp {
                  title
                  status
                  codes(first: 1) { nodes { code } }
                  appDiscountType { appKey functionId title }
                }
                ... on DiscountCodeBasic {
                  title
                  status
                  codes(first: 1) { nodes { code } }
                }
                ... on DiscountCodeBxgy {
                  title
                  status
                  codes(first: 1) { nodes { code } }
                }
                ... on DiscountCodeFreeShipping {
                  title
                  status
                  codes(first: 1) { nodes { code } }
                }
              }
              metafields(first: 10) {
                nodes { namespace key value }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        variables: {
          first: 20,
          query: searchTerm || null,
          after: cursor || null,
        },
      }),
    });

    const result = await response.json();
    res.json({ shop, searchTerm, raw: result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Diagnostic: list ALL automatic discounts (separate Shopify endpoint)
app.get('/api/discounts/debug-automatic', requireViewer, async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    let allNodes = [];
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const afterClause = cursor ? `, after: "${cursor}"` : '';
      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({
          query: `query {
            automaticDiscountNodes(first: 50${afterClause}) {
              nodes {
                id
                automaticDiscount {
                  __typename
                  ... on DiscountAutomaticApp {
                    title
                    status
                    appDiscountType { appKey functionId title }
                  }
                  ... on DiscountAutomaticBasic {
                    title
                    status
                  }
                  ... on DiscountAutomaticBxgy {
                    title
                    status
                  }
                  ... on DiscountAutomaticFreeShipping {
                    title
                    status
                  }
                }
                metafields(first: 10) {
                  nodes { namespace key value }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`
        }),
      });
      const result = await response.json();
      if (result.errors?.length) {
        return res.json({ shop, errors: result.errors, nodesFoundSoFar: allNodes });
      }
      const nodes = result.data?.automaticDiscountNodes?.nodes || [];
      allNodes = allNodes.concat(nodes);
      const pi = result.data?.automaticDiscountNodes?.pageInfo;
      if (!pi?.hasNextPage) break;
      cursor = pi.endCursor;
    }
    res.json({ shop, total: allNodes.length, nodes: allNodes });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Product preview: fetch products matching tags/vendors for builder preview
app.get('/api/products/preview', requireBuilder, async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const tags = (req.query.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    const vendors = (req.query.vendors || '').split(',').map(s => s.trim()).filter(Boolean);

    // Build query filter — if no tags/vendors, return a sample of all active products
    let searchQuery = 'status:ACTIVE';
    if (tags.length > 0 || vendors.length > 0) {
      const parts = [];
      tags.forEach(t => parts.push(`tag:'${t.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`));
      vendors.forEach(v => parts.push(`vendor:'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`));
      searchQuery = '(' + parts.join(' OR ') + ') AND status:ACTIVE';
    }

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        query: `query productPreview($query: String!) {
          products(first: 25, query: $query) {
            nodes {
              id
              title
              vendor
              tags
              status
              productType
              isGiftCard
              featuredImage { url }
              priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
              variants(first: 1) { nodes { id price compareAtPrice } }
            }
            pageInfo { hasNextPage }
          }
        }`,
        variables: { query: searchQuery },
      }),
    });
    const result = await response.json();
    if (result.errors?.length) {
      console.error('[ProductPreview] GraphQL errors:', JSON.stringify(result.errors));
    }
    const products = (result.data?.products?.nodes || []).map(p => ({
      id: p.id,
      title: p.title,
      vendor: p.vendor,
      tags: p.tags,
      status: p.status,
      productType: p.productType || '',
      isGiftCard: p.isGiftCard || false,
      image: p.featuredImage?.url || null,
      price: p.variants?.nodes?.[0]?.price || p.priceRangeV2?.minVariantPrice?.amount || '0',
      compareAtPrice: p.variants?.nodes?.[0]?.compareAtPrice || null,
      currency: p.priceRangeV2?.minVariantPrice?.currencyCode || 'USD',
    }));
    const hasMore = result.data?.products?.pageInfo?.hasNextPage || false;
    res.json({ success: true, products, hasMore });
  } catch (error) {
    reportError(error, { area: 'products_preview' });
    res.status(500).json({ error: error.message });
  }
});

// Product search: type-ahead search by title for discount simulator
app.get('/api/products/search', requireBuilder, heavyRateLimit(20), async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const rawQ = (req.query.q || '').trim();
    if (!rawQ || rawQ.length < 2) return res.json({ success: true, products: [] });
    // Sanitize: strip Shopify search operators, limit length
    const q = rawQ.slice(0, 100).replace(/[\\*:'"]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!q) return res.json({ success: true, products: [] });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        query: `query productSearch($query: String!) {
          products(first: 10, query: $query, sortKey: TITLE) {
            nodes {
              id title vendor tags status productType isGiftCard
              featuredImage { url }
              priceRangeV2 { minVariantPrice { amount currencyCode } }
              variants(first: 1) { nodes { id price compareAtPrice } }
            }
          }
        }`,
        variables: { query: `${q} status:ACTIVE` },
      }),
    });
    const result = await response.json();
    if (result.errors?.length) {
      console.error('[ProductSearch] GraphQL errors:', JSON.stringify(result.errors));
    }
    const products = (result.data?.products?.nodes || []).map(p => ({
      id: p.id,
      title: p.title,
      vendor: p.vendor,
      tags: p.tags,
      status: p.status,
      productType: p.productType || '',
      isGiftCard: p.isGiftCard || false,
      image: p.featuredImage?.url || null,
      price: p.variants?.nodes?.[0]?.price || p.priceRangeV2?.minVariantPrice?.amount || '0',
      compareAtPrice: p.variants?.nodes?.[0]?.compareAtPrice || null,
    }));
    res.json({ success: true, products });
  } catch (error) {
    reportError(error, { area: 'products_search' });
    res.status(500).json({ error: error.message });
  }
});

// Discount Simulator: run eligibility logic server-side against real products
app.post('/api/discount-simulator/simulate', requireBuilder, async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const { config, productIds } = req.body;
    if (!config || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'config and productIds[] required' });
    }
    if (productIds.length > 50) {
      return res.status(400).json({ error: 'Max 50 products per simulation' });
    }

    // Validate product IDs are proper Shopify GIDs
    const validGidPattern = /^gid:\/\/shopify\/Product\/\d+$/;
    const safeIds = productIds.filter(id => typeof id === 'string' && validGidPattern.test(id));
    if (safeIds.length === 0) {
      return res.status(400).json({ error: 'No valid product IDs provided' });
    }

    // Fetch full product details for simulation
    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const resp = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        query: `query simulatorProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id title vendor tags status productType isGiftCard
              featuredImage { url }
              variants(first: 1) { nodes { id price compareAtPrice } }
            }
          }
        }`,
        variables: { ids: safeIds },
      }),
    });
    const gqlResult = await resp.json();
    if (gqlResult.errors?.length) {
      console.error('[Simulator] GraphQL errors:', JSON.stringify(gqlResult.errors));
    }
    const products = (gqlResult.data?.nodes || []).filter(Boolean);

    // Run eligibility logic (mirrors the WASM function logic)
    const pct = parseFloat(config.percentage) || 0;
    const includedTags = (config.included_tags || []).map(t => t.toLowerCase());
    const excludeTags = (config.exclude_tags || []).map(t => t.toLowerCase());
    const includedVendors = (config.included_vendors || []).map(v => v.toLowerCase());
    const excludeVendors = (config.exclude_vendors || []).map(v => v.toLowerCase());
    const excludeTypes = (config.exclude_product_types || []).map(t => t.toLowerCase().trim()).filter(Boolean);
    const excludeGC = config.exclude_gift_cards !== false;

    const results = products.map(p => {
      const price = parseFloat(p.variants?.nodes?.[0]?.price) || 0;
      const compareAt = parseFloat(p.variants?.nodes?.[0]?.compareAtPrice) || null;
      const pTags = (p.tags || []).map(t => t.toLowerCase());
      const pVendor = (p.vendor || '').toLowerCase();
      const pType = (p.productType || '').toLowerCase();
      const reasons = [];
      let eligible = true;

      // 1. Gift card check
      if (excludeGC && p.isGiftCard) {
        eligible = false;
        reasons.push({ rule: 'Gift Card', pass: false, detail: 'Gift cards are excluded' });
      } else if (p.isGiftCard) {
        reasons.push({ rule: 'Gift Card', pass: true, detail: 'Gift card (not excluded)' });
      }

      // 2. Included tags check (must match at least one if specified)
      if (includedTags.length > 0) {
        const matched = includedTags.filter(t => pTags.includes(t));
        if (matched.length > 0) {
          reasons.push({ rule: 'Included Tags', pass: true, detail: 'Matches: ' + matched.join(', ') });
        } else {
          eligible = false;
          reasons.push({ rule: 'Included Tags', pass: false, detail: 'No matching tags (needs: ' + includedTags.join(', ') + ')' });
        }
      }

      // 3. Included vendors check (must match at least one if specified — independent of tags)
      if (includedVendors.length > 0) {
        if (includedVendors.includes(pVendor)) {
          reasons.push({ rule: 'Included Vendors', pass: true, detail: 'Vendor "' + p.vendor + '" is included' });
        } else {
          eligible = false;
          reasons.push({ rule: 'Included Vendors', pass: false, detail: 'Vendor "' + p.vendor + '" not in: ' + includedVendors.join(', ') });
        }
      }

      // 4. Exclude tags check
      if (excludeTags.length > 0) {
        const excluded = excludeTags.filter(t => pTags.includes(t));
        if (excluded.length > 0) {
          eligible = false;
          reasons.push({ rule: 'Excluded Tags', pass: false, detail: 'Has excluded tag: ' + excluded.join(', ') });
        } else {
          reasons.push({ rule: 'Excluded Tags', pass: true, detail: 'No excluded tags found' });
        }
      }

      // 5. Exclude vendors check
      if (excludeVendors.length > 0) {
        if (excludeVendors.includes(pVendor)) {
          eligible = false;
          reasons.push({ rule: 'Excluded Vendors', pass: false, detail: 'Vendor "' + p.vendor + '" is excluded' });
        } else {
          reasons.push({ rule: 'Excluded Vendors', pass: true, detail: 'Vendor not excluded' });
        }
      }

      // 6. Exclude product types check
      if (excludeTypes.length > 0) {
        if (excludeTypes.includes(pType)) {
          eligible = false;
          reasons.push({ rule: 'Product Type', pass: false, detail: 'Type "' + (p.productType || 'none') + '" is excluded' });
        } else {
          reasons.push({ rule: 'Product Type', pass: true, detail: 'Type "' + (p.productType || 'none') + '" is allowed' });
        }
      }

      const discount = eligible ? +(price * pct / 100).toFixed(2) : 0;
      const finalPrice = eligible ? +(price - discount).toFixed(2) : price;

      return {
        id: p.id,
        title: p.title,
        vendor: p.vendor,
        tags: p.tags,
        productType: p.productType,
        isGiftCard: p.isGiftCard,
        image: p.featuredImage?.url || null,
        price,
        compareAtPrice: compareAt,
        eligible,
        reasons,
        discount,
        finalPrice,
      };
    });

    const eligibleCount = results.filter(r => r.eligible).length;
    const totalSavings = results.reduce((sum, r) => sum + r.discount, 0);

    res.json({
      success: true,
      results,
      summary: {
        total: results.length,
        eligible: eligibleCount,
        excluded: results.length - eligibleCount,
        percentage: Math.min(Math.max(pct, 0), 100),
        totalSavings: +(totalSavings || 0).toFixed(2),
      },
    });
  } catch (error) {
    reportError(error, { area: 'discount_simulator' });
    res.status(500).json({ error: error.message });
  }
});

// List all automatic app discounts created by this app (legacy, kept for direct access)
app.get('/api/function-engine/list', requireViewer, async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    // Paginate through ALL automatic discounts (up to 250)
    let allNodes = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const afterClause = cursor ? `, after: "${cursor}"` : '';
      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({
          query: `query {
            discountNodes(first: 50${afterClause}) {
              nodes {
                id
                discount {
                  ... on DiscountAutomaticApp {
                    title
                    status
                    startsAt
                    endsAt
                    discountId
                    appDiscountType { appKey functionId }
                  }
                }
                metafield(namespace: "gcw", key: "discount_config") { value }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`
        }),
      });

      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch {
        console.error('[FE List] Non-JSON from Shopify on page', page);
        break;
      }

      const nodes = result.data?.discountNodes?.nodes || [];
      allNodes = allNodes.concat(nodes);
      const pi = result.data?.discountNodes?.pageInfo;
      if (!pi?.hasNextPage) break;
      cursor = pi.endCursor;
    }

    // Filter to only PRODUCT function discounts (must have discount_config metafield)
    const functionDiscounts = allNodes
      .filter(n => n.metafield?.value)
      .map(n => {
        let config = {};
        try { config = JSON.parse(n.metafield?.value || '{}'); } catch {}
        return {
          id: n.id,
          discountId: n.discount?.discountId,
          title: n.discount?.title,
          status: n.discount?.status,
          startsAt: n.discount?.startsAt,
          endsAt: n.discount?.endsAt,
          functionId: n.discount?.appDiscountType?.functionId,
          config,
        };
      });

    // Only log FE list details when results change
    const feKey = `${allNodes.length}:${functionDiscounts.length}`;
    if (global._feListLastKey !== feKey) {
      console.log(`[FE List] Scanned ${allNodes.length}, found ${functionDiscounts.length} product function discounts:`, functionDiscounts.map(d => `"${d.title}" (${d.status})`).join(', '));
      global._feListLastKey = feKey;
    }
    res.json({ success: true, discounts: functionDiscounts });
  } catch (error) {
    reportError(error, { area: 'function_engine_list' });
    res.status(500).json({ error: error.message });
  }
});

// Delete a function discount — ADMIN ONLY
app.delete('/api/function-engine/:discountId', requireAdmin, async (req, res) => {
  try {
    const { discountId } = req.params;
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const deleteGuard = await assertAppManagedDiscountForDelete(shop, accessToken, discountId, ['discount_config']);
    if (!deleteGuard.ok) {
      return res.status(deleteGuard.status).json({ error: deleteGuard.error });
    }

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        query: `mutation discountAutomaticDelete($id: ID!) {
          discountAutomaticDelete(id: $id) {
            deletedAutomaticDiscountId
            userErrors { field message }
          }
        }`,
        variables: { id: discountId },
      }),
    });

    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch {
      return res.status(502).json({ error: 'Non-JSON from Shopify' });
    }

    const data = result.data?.discountAutomaticDelete;
    if (data?.userErrors?.length) return res.status(400).json({ error: data.userErrors[0].message });

    unregisterDiscount(discountId);
    console.log(`[FunctionEngine] Deleted discount: ${discountId}`);
    res.json({ success: true, deletedId: data?.deletedAutomaticDiscountId });
  } catch (error) {
    reportError(error, { area: 'function_engine_delete' });
    res.status(500).json({ error: error.message });
  }
});

// Fetch real product tags from Shopify (cached per-shop, 5 min TTL)
const _productTagsCache = {}; // { [shop]: { tags: [], ts: 0 } }
const PRODUCT_TAGS_TTL = 300000; // 5 minutes

async function fetchShopifyProductTags(shop, accessToken, forceRefresh = false) {
  const cached = _productTagsCache[shop];
  if (!forceRefresh && cached && Date.now() - cached.ts < PRODUCT_TAGS_TTL && cached.tags.length > 0) {
    return cached.tags;
  }
  const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  try {
    // Shopify can have more than 250 tags; page through all results so new tags are not dropped.
    const allTags = new Set();
    let hasNextPage = true;
    let cursor = null;
    let pageCount = 0;

    while (hasNextPage && pageCount < 20) {
      pageCount += 1;
      const afterPart = cursor ? `, after: \"${cursor}\"` : '';
      const query = `query { productTags(first: 250${afterPart}) { edges { node } pageInfo { hasNextPage endCursor } } }`;

      const resp = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({ query }),
      });
      const json = await resp.json();

      const edges = json.data?.productTags?.edges || [];
      for (const edge of edges) {
        const tag = edge?.node;
        if (tag) allTags.add(tag);
      }

      const pageInfo = json.data?.productTags?.pageInfo;
      hasNextPage = !!pageInfo?.hasNextPage;
      cursor = pageInfo?.endCursor || null;
    }

    const tags = Array.from(allTags).sort();
    if (tags.length > 0) {
      _productTagsCache[shop] = { tags, ts: Date.now() };
    }
    return tags.length > 0 ? tags : AVAILABLE_FUNCTION_TAGS;
  } catch (err) {
    console.error('[ProductTags] Error fetching from Shopify:', err.message);
    const fallback = _productTagsCache[shop];
    return fallback?.tags?.length > 0 ? fallback.tags : AVAILABLE_FUNCTION_TAGS;
  }
}

// Product tags endpoint — returns real Shopify tags with fallback to static list
app.get('/api/product-tags', requireViewer, resolveShopifyAccess, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const tags = await fetchShopifyProductTags(req.shopifyShop, req.shopifyAccessToken, forceRefresh);
    res.json({ success: true, tags });
  } catch (err) {
    res.json({ success: true, tags: AVAILABLE_FUNCTION_TAGS });
  }
});

// Available tags endpoint (so the UI can stay in sync)
app.get('/api/function-engine/available-tags', requireViewer, resolveShopifyAccess, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const tags = await fetchShopifyProductTags(req.shopifyShop, req.shopifyAccessToken, forceRefresh);
    res.json({ success: true, tags });
  } catch (err) {
    res.json({ success: true, tags: AVAILABLE_FUNCTION_TAGS });
  }
});

// Available vendors endpoint
app.get('/api/function-engine/available-vendors', requireViewer, (req, res) => {
  res.json({ success: true, vendors: AVAILABLE_FUNCTION_VENDORS });
});

// =============================================================================
// SHARED: Toggle discount status (activate / deactivate) — works for both
// product and shipping function discounts
// =============================================================================
app.post('/api/deployed-discount/:discountNodeId/toggle-status', requireAdmin, async (req, res) => {
  try {
    const { discountNodeId } = req.params;
    const { action } = req.body; // 'activate' | 'deactivate'
    if (!['activate', 'deactivate'].includes(action)) {
      return res.status(400).json({ error: 'action must be "activate" or "deactivate"' });
    }

    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const mutation = action === 'activate'
      ? `mutation discountAutomaticActivate($id: ID!) {
           discountAutomaticActivate(id: $id) {
             automaticDiscountNode { id automaticDiscount { ... on DiscountAutomaticApp { status } } }
             userErrors { field message }
           }
         }`
      : `mutation discountAutomaticDeactivate($id: ID!) {
           discountAutomaticDeactivate(id: $id) {
             automaticDiscountNode { id automaticDiscount { ... on DiscountAutomaticApp { status } } }
             userErrors { field message }
           }
         }`;

    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: mutation, variables: { id: discountNodeId } }),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch {
      return res.status(502).json({ error: 'Non-JSON from Shopify' });
    }

    // Check for GraphQL-level errors (auth failures, invalid IDs, etc.)
    if (result.errors?.length) {
      const msg = result.errors.map(e => e.message).join('; ');
      console.error(`[ToggleStatus] GraphQL error for ${discountNodeId}:`, msg);
      return res.status(502).json({ error: 'Shopify GraphQL error: ' + msg });
    }

    const key = action === 'activate' ? 'discountAutomaticActivate' : 'discountAutomaticDeactivate';
    const data = result.data?.[key];
    if (!data) {
      console.error(`[ToggleStatus] No mutation data returned for ${discountNodeId}. Full response:`, JSON.stringify(result));
      return res.status(502).json({ error: 'Shopify did not return mutation data — toggle may not have persisted' });
    }
    if (data.userErrors?.length) {
      return res.status(400).json({ error: data.userErrors[0].message });
    }
    const newStatus = data.automaticDiscountNode?.automaticDiscount?.status;
    if (!newStatus) {
      console.error(`[ToggleStatus] Mutation returned no status for ${discountNodeId}. Data:`, JSON.stringify(data));
      return res.status(502).json({ error: 'Shopify mutation succeeded but returned no status — please retry' });
    }
    console.log(`[ToggleStatus] ${action} discount ${discountNodeId} → ${newStatus}`);
    res.json({ success: true, status: newStatus });
  } catch (error) {
    reportError(error, { area: 'deployed_discount_toggle' });
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// SHARED: Update deployed discount config metafield — allows editing threshold,
// percentage, message etc. without re-creating the discount
// =============================================================================
app.put('/api/deployed-discount/:discountNodeId/update-config', requireAdmin, async (req, res) => {
  try {
    const { discountNodeId } = req.params;
    const { config, metafieldKey } = req.body; // metafieldKey = 'discount_config' | 'shipping_config'
    if (!config || !metafieldKey) {
      return res.status(400).json({ error: 'config and metafieldKey are required' });
    }

    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        query: `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields { id namespace key }
            userErrors { field message }
          }
        }`,
        variables: {
          metafields: [{
            ownerId: discountNodeId,
            namespace: 'gcw',
            key: metafieldKey,
            type: 'json',
            value: JSON.stringify(config),
          }],
        },
      }),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch {
      return res.status(502).json({ error: 'Non-JSON from Shopify' });
    }
    const data = result.data?.metafieldsSet;
    if (data?.userErrors?.length) {
      return res.status(400).json({ error: data.userErrors[0].message });
    }
    console.log(`[UpdateConfig] Updated ${metafieldKey} on ${discountNodeId}`);
    res.json({ success: true });
  } catch (error) {
    reportError(error, { area: 'deployed_discount_update_config' });
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// Shipping Function Engine — deploy free-shipping-over-$X discounts
// =============================================================================

// Deploy a new shipping function discount — ADMIN ONLY
app.post('/api/shipping-function/deploy', requireAdmin, async (req, res) => {
  try {
    const { title, threshold, message, starts_at, ends_at,
            combines_with_order, combines_with_product, combines_with_shipping } = req.body;

    const thresholdNum = Number(threshold);
    if (!thresholdNum || thresholdNum < 10 || thresholdNum > 100) {
      return res.status(400).json({ error: 'Threshold must be between 10 and 100.' });
    }
    // Always generate title from threshold to prevent misrepresentation
    const resolvedTitle = 'Free Shipping $' + Math.min(100, Math.max(10, thresholdNum)) + '+';

    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing shop or access token.' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const callGql = makeGqlClient(graphqlUrl, accessToken);

    // 1. Find the deployed SHIPPING function (gcw-shipping-function)
    const fnResp = await callGql(`query { shopifyFunctions(first: 50) { nodes { id apiType title } } }`);
    if (!fnResp.ok) return res.status(400).json({ error: 'Cannot query functions', details: fnResp.error });
    const fns = fnResp.result.data?.shopifyFunctions?.nodes || [];
    console.log('[ShippingFunction] Available functions:', fns.map(f => `${f.title} (${f.apiType})`).join(', '));
    // Prefer exact match on "gcw-shipping-function", then fallback to title containing "shipping"
    // Shopify may report apiType as delivery_customization, shipping_discounts, or similar
    const isShippingType = (apiType) => {
      const t = (apiType || '').toLowerCase();
      return t.includes('delivery') || t.includes('shipping') || t.includes('discount');
    };
    const fn = fns.find(f => (f.title || '').toLowerCase() === 'gcw-shipping-function')
            || fns.find(f => (f.title || '').toLowerCase().includes('shipping') && isShippingType(f.apiType))
            || null;
    if (!fn) {
      const available = fns.map(f => `"${f.title}" (${f.apiType})`).join(', ') || 'none';
      return res.status(400).json({
        error: 'No deployed shipping function found.',
        details: 'Looked for function titled "gcw-shipping-function". Available functions: ' + available + '. Run "shopify app deploy" from the gcw-discount-app directory.',
        available,
      });
    }

    // Delete any existing discount with the same title to avoid uniqueness errors
    // Paginate through ALL automatic discounts to find title matches
    let allDupeNodes = [];
    let dupeCursor = null;
    for (let page = 0; page < 5; page++) {
      const afterClause = dupeCursor ? `, after: "${dupeCursor}"` : '';
      const dupeSearch = await callGql(`query { discountNodes(first: 50${afterClause}) { nodes { id discount { ... on DiscountAutomaticApp { title } ... on DiscountAutomaticBasic { title } } } pageInfo { hasNextPage endCursor } } }`);
      if (!dupeSearch.ok) break;
      const nodes = dupeSearch.result.data?.discountNodes?.nodes || [];
      allDupeNodes = allDupeNodes.concat(nodes);
      const pi = dupeSearch.result.data?.discountNodes?.pageInfo;
      if (!pi?.hasNextPage) break;
      dupeCursor = pi.endCursor;
    }
    const normalizeShip = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedResolvedTitle = normalizeShip(resolvedTitle);
    const existing = allDupeNodes.filter(n => {
      const t = n.discount?.title;
      return t === resolvedTitle || normalizeShip(t) === normalizedResolvedTitle;
    });
    console.log(`[ShippingFunction] Scanned ${allDupeNodes.length} automatic discounts, found ${existing.length} with title "${resolvedTitle}"`);
    if (existing.length) {
      console.log('[ShippingFunction] Duplicate-title auto-delete is disabled for safety; keeping existing discounts unchanged.');
    }

    // Use a unique title: always append a short unique ID to prevent any title conflicts
    let finalTitle = resolvedTitle + ' #' + Date.now().toString(36).slice(-4);

    // 2. Build the config metafield
    const shippingConfig = {
      threshold: thresholdNum,
      message: message || 'Free Shipping',
    };

    const startsAt = starts_at ? new Date(starts_at).toISOString() : new Date().toISOString();
    const endsAt = ends_at ? new Date(ends_at).toISOString() : null;

    // 3. Create automatic app discount with metafield
    const createMut = `
      mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { discountId title status }
          userErrors { field message }
        }
      }`;

    const buildVars = (discountTitle) => ({
      automaticAppDiscount: {
        title: discountTitle,
        functionId: fn.id,
        startsAt,
        endsAt,
        discountClasses: ['SHIPPING'],
        combinesWith: {
          orderDiscounts: combines_with_order !== false,
          productDiscounts: combines_with_product !== false,
          shippingDiscounts: !!combines_with_shipping,
        },
        metafields: [{
          namespace: 'gcw',
          key: 'shipping_config',
          type: 'json',
          value: JSON.stringify(shippingConfig),
        }],
      },
    });

    // Try with the resolved title first; if uniqueness error, retry with a timestamp suffix
    let createResp = await callGql(createMut, buildVars(finalTitle));
    let createData = createResp.ok ? createResp.result.data?.discountAutomaticAppCreate : null;
    const hasTitleError = createData?.userErrors?.some(e => e.message && e.message.toLowerCase().includes('title must be unique'));
    if (hasTitleError) {
      console.warn(`[ShippingFunction] Title "${finalTitle}" still conflicts — retrying with random suffix`);
      finalTitle = resolvedTitle + ' #' + Math.random().toString(36).slice(2, 8);
      createResp = await callGql(createMut, buildVars(finalTitle));
      createData = createResp.ok ? createResp.result.data?.discountAutomaticAppCreate : null;
    }
    if (!createResp.ok) return res.status(400).json({ error: createResp.error });
    if (createData?.userErrors?.length) {
      const errMsg = createData.userErrors.map(e => `${e.field ? e.field + ': ' : ''}${e.message}`).join('; ');
      console.error('[ShippingFunction] userErrors:', errMsg);
      return res.status(400).json({ error: errMsg, details: errMsg });
    }

    const disc = createData?.automaticAppDiscount;
    if (disc?.discountId) registerDiscount(disc.discountId, shop, 'shipping-function');
    console.log(`[ShippingFunction] Created: ${disc?.title} (${disc?.discountId})`);
    res.json({ success: true, discount: disc, config: shippingConfig });
  } catch (error) {
    reportError(error, { area: 'shipping_function_deploy' });
    res.status(500).json({ error: error.message });
  }
});

// List shipping function discounts
app.get('/api/shipping-function/list', requireViewer, async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    // Paginate through ALL automatic discounts (up to 250)
    let allNodes = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const afterClause = cursor ? `, after: "${cursor}"` : '';
      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({
          query: `query {
            discountNodes(first: 50${afterClause}) {
              nodes {
                id
                discount {
                  ... on DiscountAutomaticApp {
                    title
                    status
                    startsAt
                    endsAt
                    discountId
                    appDiscountType { appKey functionId }
                  }
                }
                metafield(namespace: "gcw", key: "shipping_config") { value }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`
        }),
      });

      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch {
        console.error('[SF List] Non-JSON from Shopify on page', page);
        break;
      }

      const nodes = result.data?.discountNodes?.nodes || [];
      allNodes = allNodes.concat(nodes);
      const pi = result.data?.discountNodes?.pageInfo;
      if (!pi?.hasNextPage) break;
      cursor = pi.endCursor;
    }

    console.log(`[SF List] Scanned ${allNodes.length} automatic discounts`);
    // Only log all node details on first call or when count changes
    if (!global._sfListLastCount || global._sfListLastCount !== allNodes.length) {
      const allTitles = allNodes.map(n => `"${n.discount?.title || '(no title)'}" meta=${n.metafield?.value ? 'YES' : 'null'}`);
      console.log(`[SF List] All nodes:`, allTitles.join(' | '));
      global._sfListLastCount = allNodes.length;
    }

    // Filter to only shipping function discounts (ones that have our shipping_config metafield)
    const shippingDiscounts = allNodes
      .filter(n => n.metafield?.value)
      .map(n => {
        let config = {};
        try { config = JSON.parse(n.metafield?.value || '{}'); } catch {}
        return {
          id: n.id,
          discountId: n.discount?.discountId,
          title: n.discount?.title,
          status: n.discount?.status,
          startsAt: n.discount?.startsAt,
          endsAt: n.discount?.endsAt,
          functionId: n.discount?.appDiscountType?.functionId,
          config,
        };
      });

    // Only log SF list details when results change
    const sfKey = `${allNodes.length}:${shippingDiscounts.length}`;
    if (global._sfListLastKey !== sfKey) {
      console.log(`[SF List] Found ${shippingDiscounts.length} shipping discounts:`, shippingDiscounts.map(d => `"${d.title}" (${d.status})`).join(', '));
      global._sfListLastKey = sfKey;
    }
    res.json({ success: true, discounts: shippingDiscounts });
  } catch (error) {
    reportError(error, { area: 'shipping_function_list' });
    res.status(500).json({ error: error.message });
  }
});

// Delete a shipping function discount — ADMIN ONLY
app.delete('/api/shipping-function/:discountId', requireAdmin, async (req, res) => {
  try {
    const { discountId } = req.params;
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const deleteGuard = await assertAppManagedDiscountForDelete(shop, accessToken, discountId, ['shipping_config']);
    if (!deleteGuard.ok) {
      return res.status(deleteGuard.status).json({ error: deleteGuard.error });
    }

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        query: `mutation discountAutomaticDelete($id: ID!) {
          discountAutomaticDelete(id: $id) {
            deletedAutomaticDiscountId
            userErrors { field message }
          }
        }`,
        variables: { id: discountId },
      }),
    });

    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch {
      return res.status(502).json({ error: 'Non-JSON from Shopify' });
    }

    const data = result.data?.discountAutomaticDelete;
    if (data?.userErrors?.length) return res.status(400).json({ error: data.userErrors[0].message });

    unregisterDiscount(discountId);
    console.log(`[ShippingFunction] Deleted discount: ${discountId}`);
    res.json({ success: true, deletedId: data?.deletedAutomaticDiscountId });
  } catch (error) {
    reportError(error, { area: 'shipping_function_delete' });
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// DIAGNOSTIC: List all deployed Shopify Functions
// =============================================================================
app.get('/api/functions/list', requireViewer, async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing shop or access token.' });
    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: '{ shopifyFunctions(first: 50) { nodes { id apiType title app { handle } } } }' })
    });
    const text = await response.text();
    let result; try { result = JSON.parse(text); } catch { return res.status(502).json({ error: 'Non-JSON response from Shopify' }); }
    const fns = result.data?.shopifyFunctions?.nodes || [];
    res.json({ success: true, count: fns.length, functions: fns });
  } catch (error) {
    reportError(error, { area: 'functions_list' });
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// TIERED DISCOUNT ENGINE — spend-more-save-more via tiers
// =============================================================================

app.post('/api/tiered-discount/deploy', requireAdmin, async (req, res) => {
  try {
    const { title, tiers, mode, message, exclude_gift_cards, starts_at, ends_at,
            combines_with_order, combines_with_product, combines_with_shipping,
            included_tags } = req.body;

    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'Title is required.' });
    if (title.length > 255) return res.status(400).json({ error: 'Title must be 255 characters or fewer.' });
    if (!Array.isArray(tiers) || tiers.length === 0) return res.status(400).json({ error: 'At least one tier is required.' });
    if (tiers.length > 20) return res.status(400).json({ error: 'Maximum 20 tiers allowed.' });

    // Validate each tier
    for (const tier of tiers) {
      if (typeof tier.min_value !== 'number' || !Number.isFinite(tier.min_value) || tier.min_value <= 0) return res.status(400).json({ error: 'Each tier needs a positive min_value.' });
      if (typeof tier.percentage !== 'number' || !Number.isFinite(tier.percentage) || tier.percentage < 1 || tier.percentage > 100) return res.status(400).json({ error: 'Each tier needs a percentage between 1-100.' });
    }

    // Validate tags — warn if any aren't in the function's hasTags() list
    const submittedTags = Array.isArray(included_tags) ? included_tags : (included_tags ? String(included_tags).split(',').map(t => t.trim()).filter(Boolean) : []);
    const tagCheck = validateTags(submittedTags);
    const tagWarnings = tagCheck.warnings || [];

    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing shop or access token.' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const callGql = makeGqlClient(graphqlUrl, accessToken);

    // Find the tiered discount function
    const fnResp = await callGql(`query { shopifyFunctions(first: 50) { nodes { id apiType title app { handle } } } }`);
    if (!fnResp.ok) return res.status(400).json({ error: 'Cannot query functions', details: fnResp.error });
    const fns = fnResp.result.data?.shopifyFunctions?.nodes || [];
    console.log('[TieredDiscount] Available functions:', fns.map(f => `${f.title} (${f.apiType}, app:${f.app?.handle || '?'})`).join(', '));
    const fn = fns.find(f => (f.title || '').toLowerCase() === 'gcw-tiered-discount')
            || fns.find(f => (f.title || '').toLowerCase().includes('tiered') && (f.apiType || '').toLowerCase().includes('discount'))
            || null;
    if (!fn) {
      const available = fns.map(f => `${f.title} (${f.apiType})`).join(', ') || 'none';
      console.error(`[TieredDiscount] Function NOT found. Only ${fns.length} functions deployed: ${available}`);
      return res.status(400).json({
        error: 'The "gcw-tiered-discount" function is not deployed to Shopify.',
        details: `Only ${fns.length} functions are deployed: ${available}. The tiered discount extension needs to be deployed separately via "shopify app deploy" from the CLI. It cannot reuse the standard discount function.`,
      });
    }

    // Deduplicate titles
    let allDupeNodes = []; let dupeCursor = null;
    for (let page = 0; page < 5; page++) {
      const afterClause = dupeCursor ? `, after: "${dupeCursor}"` : '';
      const dupeSearch = await callGql(`query { discountNodes(first: 50${afterClause}) { nodes { id discount { ... on DiscountAutomaticApp { title } ... on DiscountAutomaticBasic { title } } } pageInfo { hasNextPage endCursor } } }`);
      if (!dupeSearch.ok) break;
      allDupeNodes = allDupeNodes.concat(dupeSearch.result.data?.discountNodes?.nodes || []);
      const pi = dupeSearch.result.data?.discountNodes?.pageInfo;
      if (!pi?.hasNextPage) break;
      dupeCursor = pi.endCursor;
    }
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const existing = allDupeNodes.filter(n => norm(n.discount?.title) === norm(title));
    if (existing.length) {
      console.log('[TieredDiscount] Duplicate-title auto-delete is disabled for safety; keeping existing discounts unchanged.');
    }

    let finalTitle = title + ' #' + Date.now().toString(36).slice(-4);
    const tieredConfig = {
      mode: mode || 'subtotal',
      tiers: tiers.sort((a, b) => a.min_value - b.min_value),
      message: message || undefined,
      exclude_gift_cards: exclude_gift_cards !== false,
      included_tags: Array.isArray(included_tags) ? included_tags.filter(t => typeof t === 'string' && t.trim()) : [],
    };
    const startsAt = starts_at ? new Date(starts_at).toISOString() : new Date().toISOString();
    const endsAt = ends_at ? new Date(ends_at).toISOString() : null;

    const createMut = `mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) { discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) { automaticAppDiscount { discountId title status } userErrors { field message } } }`;
    const buildVars = (t) => ({ automaticAppDiscount: { title: t, functionId: fn.id, startsAt, endsAt, discountClasses: ['PRODUCT'], combinesWith: { orderDiscounts: !!combines_with_order, productDiscounts: !!combines_with_product, shippingDiscounts: !!combines_with_shipping }, metafields: [{ namespace: 'gcw', key: 'tiered_config', type: 'json', value: JSON.stringify(tieredConfig) }] } });

    let createResp = await callGql(createMut, buildVars(finalTitle));
    let createData = createResp.ok ? createResp.result.data?.discountAutomaticAppCreate : null;
    if (createData?.userErrors?.some(e => e.message?.toLowerCase().includes('title must be unique'))) {
      finalTitle = title + ' #' + Math.random().toString(36).slice(2, 8);
      createResp = await callGql(createMut, buildVars(finalTitle));
      createData = createResp.ok ? createResp.result.data?.discountAutomaticAppCreate : null;
    }
    if (!createResp.ok) return res.status(400).json({ error: createResp.error });
    if (createData?.userErrors?.length) return res.status(400).json({ error: 'Shopify error', details: createData.userErrors });

    const disc = createData?.automaticAppDiscount;
    if (disc?.discountId) registerDiscount(disc.discountId, shop, 'tiered-discount');
    console.log(`[TieredDiscount] Created: ${disc?.title} (${disc?.discountId})`);
    res.json({ success: true, discount: disc, config: tieredConfig, warnings: tagWarnings });
  } catch (error) {
    reportError(error, { area: 'tiered_discount_deploy' });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tiered-discount/list', requireViewer, async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    let allNodes = []; let cursor = null;
    for (let page = 0; page < 5; page++) {
      const afterClause = cursor ? `, after: "${cursor}"` : '';
      const response = await fetch(graphqlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken }, body: JSON.stringify({ query: `query { discountNodes(first: 50${afterClause}) { nodes { id discount { ... on DiscountAutomaticApp { title status startsAt endsAt discountId appDiscountType { appKey functionId } } } metafield(namespace: "gcw", key: "tiered_config") { value } } pageInfo { hasNextPage endCursor } } }` }) });
      const text = await response.text();
      let result; try { result = JSON.parse(text); } catch { break; }
      allNodes = allNodes.concat(result.data?.discountNodes?.nodes || []);
      const pi = result.data?.discountNodes?.pageInfo;
      if (!pi?.hasNextPage) break;
      cursor = pi.endCursor;
    }
    const discounts = allNodes.filter(n => n.metafield?.value).map(n => {
      let config = {}; try { config = JSON.parse(n.metafield?.value || '{}'); } catch {}
      return { id: n.id, discountId: n.discount?.discountId, title: n.discount?.title, status: n.discount?.status, startsAt: n.discount?.startsAt, endsAt: n.discount?.endsAt, functionId: n.discount?.appDiscountType?.functionId, config };
    });
    console.log(`[TieredDiscount] Found ${discounts.length} tiered discounts`);
    res.json({ success: true, discounts });
  } catch (error) {
    reportError(error, { area: 'tiered_discount_list' });
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/tiered-discount/:discountId', requireAdmin, async (req, res) => {
  try {
    const { discountId } = req.params;
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const deleteGuard = await assertAppManagedDiscountForDelete(shop, accessToken, discountId, ['tiered_config']);
    if (!deleteGuard.ok) {
      return res.status(deleteGuard.status).json({ error: deleteGuard.error });
    }

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const response = await fetch(graphqlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken }, body: JSON.stringify({ query: `mutation discountAutomaticDelete($id: ID!) { discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field message } } }`, variables: { id: discountId } }) });
    const text = await response.text();
    let result; try { result = JSON.parse(text); } catch { return res.status(502).json({ error: 'Non-JSON from Shopify' }); }
    const data = result.data?.discountAutomaticDelete;
    if (data?.userErrors?.length) return res.status(400).json({ error: data.userErrors[0].message });
    unregisterDiscount(discountId);
    console.log(`[TieredDiscount] Deleted: ${discountId}`);
    res.json({ success: true, deletedId: data?.deletedAutomaticDiscountId });
  } catch (error) {
    reportError(error, { area: 'tiered_discount_delete' });
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// BUY X GET Y ENGINE — BXGY discount function
// =============================================================================

app.post('/api/bxgy-discount/deploy', requireAdmin, async (req, res) => {
  try {
    const { title, buy_quantity, get_quantity, get_percentage, qualifying_tags, discount_cheapest,
            message, exclude_gift_cards, starts_at, ends_at,
            combines_with_order, combines_with_product, combines_with_shipping } = req.body;

    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'Title is required.' });
    if (title.length > 255) return res.status(400).json({ error: 'Title must be 255 characters or fewer.' });
    const buyQty = Number(buy_quantity); const getQty = Number(get_quantity); const getPct = Number(get_percentage);
    if (!Number.isFinite(buyQty) || buyQty < 1 || buyQty > 1000) return res.status(400).json({ error: 'Buy quantity must be 1-1000.' });
    if (!Number.isFinite(getQty) || getQty < 1 || getQty > 1000) return res.status(400).json({ error: 'Get quantity must be 1-1000.' });
    if (!Number.isFinite(getPct) || getPct < 1 || getPct > 100) return res.status(400).json({ error: 'Get percentage must be 1-100.' });

    // Validate qualifying_tags — warn if any aren't in the function's hasTags() list
    const bxgyTags = Array.isArray(qualifying_tags) ? qualifying_tags : (qualifying_tags ? String(qualifying_tags).split(',').map(t => t.trim()).filter(Boolean) : []);
    const bxgyTagCheck = validateTags(bxgyTags, AVAILABLE_BXGY_TAGS);
    const tagWarnings = bxgyTagCheck.warnings || [];

    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing shop or access token.' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const callGql = makeGqlClient(graphqlUrl, accessToken);

    // Find the BXGY function
    const fnResp = await callGql(`query { shopifyFunctions(first: 50) { nodes { id apiType title app { handle } } } }`);
    if (!fnResp.ok) return res.status(400).json({ error: 'Cannot query functions', details: fnResp.error });
    const fns = fnResp.result.data?.shopifyFunctions?.nodes || [];
    console.log('[BXGYDiscount] Available functions:', fns.map(f => `${f.title} (${f.apiType}, app:${f.app?.handle || '?'})`).join(', '));
    const fn = fns.find(f => (f.title || '').toLowerCase() === 'gcw-bxgy-discount')
            || fns.find(f => (f.title || '').toLowerCase().includes('bxgy') && (f.apiType || '').toLowerCase().includes('discount'))
            || null;
    if (!fn) {
      const available = fns.map(f => `${f.title} (${f.apiType})`).join(', ') || 'none';
      console.error(`[BXGYDiscount] Function NOT found. Only ${fns.length} functions deployed: ${available}`);
      return res.status(400).json({
        error: 'The "gcw-bxgy-discount" function is not deployed to Shopify.',
        details: `Only ${fns.length} functions are deployed: ${available}. The BXGY extension needs to be deployed separately via "shopify app deploy" from the CLI.`,
      });
    }

    // Deduplicate
    let allDupeNodes = []; let dupeCursor = null;
    for (let page = 0; page < 5; page++) {
      const afterClause = dupeCursor ? `, after: "${dupeCursor}"` : '';
      const dupeSearch = await callGql(`query { discountNodes(first: 50${afterClause}) { nodes { id discount { ... on DiscountAutomaticApp { title } ... on DiscountAutomaticBasic { title } } } pageInfo { hasNextPage endCursor } } }`);
      if (!dupeSearch.ok) break;
      allDupeNodes = allDupeNodes.concat(dupeSearch.result.data?.discountNodes?.nodes || []);
      const pi = dupeSearch.result.data?.discountNodes?.pageInfo;
      if (!pi?.hasNextPage) break;
      dupeCursor = pi.endCursor;
    }
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const existing = allDupeNodes.filter(n => norm(n.discount?.title) === norm(title));
    if (existing.length) {
      console.log('[BXGYDiscount] Duplicate-title auto-delete is disabled for safety; keeping existing discounts unchanged.');
    }

    let finalTitle = title + ' #' + Date.now().toString(36).slice(-4);
    const bxgyConfig = {
      buy_quantity: buyQty,
      get_quantity: getQty,
      get_percentage: getPct,
      qualifying_tags: Array.isArray(qualifying_tags) ? qualifying_tags : (qualifying_tags ? String(qualifying_tags).split(',').map(t => t.trim()).filter(Boolean) : []),
      discount_cheapest: discount_cheapest !== false,
      message: message || undefined,
      exclude_gift_cards: exclude_gift_cards !== false,
    };
    const startsAt = starts_at ? new Date(starts_at).toISOString() : new Date().toISOString();
    const endsAt = ends_at ? new Date(ends_at).toISOString() : null;

    const createMut = `mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) { discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) { automaticAppDiscount { discountId title status } userErrors { field message } } }`;
    const buildVars = (t) => ({ automaticAppDiscount: { title: t, functionId: fn.id, startsAt, endsAt, discountClasses: ['PRODUCT'], combinesWith: { orderDiscounts: !!combines_with_order, productDiscounts: !!combines_with_product, shippingDiscounts: !!combines_with_shipping }, metafields: [{ namespace: 'gcw', key: 'bxgy_config', type: 'json', value: JSON.stringify(bxgyConfig) }] } });

    let createResp = await callGql(createMut, buildVars(finalTitle));
    let createData = createResp.ok ? createResp.result.data?.discountAutomaticAppCreate : null;
    if (createData?.userErrors?.some(e => e.message?.toLowerCase().includes('title must be unique'))) {
      finalTitle = title + ' #' + Math.random().toString(36).slice(2, 8);
      createResp = await callGql(createMut, buildVars(finalTitle));
      createData = createResp.ok ? createResp.result.data?.discountAutomaticAppCreate : null;
    }
    if (!createResp.ok) return res.status(400).json({ error: createResp.error });
    if (createData?.userErrors?.length) return res.status(400).json({ error: 'Shopify error', details: createData.userErrors });

    const disc = createData?.automaticAppDiscount;
    if (disc?.discountId) registerDiscount(disc.discountId, shop, 'bxgy-discount');
    console.log(`[BXGY] Created: ${disc?.title} (${disc?.discountId})`);
    res.json({ success: true, discount: disc, config: bxgyConfig, warnings: tagWarnings });
  } catch (error) {
    reportError(error, { area: 'bxgy_discount_deploy' });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bxgy-discount/list', requireViewer, async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });
    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    let allNodes = []; let cursor = null;
    for (let page = 0; page < 5; page++) {
      const afterClause = cursor ? `, after: "${cursor}"` : '';
      const response = await fetch(graphqlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken }, body: JSON.stringify({ query: `query { discountNodes(first: 50${afterClause}) { nodes { id discount { ... on DiscountAutomaticApp { title status startsAt endsAt discountId appDiscountType { appKey functionId } } } metafield(namespace: "gcw", key: "bxgy_config") { value } } pageInfo { hasNextPage endCursor } } }` }) });
      const text = await response.text();
      let result; try { result = JSON.parse(text); } catch { break; }
      allNodes = allNodes.concat(result.data?.discountNodes?.nodes || []);
      const pi = result.data?.discountNodes?.pageInfo;
      if (!pi?.hasNextPage) break;
      cursor = pi.endCursor;
    }
    const discounts = allNodes.filter(n => n.metafield?.value).map(n => {
      let config = {}; try { config = JSON.parse(n.metafield?.value || '{}'); } catch {}
      return { id: n.id, discountId: n.discount?.discountId, title: n.discount?.title, status: n.discount?.status, startsAt: n.discount?.startsAt, endsAt: n.discount?.endsAt, functionId: n.discount?.appDiscountType?.functionId, config };
    });
    console.log(`[BXGY] Found ${discounts.length} BXGY discounts`);
    res.json({ success: true, discounts });
  } catch (error) {
    reportError(error, { area: 'bxgy_discount_list' });
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/bxgy-discount/:discountId', requireAdmin, async (req, res) => {
  try {
    const { discountId } = req.params;
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth' });

    const deleteGuard = await assertAppManagedDiscountForDelete(shop, accessToken, discountId, ['bxgy_config']);
    if (!deleteGuard.ok) {
      return res.status(deleteGuard.status).json({ error: deleteGuard.error });
    }

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const response = await fetch(graphqlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken }, body: JSON.stringify({ query: `mutation discountAutomaticDelete($id: ID!) { discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field message } } }`, variables: { id: discountId } }) });
    const text = await response.text();
    let result; try { result = JSON.parse(text); } catch { return res.status(502).json({ error: 'Non-JSON from Shopify' }); }
    const data = result.data?.discountAutomaticDelete;
    if (data?.userErrors?.length) return res.status(400).json({ error: data.userErrors[0].message });
    unregisterDiscount(discountId);
    console.log(`[BXGY] Deleted: ${discountId}`);
    res.json({ success: true, deletedId: data?.deletedAutomaticDiscountId });
  } catch (error) {
    reportError(error, { area: 'bxgy_discount_delete' });
    res.status(500).json({ error: error.message });
  }
});

// =============================================================================
// DEBUG: Dump all automatic discounts with both metafield keys
// Visit /api/debug/discounts?shop=... to see raw Shopify data
// =============================================================================
app.get('/api/debug/discounts', requireAdmin, async (req, res) => {
  try {
    const { shop, accessToken } = await getOrExchangeToken(req);
    if (!shop || !accessToken) return res.status(401).json({ error: 'Missing auth', shop, hasToken: !!accessToken });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    const tokenStatus = accessToken ? 'SET' : 'NOT_SET';

    // 1. Test the token with a simple shop query
    const shopTestResp = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: `{ shop { name myshopifyDomain } }` }),
    });
    const shopTestText = await shopTestResp.text();
    let shopTest;
    try { shopTest = JSON.parse(shopTestText); } catch {
      return res.json({ success: false, error: 'Token test failed — non-JSON', httpStatus: shopTestResp.status, body: shopTestText.slice(0, 300), tokenStatus });
    }
    if (shopTest.errors) {
      return res.json({ success: false, error: 'Token test failed', errors: shopTest.errors, tokenStatus });
    }

    // 2. Query ALL discount types (not just automatic) to see everything
    const allTypesResp = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: `{ discountNodes(first: 50) { nodes { id discount { __typename ... on DiscountAutomaticApp { title status discountClasses appDiscountType { appKey functionId } } ... on DiscountAutomaticBasic { title status } ... on DiscountCodeApp { title status } ... on DiscountCodeBasic { title status } } metafield_dc: metafield(namespace: "gcw", key: "discount_config") { value } metafield_sc: metafield(namespace: "gcw", key: "shipping_config") { value } } pageInfo { hasNextPage endCursor } } }` }),
    });
    const allTypesText = await allTypesResp.text();
    let allTypesResult;
    try { allTypesResult = JSON.parse(allTypesText); } catch {
      return res.json({ success: false, error: 'All-types query non-JSON', httpStatus: allTypesResp.status, body: allTypesText.slice(0, 300) });
    }
    if (allTypesResult.errors) {
      return res.json({ success: false, error: 'All-types query error', errors: allTypesResult.errors, tokenStatus });
    }

    // 3. Also query with the "type:automatic" filter
    const autoResp = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: `{ discountNodes(first: 50, query: "type:automatic") { nodes { id discount { __typename ... on DiscountAutomaticApp { title status discountClasses appDiscountType { appKey functionId } } ... on DiscountAutomaticBasic { title status } } metafield_dc: metafield(namespace: "gcw", key: "discount_config") { value } metafield_sc: metafield(namespace: "gcw", key: "shipping_config") { value } } pageInfo { hasNextPage endCursor } } }` }),
    });
    const autoText = await autoResp.text();
    let autoResult;
    try { autoResult = JSON.parse(autoText); } catch {
      return res.json({ success: false, error: 'Auto query non-JSON' });
    }

    const allNodes = allTypesResult.data?.discountNodes?.nodes || [];
    const autoNodes = autoResult.data?.discountNodes?.nodes || [];

    const summarize = (n) => ({
      id: n.id,
      __typename: n.discount?.__typename || '(empty)',
      title: n.discount?.title || '(no title)',
      status: n.discount?.status || '(no status)',
      discountClasses: n.discount?.discountClasses || null,
      appKey: n.discount?.appDiscountType?.appKey || null,
      functionId: n.discount?.appDiscountType?.functionId || null,
      has_discount_config: !!n.metafield_dc?.value,
      has_shipping_config: !!n.metafield_sc?.value,
    });

    res.json({
      success: true,
      tokenStatus,
      shop: shopTest.data?.shop,
      apiVersion: SHOPIFY_API_VERSION,
      all_discounts: { total: allNodes.length, nodes: allNodes.map(summarize) },
      automatic_only: { total: autoNodes.length, nodes: autoNodes.map(summarize) },
    });
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack?.split('\n').slice(0, 3) });
  }
});

// =============================================================================
// Error log API
// =============================================================================
app.get('/api/errors/log', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, ERROR_LOG_MAX);
  res.json({ success: true, errors: errorLog.slice(0, limit), total: errorLog.length });
});

app.post('/api/errors/report', requireViewer, heavyRateLimit(10), (req, res) => {
  const { message, area, stack } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  const entry = {
    timestamp: new Date().toISOString(),
    area: String(area || 'client').slice(0, 50),
    message: String(message).slice(0, 500),
    stack: String(stack || '').split('\n').slice(0, 6).join('\n').slice(0, 1000),
    source: 'browser',
  };
  errorLog.unshift(entry);
  if (errorLog.length > ERROR_LOG_MAX) errorLog.length = ERROR_LOG_MAX;
  res.json({ success: true });
});

app.delete('/api/errors/clear', requireAdmin, (req, res) => {
  errorLog.length = 0;
  res.json({ success: true, message: 'Error log cleared' });
});

function applyStorefrontCors(req, res) {
  const origin = req.headers.origin || '';
  // Use DEFAULT_SHOP only — do NOT trust req.query.shop for CORS origin
  const storeDomain = DEFAULT_SHOP.replace(/[^a-zA-Z0-9.\-]/g, '');
  const allowed = [`https://${storeDomain}`, `https://${storeDomain.replace('.myshopify.com', '.com')}`];
  if (allowed.includes(origin) || process.env.NODE_ENV !== 'production') {
    res.set('Access-Control-Allow-Origin', origin || allowed[0]);
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

app.options('/api/storefront/discounts', (req, res) => {
  applyStorefrontCors(req, res);
  res.sendStatus(204);
});

app.get('/api/storefront/discounts', requireViewer, (req, res) => {
  applyStorefrontCors(req, res);
  res.json({ success: true, data: Object.values(discountsStore) });
});

app.options('/api/storefront/discount/:id', (req, res) => {
  applyStorefrontCors(req, res);
  res.sendStatus(204);
});

app.get('/api/storefront/discount/:id', requireViewer, (req, res) => {
  applyStorefrontCors(req, res);
  const { id } = req.params;
  const discount = discountsStore[id];
  if (!discount) {
    return res.status(404).json({ success: false, error: 'Discount not found' });
  }
  res.json({
    success: true,
    data: {
      id: discount.id,
      name: discount.name,
      cart_message: discount.cart_message || '',
      checkout_message: discount.checkout_message || '',
      included_tags: discount.included_tags || '',
      excluded_tags: discount.excluded_tags || '',
      start_date: discount.start_date || null,
      end_date: discount.end_date || null,
      paused: Boolean(discount.paused)
    }
  });
});

// HTML-escape helper to prevent XSS in server-rendered templates
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Safe JSON serialization for embedding in <script> tags (prevents </script> breakout)
function safeJsonForScript(val) {
  return JSON.stringify(val).replace(/<\//g, '<\\/');
}

// Preview discount details (requires authentication)
app.get('/preview/:id', requireViewer, (req, res) => {
  const { id } = req.params;
  const discount = discountsStore[id];
  
  if (!discount) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Discount Not Found</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f5f5f5; }
          .container { text-align: center; }
          h1 { color: #333; }
          p { color: #666; }
          a { color: #1B365D; text-decoration: none; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Discount Not Found</h1>
          <p>The discount "${escHtml(id)}" could not be found.</p>
          <a href="/">← Back to Dashboard</a>
        </div>
      </body>
      </html>
    `);
  }
  
  const displayValue = discount.type === 'percentage' ? discount.value + '%' : '$' + discount.value + '+';
  const typeLabel = discount.type === 'percentage' ? 'Percentage Off' : 'Free Shipping';
  const badgeClass = discount.paused ? 'badge-inactive' : 'badge-active';
  const badgeText = discount.paused ? 'PAUSED' : 'ACTIVE';
  
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${escHtml(discount.name)} - GCW Discount Preview</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #1B365D 0%, #0F2340 100%);
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        
        .container {
          background: white;
          border-radius: 20px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.2);
          max-width: 600px;
          width: 100%;
          padding: 40px;
          text-align: center;
        }
        
        .logo {
          height: 60px;
          width: auto;
          margin: 0 auto 20px;
          display: block;
        }
        
        h1 {
          color: #333;
          margin-bottom: 15px;
          font-size: 28px;
        }
        
        .badge {
          display: inline-block;
          padding: 6px 14px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 30px;
        }
        
        .badge-active {
          background: #d1fae5;
          color: #065f46;
        }
        
        .badge-inactive {
          background: #fee2e2;
          color: #991b1b;
        }
        
        .discount-value {
          font-size: 48px;
          font-weight: 700;
          color: #1B365D;
          margin-bottom: 10px;
        }
        
        .discount-subtext {
          color: #666;
          font-size: 14px;
          margin-bottom: 30px;
        }
        
        .benefit-box {
          background: #F0F3F8;
          border-left: 4px solid #1B365D;
          padding: 15px;
          margin: 20px 0;
          text-align: left;
          border-radius: 6px;
        }
        
        .benefit-title {
          font-weight: 600;
          color: #333;
          margin-bottom: 8px;
        }
        
        .benefit-text {
          color: #666;
          font-size: 14px;
          line-height: 1.6;
        }
        
        .details-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
          margin: 30px 0;
          padding: 20px 0;
          border-top: 1px solid #e0e0e0;
          border-bottom: 1px solid #e0e0e0;
        }
        
        .detail-item {
          text-align: center;
        }
        
        .detail-label {
          color: #999;
          font-size: 12px;
          text-transform: uppercase;
          font-weight: 600;
          margin-bottom: 4px;
        }
        
        .detail-value {
          color: #333;
          font-size: 14px;
          font-weight: 500;
        }
        
        .action-buttons {
          display: flex;
          gap: 12px;
          margin-top: 30px;
        }
        
        button {
          padding: 12px 24px;
          border: none;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          flex: 1;
        }
        
        .btn-primary {
          background: linear-gradient(135deg, #1B365D 0%, #0F2340 100%);
          color: white;
        }
        
        .btn-primary:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 20px rgba(27, 54, 93, 0.3);
        }
        
        .btn-secondary {
          background: #f0f0f0;
          color: #333;
        }
        
        .btn-secondary:hover {
          background: #e0e0e0;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo"><img src="/gcw-logo.svg" alt="Gerber Childrenswear" style="height: 60px; width: auto;" /></div>
        <h1>${escHtml(discount.name)}</h1>
        <div class="badge ${badgeClass}">${badgeText}</div>
        
        <div class="discount-value">${displayValue}</div>
        <div class="discount-subtext">${typeLabel} Discount</div>
        
        <div class="benefit-box">
          <div class="benefit-title">✓ Your Discount</div>
          <div class="benefit-text">${escHtml(discount.checkout_message || `Save ${displayValue} on your purchase!`)}</div>
        </div>
        
        ${discount.excluded_tags ? '<div class="benefit-box"><div class="benefit-title">⚠ Exclusions</div><div class="benefit-text">This discount does not apply to products tagged with: <strong>' + escHtml(discount.excluded_tags) + '</strong></div></div>' : ''}
        
        <div class="details-grid">
          <div class="detail-item">
            <div class="detail-label">Type</div>
            <div class="detail-value">${typeLabel}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Status</div>
            <div class="detail-value">${badgeText}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">Start Date</div>
            <div class="detail-value">${discount.start_date ? discount.start_date + ' EST' : 'Immediate'}</div>
          </div>
          <div class="detail-item">
            <div class="detail-label">End Date</div>
            <div class="detail-value">${discount.end_date ? discount.end_date + ' EST' : 'Indefinite'}</div>
          </div>
        </div>
        
        <div class="action-buttons">
          <button class="btn-secondary" onclick="window.location.href='/'">← Back</button>
          <button class="btn-primary" onclick="window.open('https://' + window.gcwConfig.shop, '_blank')">Visit Store</button>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Exit iframe handler
app.get('/exitiframe', (req, res) => {
  const shop = req.query.shop;
  // Validate shop parameter to prevent open redirect
  if (shop && /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop)) {
    return res.redirect(`https://${shop}/admin`);
  }
  res.redirect('/');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()) + 's',
    apiVersion: SHOPIFY_API_VERSION,
    appUrl: process.env.SHOPIFY_APP_URL || 'not set'
  });
});

// Home page - Dashboard with working pause button
app.get('/', async (req, res) => {
  try {
  const shop = req.query.shop || DEFAULT_SHOP;
  const host = req.query.host || '';
  const apiKey = process.env.SHOPIFY_API_KEY || '';
  const idToken = req.query.id_token;

  // On initial page load Shopify passes id_token as a query param (not a header),
  // so the middleware can't extract the email. Check cache by sub directly since
  // online token exchange and GraphQL staffMembers are not available for this app.
  let userEmail = req.userEmail || '';
  let userRole  = req.userRole;
  if (!userEmail && idToken) {
    try {
      const parts = idToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        const { userEmailCache } = await import('./shopify-utils.js');
        if (payload.sub && userEmailCache[payload.sub]) {
          userEmail = userEmailCache[payload.sub];
          userRole  = getUserRole(userEmail);
        }
      }
    } catch {}
  }
  // Final fallback: if the user has a valid Shopify id_token but we still can't
  // resolve their email, assign the DEFAULT_ROLE (viewer) — not admin.
  // Admin must be explicitly granted via GCW_ADMIN_EMAILS env var.
  if (!userEmail && idToken) {
    try {
      const parts = idToken.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        if (payload.sub) {
          const { userEmailCache } = await import('./shopify-utils.js');
          const syntheticEmail = `staff-${payload.sub}@shopify-auth.local`;
          userEmailCache[payload.sub] = syntheticEmail;
          // Do NOT auto-grant admin — use viewer as safe default
          if (!userRoles[syntheticEmail]) {
            userRoles[syntheticEmail] = 'viewer';
          }
          userEmail = syntheticEmail;
          userRole = getUserRole(syntheticEmail);
          console.warn(`[RBAC] Could not resolve real email — cached sub ${payload.sub} as ${userRole}`);
        }
      }
    } catch {}
  }

  // TEMPORARY: all permissions granted for open testing — revert before production
  const permissions = {
    canView:       true,
    canCreate:     true,
    canEditDraft:  true,
    canActivate:   true,
    canEditLive:   true,
    canManageUsers: true,
  };

  // If no token, try Token Exchange with the id_token Shopify sends in the iframe URL
  if (!getAccessToken(shop)) {
    if (idToken) {
      console.log(`[Auth] No token for ${shop}, attempting token exchange with id_token...`);
      const token = await exchangeToken(shop, idToken);
      if (!token) {
        console.error(`[Auth] Token exchange failed for ${shop}, falling back to OAuth`);
        return res.redirect(`/api/auth?shop=${encodeURIComponent(shop)}`);
      }
      console.log(`[Auth] Token exchange succeeded for ${shop}`);
    } else {
      console.log(`[Auth] No token and no id_token for ${shop}, redirecting to OAuth`);
      return res.redirect(`/api/auth?shop=${encodeURIComponent(shop)}`);
    }
  }

  // Build hour <option> lists for date pickers (midnight default start, 3 AM default end)
  const _hourOpts = Array.from({length: 24}, (_, i) => {
    const hh = String(i).padStart(2, '0');
    const label = i === 0 ? '12:00 AM' : i < 12 ? i + ':00 AM' : i === 12 ? '12:00 PM' : (i-12) + ':00 PM';
    return '<option value="' + hh + '">' + label + '</option>';
  }).join('');
  const START_HOUR_OPTIONS = _hourOpts.replace('value="00"', 'value="00" selected');
  const END_HOUR_OPTIONS   = _hourOpts.replace('value="03"', 'value="03" selected');

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>GCW Discount Manager</title>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${apiKey}"></script>
      <script>
        // Store config values for use by page scripts
        window.gcwConfig = {
          apiKey: ${safeJsonForScript(apiKey)},
          host: ${safeJsonForScript(host)},
          shop: ${safeJsonForScript(shop)},
          userRole: ${safeJsonForScript(userRole)},
          userEmail: ${safeJsonForScript(userEmail)},
          permissions: ${safeJsonForScript(permissions)}
        };
        // CDN App Bridge auto-initializes via data-api-key attribute
        // No manual createApp() call needed — if shop param is missing (direct access),
        // App Bridge will fail gracefully and server-side auth handles it.
        console.log('App Bridge loaded, shopify global:', window.shopify ? 'available' : 'not available (server auth will be used)');

        // Suppress cross-origin postMessage errors (expected in Cloudflare tunnel development)
        const originalError = console.error;
        const postMessageErrorFilter = new RegExp(
          'Failed to execute.*postMessage.*origin|cross.*origin',
          'i'
        );
        window.addEventListener('error', function(event) {
          if (
            event.message && 
            postMessageErrorFilter.test(event.message) &&
            event.filename && 
            (event.filename.includes('render-common') || event.filename.includes('shopify'))
          ) {
            event.preventDefault();
            return true;
          }
        }, true);

        // Also suppress postMessage errors in console
        console.error = function(...args) {
          const message = args[0];
          if (message && typeof message === 'string' && postMessageErrorFilter.test(message)) {
            console.debug('Suppressed cross-origin error:', message);
            return;
          }
          originalError.apply(console, args);
        };
      </script>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
      <style>
        :root {
          --navy-900: #0A1628;
          --navy-800: #0F2340;
          --navy-700: #1B365D;
          --navy-600: #2C4A7C;
          --navy-500: #4A6FA5;
          --navy-400: #7B9CC8;
          --navy-300: #A8BFD8;
          --navy-200: #D0DDEB;
          --navy-100: #EAF0F6;
          --navy-50:  #F5F8FB;
          --cream-100: #FAF8F5;
          --cream-200: #F3EDE6;
          --cream-300: #E8DFD4;
          --green-500: #059669;
          --green-400: #10B981;
          --green-100: #D1FAE5;
          --green-900: #064E3B;
          --red-500: #DC2626;
          --red-100: #FEE2E2;
          --red-900: #7F1D1D;
          --amber-500: #D97706;
          --amber-100: #FEF3C7;
          --amber-900: #78350F;
          --blue-500: #3B82F6;
          --blue-100: #DBEAFE;
          --blue-900: #1E3A5F;
          --surface: #FFFFFF;
          --surface-raised: #FFFFFF;
          --bg: var(--cream-100);
          --text-primary: #1A1D21;
          --text-secondary: #5E6470;
          --text-muted: #9CA3AF;
          --border: #E5E7EB;
          --border-hover: #D1D5DB;
          --radius-sm: 8px;
          --radius-md: 12px;
          --radius-lg: 16px;
          --radius-xl: 20px;
          --shadow-xs: 0 1px 2px rgba(0,0,0,0.04);
          --shadow-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
          --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -2px rgba(0,0,0,0.05);
          --shadow-lg: 0 10px 25px -3px rgba(0,0,0,0.08), 0 4px 6px -4px rgba(0,0,0,0.04);
          --shadow-xl: 0 20px 50px -12px rgba(0,0,0,0.12);
          --transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }

        *, *::before, *::after {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: var(--bg);
          color: var(--text-primary);
          -webkit-font-smoothing: antialiased;
          -moz-osx-font-smoothing: grayscale;
          line-height: 1.5;
          font-size: 14px;
        }

        .brand-bar {
          background: linear-gradient(90deg, var(--navy-800), var(--navy-700), var(--navy-600));
          height: 3px;
          width: 100%;
        }
        
        .header {
          background: var(--surface);
          border-bottom: 1px solid var(--border);
          padding: 0;
          position: sticky;
          top: 0;
          z-index: 100;
          backdrop-filter: blur(12px);
          background: rgba(255,255,255,0.95);
        }
        
        .header-content {
          max-width: 1320px;
          margin: 0 auto;
          padding: 14px 28px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        
        .logo-area {
          display: flex;
          align-items: center;
          gap: 14px;
        }
        
        .logo {
          height: 36px;
          width: auto;
        }
        
        .logo-divider {
          width: 1px;
          height: 28px;
          background: var(--border);
        }
        
        .logo-text {
          font-size: 15px;
          font-weight: 700;
          color: var(--navy-700);
          letter-spacing: -0.03em;
        }
        
        .logo-text small {
          display: block;
          font-size: 10px;
          font-weight: 500;
          color: var(--navy-400);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          margin-top: 2px;
        }
        
        .header-status {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 13px;
          color: var(--text-secondary);
        }
        
        .role-badge {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 4px 12px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .role-admin   { background: var(--navy-700); color: #fff; }
        .role-builder { background: var(--navy-500); color: #fff; }
        .role-viewer  { background: var(--navy-100); color: var(--navy-600); }
        
        .user-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 14px 18px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          transition: all var(--transition);
        }
        .user-row:hover { background: var(--navy-50); border-color: var(--border-hover); }
        .user-row-email { font-weight: 500; font-size: 14px; color: var(--text-primary); }
        .user-row-actions { display: flex; gap: 8px; align-items: center; }
        
        .status-indicator {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 12px;
          background: var(--green-100);
          border-radius: 999px;
          font-size: 12px;
          font-weight: 500;
          color: var(--green-900);
        }
        
        .status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--green-500);
          animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.85); }
        }
        
        .main {
          max-width: 1320px;
          margin: 0 auto;
          padding: 32px 28px 60px;
        }
        
        .page-header {
          margin-bottom: 32px;
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 16px;
          flex-wrap: wrap;
        }

        .page-header-text {
          min-width: 260px;
        }

        .page-header-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        
        .page-header h1 {
          font-size: 28px;
          font-weight: 800;
          margin-bottom: 6px;
          color: var(--navy-800);
          letter-spacing: -0.04em;
        }
        
        .page-header p {
          color: var(--text-secondary);
          font-size: 14px;
          font-weight: 400;
        }

        /* Tabs */
        .tabs {
          display: flex;
          gap: 4px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          padding: 4px;
          margin-bottom: 28px;
          width: fit-content;
        }

        .tab {
          background: none;
          border: none;
          padding: 10px 20px;
          font-size: 13px;
          font-weight: 600;
          color: var(--text-secondary);
          cursor: pointer;
          border-radius: var(--radius-sm);
          transition: all var(--transition);
          white-space: nowrap;
        }

        .tab:hover {
          color: var(--navy-700);
          background: var(--navy-50);
        }

        .tab.active {
          color: #fff;
          background: var(--navy-700);
          box-shadow: var(--shadow-sm);
        }

        .tab-panel {
          display: none;
        }

        .tab-panel.active {
          display: block;
          animation: fadeIn 0.25s ease;
        }

        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        /* Debug Log */
        .debug-log-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          padding: 24px;
          box-shadow: var(--shadow-sm);
          max-width: 900px;
        }

        .debug-log-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 16px;
        }

        .debug-log-list {
          max-height: 500px;
          overflow-y: auto;
          font-family: 'Menlo', 'Monaco', 'Consolas', monospace;
          font-size: 12px;
          line-height: 1.6;
        }

        .debug-log-entry {
          padding: 10px 12px;
          border-bottom: 1px solid var(--border);
          display: grid;
          grid-template-columns: 140px 120px 1fr;
          gap: 12px;
          align-items: start;
        }

        .debug-log-entry:hover {
          background: var(--navy-50);
        }

        .debug-log-entry .log-time {
          color: var(--text-muted);
          font-size: 11px;
          white-space: nowrap;
        }

        .debug-log-entry .log-area {
          padding: 2px 8px;
          border-radius: 4px;
          background: var(--navy-100);
          color: var(--navy-700);
          font-size: 11px;
          font-weight: 600;
          text-align: center;
          white-space: nowrap;
        }

        .debug-log-entry .log-message {
          color: var(--text-primary);
          word-break: break-word;
        }

        .debug-log-empty {
          text-align: center;
          padding: 40px;
          color: var(--text-muted);
          font-size: 14px;
        }

        .status-ok {
          background: var(--green-100);
          color: var(--green-900);
        }

        .status-bad {
          background: var(--red-100);
          color: var(--red-900);
        }

        .action-row {
          display: flex;
          gap: 10px;
          margin-top: 18px;
        }

        /* Discount Simulator */
        .sim-panel {
          background: var(--surface);
          border: 2px solid var(--navy-200);
          border-radius: var(--radius-md);
          padding: 0;
          margin-top: 20px;
          overflow: hidden;
        }
        .sim-header {
          background: linear-gradient(135deg, var(--navy-800), var(--navy-700));
          color: white;
          padding: 14px 18px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .sim-header-title {
          font-size: 14px;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .sim-header-badge {
          background: rgba(255,255,255,0.15);
          padding: 2px 8px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.5px;
        }
        .sim-body {
          padding: 16px 18px;
        }
        .sim-search-wrap {
          position: relative;
        }
        .sim-search-input {
          width: 100%;
          padding: 10px 14px 10px 36px;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          font-size: 13px;
          background: var(--surface);
          transition: border-color 0.15s;
          box-sizing: border-box;
        }
        .sim-search-input:focus {
          border-color: var(--navy-400);
          outline: none;
          box-shadow: 0 0 0 3px rgba(75,111,165,0.1);
        }
        .sim-search-icon {
          position: absolute;
          left: 12px;
          top: 50%;
          transform: translateY(-50%);
          color: var(--text-muted);
          font-size: 14px;
          pointer-events: none;
        }
        .sim-dropdown {
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          background: var(--surface);
          border: 1px solid var(--border);
          border-top: none;
          border-radius: 0 0 var(--radius-sm) var(--radius-sm);
          max-height: 240px;
          overflow-y: auto;
          z-index: 100;
          box-shadow: 0 8px 24px rgba(0,0,0,0.12);
          display: none;
        }
        .sim-dropdown.open { display: block; }
        .sim-dropdown-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 14px;
          cursor: pointer;
          font-size: 12px;
          transition: background 0.1s;
          border-bottom: 1px solid var(--border);
        }
        .sim-dropdown-item:last-child { border-bottom: none; }
        .sim-dropdown-item:hover {
          background: var(--navy-50);
        }
        .sim-dropdown-item img {
          width: 32px;
          height: 32px;
          object-fit: cover;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .sim-dropdown-item .no-img {
          width: 32px;
          height: 32px;
          background: var(--navy-100);
          border-radius: 4px;
          flex-shrink: 0;
        }
        .sim-actions-bar {
          display: flex;
          gap: 8px;
          margin-top: 10px;
          flex-wrap: wrap;
        }
        .sim-btn {
          padding: 6px 14px;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          border: 1px solid var(--border);
          background: var(--navy-50);
          color: var(--navy-700);
          transition: all 0.15s;
          display: inline-flex;
          align-items: center;
          gap: 5px;
        }
        .sim-btn:hover { background: var(--navy-100); }
        .sim-btn-primary {
          background: var(--navy-700);
          color: white;
          border-color: var(--navy-700);
        }
        .sim-btn-primary:hover { background: var(--navy-800); }
        .sim-btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .sim-product-list {
          margin-top: 12px;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          overflow: hidden;
        }
        .sim-product-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          font-size: 12px;
          border-bottom: 1px solid var(--border);
          transition: background 0.1s;
        }
        .sim-product-row:last-child { border-bottom: none; }
        .sim-product-row:hover { background: var(--navy-50); }
        .sim-product-row img {
          width: 36px;
          height: 36px;
          object-fit: cover;
          border-radius: 6px;
          flex-shrink: 0;
        }
        .sim-product-row .no-img {
          width: 36px;
          height: 36px;
          background: var(--navy-100);
          border-radius: 6px;
          flex-shrink: 0;
        }
        .sim-product-info { flex: 1; min-width: 0; }
        .sim-product-title {
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .sim-product-meta {
          color: var(--text-muted);
          font-size: 10px;
          margin-top: 1px;
        }
        .sim-product-price {
          text-align: right;
          white-space: nowrap;
          min-width: 70px;
        }
        .sim-product-remove {
          background: none;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          font-size: 14px;
          padding: 2px 4px;
          line-height: 1;
          border-radius: 4px;
        }
        .sim-product-remove:hover { color: var(--red-500); background: var(--red-100); }
        .sim-result-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          font-size: 12px;
          border-bottom: 1px solid var(--border);
        }
        .sim-result-row:last-child { border-bottom: none; }
        .sim-result-row.eligible { background: #F0FDF4; }
        .sim-result-row.excluded { background: #FFF7ED; }
        .sim-result-badge {
          font-size: 10px;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 4px;
          white-space: nowrap;
        }
        .sim-result-badge.pass { background: var(--green-100); color: var(--green-900); }
        .sim-result-badge.fail { background: var(--red-100); color: var(--red-900); }
        .sim-reason {
          font-size: 10px;
          margin-top: 3px;
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }
        .sim-reason-chip {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 1px 6px;
          border-radius: 3px;
          font-size: 9px;
          font-weight: 600;
        }
        .sim-reason-chip.pass { background: #D1FAE5; color: #065F46; }
        .sim-reason-chip.fail { background: #FEE2E2; color: #991B1B; }
        .sim-summary {
          margin-top: 12px;
          background: linear-gradient(135deg, var(--navy-50), var(--cream-100));
          border: 1px solid var(--navy-200);
          border-radius: var(--radius-sm);
          padding: 14px 18px;
          display: flex;
          justify-content: space-around;
          text-align: center;
          gap: 12px;
        }
        .sim-stat { flex: 1; }
        .sim-stat-value { font-size: 20px; font-weight: 800; color: var(--navy-800); }
        .sim-stat-label { font-size: 10px; color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .sim-stat-value.green { color: var(--green-500); }
        .sim-stat-value.red { color: var(--red-500); }
        .sim-empty {
          text-align: center;
          padding: 24px 16px;
          color: var(--text-muted);
          font-size: 12px;
        }
        .sim-empty-icon { font-size: 28px; margin-bottom: 6px; }
        .sim-price-strike {
          text-decoration: line-through;
          color: var(--text-muted);
          font-size: 10px;
        }
        .sim-price-final {
          font-weight: 700;
          color: var(--green-500);
        }
        .sim-price-savings {
          font-size: 10px;
          color: var(--green-500);
          font-weight: 600;
        }

        /* Buttons */
        .action-btn {
          background: var(--navy-700);
          color: white;
          border: none;
          border-radius: var(--radius-sm);
          padding: 10px 18px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all var(--transition);
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        
        .action-btn:hover {
          background: var(--navy-800);
          box-shadow: var(--shadow-md);
          transform: translateY(-1px);
        }

        .action-btn.secondary {
          background: var(--surface);
          color: var(--navy-700);
          border: 1px solid var(--border);
        }

        .action-btn.secondary:hover {
          background: var(--navy-50);
          border-color: var(--navy-300);
        }
        
        /* Sections */
        .section {
          margin-bottom: 40px;
        }
        
        .section-title {
          font-size: 16px;
          font-weight: 700;
          margin-bottom: 18px;
          color: var(--text-primary);
          display: flex;
          align-items: center;
          gap: 10px;
          letter-spacing: -0.01em;
        }
        
        .section-title .badge {
          background: var(--navy-700);
          color: white;
          padding: 3px 10px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
        }
        
        /* Discount Grid */
        .discount-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 18px;
        }
        
        .discount-card {
          background: var(--surface);
          border-radius: var(--radius-lg);
          border: 1px solid var(--border);
          transition: all var(--transition);
          position: relative;
          overflow: hidden;
        }

        .card-accent {
          height: 4px;
          width: 100%;
          background: linear-gradient(90deg, var(--navy-700), var(--navy-500));
        }

        .card-body {
          padding: 22px 24px 20px;
        }

        .discount-card:hover {
          box-shadow: var(--shadow-lg);
          border-color: var(--border-hover);
          transform: translateY(-2px);
        }

        .paused-card {
          border-color: #FDE68A;
        }
        .paused-card:hover {
          border-color: var(--amber-500);
        }

        .expired-card {
          opacity: 0.65;
          border-style: dashed;
        }
        .expired-card:hover {
          opacity: 0.85;
        }
        
        .discount-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          margin-bottom: 10px;
          gap: 10px;
        }
        
        .discount-title {
          font-size: 14px;
          font-weight: 700;
          color: var(--text-primary);
          letter-spacing: -0.01em;
          line-height: 1.35;
        }

        .discount-meta {
          display: flex;
          align-items: center;
          gap: 6px;
          margin-top: 6px;
          flex-wrap: wrap;
        }

        .source-badge {
          padding: 2px 8px;
          border-radius: 10px;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.2px;
        }
        .source-fn {
          background: #EDE9FE;
          color: #7C3AED;
        }
        .source-ship {
          background: #D1FAE5;
          color: #065F46;
        }
        
        .discount-badge {
          padding: 4px 10px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 700;
          white-space: nowrap;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          flex-shrink: 0;
        }
        
        .badge-active {
          background: var(--green-100);
          color: var(--green-900);
        }
        
        .badge-inactive {
          background: var(--amber-100);
          color: var(--amber-900);
        }

        .badge-expired {
          background: #F3F4F6;
          color: #6B7280;
        }

        .badge-scheduled {
          background: #EEF2FF;
          color: #4F46E5;
        }

        /* Live on Shopify indicator */
        .live-indicator {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 10px;
          font-weight: 700;
          color: #059669;
          background: #ECFDF5;
          border: 1px solid #A7F3D0;
          padding: 2px 8px;
          border-radius: 10px;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          margin-left: 6px;
        }
        .live-dot {
          width: 7px;
          height: 7px;
          background: #10B981;
          border-radius: 50%;
          animation: livePulse 1.5s ease-in-out infinite;
        }
        @keyframes livePulse {
          0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(16,185,129,0.5); }
          50% { opacity: 0.7; box-shadow: 0 0 0 4px rgba(16,185,129,0); }
        }

        .countdown-row {
          background: linear-gradient(90deg, rgba(99,102,241,0.06), rgba(99,102,241,0.02));
          border-radius: 6px;
          padding: 6px 10px;
          margin-top: 4px;
        }
        .countdown-timer {
          font-variant-numeric: tabular-nums;
          font-weight: 600;
          font-size: 13px;
        }
        .scheduled-card {
          border-left: 3px solid #6366F1 !important;
        }
        .scheduled-card .card-accent {
          background: linear-gradient(90deg, #6366F1, #818CF8) !important;
        }
        
        .badge-percentage {
          background: var(--blue-100);
          color: var(--blue-900);
        }
        
        .badge-shipping {
          background: var(--green-100);
          color: var(--green-900);
        }
        
        .discount-value {
          font-size: 36px;
          font-weight: 800;
          color: var(--navy-700);
          margin-bottom: 14px;
          letter-spacing: -0.04em;
          line-height: 1;
        }
        
        .discount-info {
          font-size: 13px;
          color: var(--text-secondary);
          margin-bottom: 18px;
          line-height: 1.5;
          border-top: 1px solid var(--border);
          padding-top: 12px;
        }
        
        .discount-info-row {
          display: flex;
          justify-content: space-between;
          padding: 5px 0;
        }
        
        .info-label {
          color: var(--text-muted);
          font-size: 12px;
          font-weight: 500;
        }
        
        .info-value {
          color: var(--text-primary);
          font-weight: 500;
          font-size: 12px;
        }
        
        .discount-actions {
          display: flex;
          gap: 8px;
          margin-top: 0;
          padding-top: 14px;
          border-top: 1px solid var(--border);
        }

        .card-details-toggle {
          background: var(--navy-50);
          border: 1px dashed var(--border);
          color: var(--navy-600);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          padding: 8px 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.15s;
          width: 100%;
          border-radius: var(--radius-sm);
          margin-top: 4px;
        }
        .card-details-toggle:hover {
          background: var(--navy-100);
          border-color: var(--navy-300);
          color: var(--navy-800);
        }
        .card-details {
          max-height: 0;
          overflow: hidden;
          transition: max-height 0.35s ease;
        }
        .card-details.open {
          max-height: 600px;
        }
        .card-details-inner {
          padding: 10px 0 4px;
          border-top: 1px dashed var(--border);
        }
        .detail-row {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 4px 0;
          font-size: 12px;
          gap: 12px;
        }
        .detail-label {
          color: var(--text-muted);
          font-weight: 500;
          white-space: nowrap;
          min-width: 80px;
        }
        .detail-value {
          color: var(--text-primary);
          font-weight: 500;
          text-align: right;
          word-break: break-word;
        }
        .detail-tag {
          display: inline-block;
          background: var(--blue-100, #DBEAFE);
          color: var(--blue-900, #1E3A5F);
          padding: 1px 7px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 600;
          margin: 1px 0;
        }
        .detail-tag.exclude {
          background: #FEE2E2;
          color: #991B1B;
        }
        
        .btn {
          flex: 0 1 auto;
          padding: 8px 16px;
          border: none;
          border-radius: var(--radius-sm);
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all var(--transition);
          white-space: nowrap;
          display: inline-flex;
          align-items: center;
          gap: 5px;
          line-height: 1;
        }
        
        .btn-edit {
          background: var(--amber-500);
          color: white;
        }
        .btn-edit:hover {
          background: #B45309;
        }
        
        .btn-delete {
          background: var(--navy-50);
          color: var(--text-secondary);
          border: 1px solid var(--border);
        }
        .btn-delete:hover {
          background: var(--navy-100);
          border-color: var(--border-hover);
        }
        
        .btn-success {
          background: var(--green-500);
          color: white;
        }
        .btn-success:hover {
          background: #047857;
        }

        .btn-resume {
          background: var(--green-500);
          color: white;
          flex: 1;
        }
        .btn-resume:hover {
          background: #047857;
          box-shadow: var(--shadow-sm);
        }

        .btn-pause-deployed {
          background: var(--amber-100);
          color: var(--amber-900);
          border: 1px solid #FDE68A;
          flex: 1;
        }
        .btn-pause-deployed:hover {
          background: var(--amber-500);
          color: white;
          border-color: var(--amber-500);
        }

        .btn-ghost {
          background: var(--red-100);
          color: var(--red-500);
          border: 1px solid #FECACA;
          padding: 8px 12px;
        }
        .btn-ghost:hover {
          background: var(--red-500);
          color: white;
          border-color: var(--red-500);
        }
        
        .btn-primary {
          background: var(--navy-700);
          color: white;
        }
        .btn-primary:hover {
          background: var(--navy-800);
        }
        
        .btn-secondary {
          background: var(--navy-50);
          color: var(--navy-700);
          border: 1px solid var(--border);
        }
        .btn-secondary:hover {
          background: var(--navy-100);
        }

        .btn-danger {
          background: var(--red-100);
          color: var(--red-500);
          border: 1px solid #FECACA;
        }
        .btn-danger:hover {
          background: var(--red-500);
          color: white;
          border-color: var(--red-500);
        }

        .btn-archive {
          background: var(--amber-100);
          color: var(--amber-900);
          border: 1px solid #FDE68A;
        }
        .btn-archive:hover {
          background: var(--amber-500);
          color: white;
          border-color: var(--amber-500);
        }

        .btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
          pointer-events: none;
        }

        .badge-archived {
          background: var(--amber-100);
          color: var(--amber-900);
        }

        .badge-muted {
          background: var(--navy-100);
          color: var(--navy-600);
          font-size: 11px;
          padding: 3px 10px;
          border-radius: 999px;
          margin-left: 6px;
          font-weight: 600;
        }

        .archived-card {
          opacity: 0.7;
          background: var(--cream-100);
          transition: opacity var(--transition);
        }
        .archived-card::before {
          background: linear-gradient(90deg, var(--amber-500), var(--amber-900)) !important;
        }
        .archived-card:hover {
          opacity: 1;
        }

        #archivedSection {
          border-top: 1px solid var(--border);
          padding-top: 20px;
          margin-top: 8px;
        }

        #archivedSection .section-title {
          user-select: none;
        }
        
        /* Create Cards */
        .create-options {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
          gap: 16px;
        }
        
        .create-card {
          background: var(--surface);
          border: 1px dashed var(--border-hover);
          border-radius: var(--radius-lg);
          padding: 36px 28px;
          text-align: center;
          cursor: pointer;
          transition: all 0.3s ease;
          position: relative;
        }
        
        .create-card:hover {
          background: var(--navy-50);
          border-color: var(--navy-400);
          border-style: solid;
          transform: translateY(-3px);
          box-shadow: var(--shadow-lg);
        }
        
        .create-icon {
          width: 56px;
          height: 56px;
          display: flex;
          align-items: center;
          justify-content: center;
          margin: 0 auto 16px;
          font-size: 26px;
          border-radius: var(--radius-md);
          background: var(--navy-100);
          color: var(--navy-700);
        }
        
        .create-title {
          font-size: 15px;
          font-weight: 700;
          margin-bottom: 6px;
          color: var(--text-primary);
          letter-spacing: -0.01em;
        }
        
        .create-desc {
          font-size: 13px;
          color: var(--text-secondary);
          margin-bottom: 18px;
          line-height: 1.5;
        }
        
        .create-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: var(--navy-700);
          color: white;
          padding: 10px 24px;
          border-radius: var(--radius-sm);
          font-weight: 600;
          font-size: 13px;
          border: none;
          cursor: pointer;
          transition: all var(--transition);
        }
        
        .create-btn:hover {
          background: var(--navy-800);
          box-shadow: var(--shadow-md);
          transform: translateY(-1px);
        }
        
        .empty-state {
          text-align: center;
          padding: 48px 24px;
          background: var(--surface);
          border-radius: var(--radius-lg);
          border: 1px solid var(--border);
        }
        
        .empty-icon {
          font-size: 48px;
          margin-bottom: 15px;
        }
        
        .empty-text {
          color: var(--text-secondary);
          font-size: 14px;
          margin-bottom: 20px;
        }

        /* Summary Cards */
        .summary-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 16px;
          margin-bottom: 32px;
        }
        .summary-card {
          border-radius: var(--radius-lg);
          padding: 22px 24px;
          display: flex;
          align-items: center;
          gap: 16px;
          position: relative;
          overflow: hidden;
        }
        .summary-card::after {
          content: '';
          position: absolute;
          top: 0;
          right: 0;
          width: 100px;
          height: 100px;
          border-radius: 50%;
          background: rgba(255,255,255,0.06);
          transform: translate(30%, -30%);
        }
        .summary-icon {
          width: 46px;
          height: 46px;
          border-radius: var(--radius-md);
          background: rgba(255,255,255,0.15);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 20px;
          color: white;
          flex-shrink: 0;
          backdrop-filter: blur(4px);
        }
        .summary-value {
          font-size: 24px;
          font-weight: 800;
          color: #fff;
          letter-spacing: -0.04em;
          line-height: 1.1;
        }
        .summary-label {
          font-size: 11px;
          color: rgba(255,255,255,0.65);
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-top: 3px;
        }

        /* Scrollbar */
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--navy-200); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: var(--navy-300); }

        /* Responsive */
        @media (max-width: 768px) {
          .header-content { padding: 12px 16px; }
          .main { padding: 20px 16px 40px; }
          .page-header { flex-direction: column; align-items: flex-start; }
          .page-header-actions { width: 100%; }
          .tabs { flex-wrap: wrap; width: 100%; }
          .tab { flex: 1; text-align: center; min-width: 0; padding: 10px 12px; }
          .discount-grid { grid-template-columns: 1fr; }
          .summary-grid { grid-template-columns: repeat(2, 1fr); }
          .form-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 1100px) and (min-width: 769px) {
          .summary-grid { grid-template-columns: repeat(3, 1fr); }
        }

        /* Form System */
        .form-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          padding: 28px;
          margin-bottom: 24px;
        }
        .form-card-title {
          font-size: 15px;
          font-weight: 700;
          color: var(--text-primary);
          margin-bottom: 20px;
          letter-spacing: -0.01em;
        }
        .form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        .form-group {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .form-group.full {
          grid-column: 1 / -1;
        }
        .form-label {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .form-input {
          width: 100%;
          padding: 10px 14px;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          font-size: 14px;
          font-family: inherit;
          color: var(--text-primary);
          background: var(--surface);
          transition: all var(--transition);
          box-sizing: border-box;
        }
        .form-input:focus {
          outline: none;
          border-color: var(--navy-500);
          box-shadow: 0 0 0 3px rgba(74,111,165,0.12);
        }
        .form-input::placeholder {
          color: var(--text-muted);
        }
        .form-hint {
          font-size: 11px;
          color: var(--text-muted);
          margin-top: 2px;
        }
        .form-actions {
          display: flex;
          gap: 12px;
          margin-top: 20px;
          align-items: center;
        }
        .flair-input-wrap {
          position: relative;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          padding: 6px 8px;
          min-height: 42px;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 6px;
          cursor: text;
          transition: border-color 0.15s;
        }
        .flair-input-wrap:focus-within {
          border-color: var(--navy-500);
        }
        .flair-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 10px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 600;
          white-space: nowrap;
          line-height: 1.3;
        }
        .flair-chip.include {
          background: var(--blue-100, #DBEAFE);
          color: var(--blue-900, #1E3A5F);
        }
        .flair-chip.exclude {
          background: #FEE2E2;
          color: #991B1B;
        }
        .flair-chip.vendor {
          background: #F3E8FF;
          color: #6B21A8;
        }
        .flair-chip.bxgy {
          background: #D1FAE5;
          color: #065F46;
        }
        .flair-chip-remove {
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
          opacity: 0.6;
          margin-left: 2px;
        }
        .flair-chip-remove:hover { opacity: 1; }
        .flair-text-input {
          border: none;
          outline: none;
          background: transparent;
          font-size: 13px;
          flex: 1;
          min-width: 80px;
          padding: 2px 0;
          color: var(--text-primary);
        }
        .flair-suggestions {
          display: none;
          position: absolute;
          top: 100%;
          left: 0;
          right: 0;
          z-index: 50;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          box-shadow: var(--shadow-lg);
          max-height: 180px;
          overflow-y: auto;
          margin-top: 2px;
        }
        .flair-suggestions.open { display: block; }
        .flair-suggestion-item {
          padding: 6px 12px;
          font-size: 12px;
          cursor: pointer;
          transition: background 0.1s;
        }
        .flair-suggestion-item:hover {
          background: var(--navy-50);
        }
        .deploy-status-text {
          align-self: center;
          font-size: 13px;
          color: var(--text-secondary);
        }

        /* Deployed List */
        .deployed-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 14px;
        }
        .deployed-title {
          font-size: 15px;
          font-weight: 700;
          color: var(--text-primary);
        }
        .deployed-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .deployed-placeholder {
          text-align: center;
          padding: 24px;
          color: var(--text-muted);
          font-size: 13px;
        }

        /* Threshold Preview */
        .threshold-preview {
          margin-top: 16px;
          padding: 18px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
        }
        .threshold-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
        }
        .threshold-label {
          font-size: 11px;
          font-weight: 700;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .threshold-value {
          font-size: 18px;
          font-weight: 800;
          color: var(--navy-700);
        }
        .threshold-bar-bg {
          position: relative;
          height: 8px;
          background: var(--navy-100);
          border-radius: 4px;
          overflow: hidden;
        }
        .threshold-bar-fill {
          position: absolute;
          left: 0; top: 0;
          height: 100%;
          background: linear-gradient(90deg, var(--green-400), var(--green-500));
          border-radius: 4px;
          transition: width 0.3s ease;
        }
        .threshold-footer {
          display: flex;
          justify-content: space-between;
          margin-top: 5px;
          font-size: 11px;
          color: var(--text-muted);
        }
        .threshold-active-label {
          color: var(--green-500);
          font-weight: 700;
        }

        /* Checkbox Group */
        .checkbox-group {
          display: flex;
          gap: 16px;
          flex-wrap: wrap;
          margin-top: 4px;
        }
        .checkbox-label {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 13px;
          cursor: pointer;
          color: var(--text-primary);
        }
        .checkbox-label input[type="checkbox"] {
          accent-color: var(--navy-700);
        }

        /* Info Box */
        .info-box {
          margin-top: 24px;
          padding: 16px 18px;
          background: var(--amber-100);
          border-radius: var(--radius-md);
          border-left: 4px solid var(--amber-500);
          font-size: 13px;
          color: var(--text-primary);
          line-height: 1.6;
        }
        .info-box strong {
          color: var(--amber-900);
        }
        .info-box code {
          font-size: 12px;
          background: rgba(0,0,0,0.05);
          padding: 2px 6px;
          border-radius: 4px;
        }

        /* WASM Badge */
        .wasm-badge {
          background: var(--navy-700);
          color: white;
          padding: 4px 12px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.6px;
          text-transform: uppercase;
        }

        /* Toast Notification */
        .toast {
          position: fixed;
          bottom: 24px;
          right: 24px;
          padding: 14px 24px;
          border-radius: var(--radius-md);
          font-size: 14px;
          font-weight: 600;
          color: white;
          background: var(--navy-800);
          box-shadow: var(--shadow-xl);
          z-index: 10000;
          animation: slideUp 0.3s ease, fadeOut 0.3s ease 2.7s;
          pointer-events: none;
        }
        .toast.success { background: var(--green-500); }
        .toast.error { background: var(--red-500); }

        @keyframes slideUp {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes fadeOut {
          from { opacity: 1; }
          to { opacity: 0; }
        }

        /* Confirmation Modal */
        .confirm-overlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.45);
          z-index: 10001;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 0.2s ease;
        }
        .confirm-overlay.visible { opacity: 1; }
        .confirm-dialog {
          background: white;
          border-radius: var(--radius-lg);
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          padding: 28px 32px 24px;
          max-width: 420px;
          width: 90%;
          transform: scale(0.92) translateY(10px);
          transition: transform 0.25s cubic-bezier(.4,0,.2,1);
        }
        .confirm-overlay.visible .confirm-dialog {
          transform: scale(1) translateY(0);
        }
        .confirm-dialog h3 {
          margin: 0 0 8px;
          font-size: 17px;
          font-weight: 700;
          color: var(--navy-900);
        }
        .confirm-dialog p {
          margin: 0 0 22px;
          font-size: 14px;
          color: var(--text-muted);
          line-height: 1.5;
        }
        .confirm-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
        }
        .confirm-actions .btn-confirm-cancel {
          padding: 9px 20px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border);
          background: white;
          color: var(--text-primary);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s;
        }
        .confirm-actions .btn-confirm-cancel:hover { background: var(--gray-100); }
        .confirm-actions .btn-confirm-ok {
          padding: 9px 20px;
          border-radius: var(--radius-md);
          border: none;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          color: white;
          transition: filter 0.15s;
        }
        .confirm-actions .btn-confirm-ok:hover { filter: brightness(1.1); }
        .confirm-actions .btn-confirm-ok.danger { background: var(--red-500); }
        .confirm-actions .btn-confirm-ok.warning { background: var(--orange-500, #ea580c); }
        .confirm-actions .btn-confirm-ok.primary { background: var(--navy-700); }

        /* Footer */
        .app-footer {
          max-width: 1320px;
          margin: 0 auto;
          padding: 24px 28px 32px;
          border-top: 1px solid var(--border);
          display: flex;
          justify-content: space-between;
          align-items: center;
          color: var(--text-muted);
          font-size: 12px;
        }
        .app-footer a {
          color: var(--navy-500);
          text-decoration: none;
        }
        .app-footer a:hover {
          text-decoration: underline;
        }
      </style>
    </head>
    <body>
      <!-- Password Login Gate -->
      <div id="gcwLoginGate" style="display:none;position:fixed;inset:0;z-index:99999;background:linear-gradient(135deg,#0F2340 0%,#1B365D 100%);align-items:center;justify-content:center;">
        <div style="background:#fff;border-radius:16px;padding:40px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);text-align:center;">
          <img src="/gcw-logo.svg" alt="GCW" style="height:40px;margin-bottom:16px;" onerror="this.style.display='none'">
          <h2 style="margin:0 0 8px;font-size:20px;color:#1A1D21;font-family:Inter,sans-serif;">Discount Manager</h2>
          <p style="margin:0 0 24px;font-size:13px;color:#5E6470;font-family:Inter,sans-serif;">Enter your password to continue</p>
          <form id="gcwLoginForm" autocomplete="off" style="display:flex;flex-direction:column;gap:12px;">
            <input id="gcwPasswordInput" type="password" placeholder="Password" autocomplete="current-password" style="padding:10px 14px;border:1px solid #D1D5DB;border-radius:8px;font-size:14px;font-family:Inter,sans-serif;outline:none;transition:border-color 0.2s;" onfocus="this.style.borderColor='#1B365D'" onblur="this.style.borderColor='#D1D5DB'">
            <button type="submit" style="padding:10px 14px;background:#1B365D;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;font-family:Inter,sans-serif;cursor:pointer;transition:background 0.2s;" onmouseover="this.style.background='#2C4A7C'" onmouseout="this.style.background='#1B365D'">Sign In</button>
            <p id="gcwLoginError" style="display:none;color:#DC2626;font-size:13px;margin:0;font-family:Inter,sans-serif;"></p>
          </form>
        </div>
      </div>
      <script>
      (function() {
        var gate = document.getElementById('gcwLoginGate');
        var PW_KEY = 'gcw_app_password';
        var AUTH_PASSWORD = '';
        try { AUTH_PASSWORD = sessionStorage.getItem(PW_KEY) || ''; } catch {}

        // In embedded contexts, third-party cookies can be blocked.
        // Keep a session-scoped password fallback and attach it as a header.
        var nativeFetch = window.fetch.bind(window);
        window.fetch = function(input, init) {
          init = init || {};
          var headers = new Headers(init.headers || {});
          var savedPw = AUTH_PASSWORD;
          if (!savedPw) {
            try { savedPw = sessionStorage.getItem(PW_KEY) || ''; } catch { savedPw = ''; }
          }
          if (savedPw && !headers.has('x-gcw-password')) {
            headers.set('x-gcw-password', savedPw);
          }
          init.headers = headers;
          if (!init.credentials) init.credentials = 'same-origin';
          return nativeFetch(input, init);
        };

        function setAppVisibility(isAuthenticated) {
          gate.style.display = isAuthenticated ? 'none' : 'flex';
          gate.style.pointerEvents = isAuthenticated ? 'none' : 'auto';
        }

        // Check auth status on load
        fetch('/api/auth/status', { credentials: 'same-origin' })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.authenticated) {
              setAppVisibility(true);
            } else {
              setAppVisibility(false);
              document.getElementById('gcwPasswordInput').focus();
            }
          })
          .catch(function() {
            setAppVisibility(false);
            document.getElementById('gcwPasswordInput').focus();
          });

        document.getElementById('gcwLoginForm').addEventListener('submit', function(e) {
          e.preventDefault();
          var pw = document.getElementById('gcwPasswordInput').value;
          var errEl = document.getElementById('gcwLoginError');
          errEl.style.display = 'none';
          fetch('/api/auth/password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ password: pw })
          }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
            .then(function(result) {
              if (result.ok && result.data.success) {
                AUTH_PASSWORD = pw;
                try { sessionStorage.setItem(PW_KEY, pw); } catch {}
                setAppVisibility(true);
              } else {
                errEl.textContent = result.data.error || 'Incorrect password';
                errEl.style.display = 'block';
                document.getElementById('gcwPasswordInput').value = '';
                document.getElementById('gcwPasswordInput').focus();
              }
            })
            .catch(function() {
              errEl.textContent = 'Connection error. Please try again.';
              errEl.style.display = 'block';
            });
        });
      })();
      </script>

      <div class="brand-bar"></div>
      <div class="header">
        <div class="header-content">
          <div class="logo-area">
            <img class="logo" src="/gcw-logo.svg" alt="Gerber Childrenswear" />
            <div class="logo-divider"></div>
            <div class="logo-text">Discount Manager<small>Shopify Functions &middot; WASM</small></div>
          </div>
          <div class="header-status">
            <span class="role-badge role-${escHtml(userRole)}">${escHtml(ROLES[userRole]?.label || userRole)}</span>
            ${userEmail ? '<span style="color:var(--text-muted);font-size:12px;">' + escHtml(userEmail) + '</span>' : ''}
            <div class="status-indicator"><div class="status-dot"></div> Active</div>
          </div>
        </div>
      </div>
      
      <div class="main">
        <div class="page-header">
          <div class="page-header-text">
            <h1>Discount Manager</h1>
            <p>Enterprise discount automation powered by Shopify Functions &amp; Rust/WASM</p>
          </div>
          <div class="page-header-actions">
            <a class="action-btn secondary" href="https://admin.shopify.com/store/${escHtml(shop.replace('.myshopify.com', ''))}/discounts" target="_blank" rel="noopener">&#x2197; Shopify Discounts</a>
            <a class="action-btn secondary" href="https://${escHtml(shop)}/" target="_blank" rel="noopener">&#x2197; Preview Store</a>
          </div>
        </div>

        <!-- Dashboard Summary Cards -->
        <div class="summary-grid" id="dashboardSummary">
          <div class="summary-card" style="background:linear-gradient(135deg,#1E3A5F,#3B6BA5);">
            <div class="summary-icon">%</div>
            <div><div class="summary-value" id="summaryProductRules">&mdash;</div><div class="summary-label">Product Rules</div></div>
          </div>
          <div class="summary-card" style="background:linear-gradient(135deg,#065F46,#10B981);">
            <div class="summary-icon">&#x1F69A;</div>
            <div><div class="summary-value" id="summaryShippingRules">&mdash;</div><div class="summary-label">Shipping Rules</div></div>
          </div>
          <div class="summary-card" style="background:linear-gradient(135deg,#D97706,#F59E0B);">
            <div class="summary-icon">&#x1F4CA;</div>
            <div><div class="summary-value" id="summaryAdvancedRules">&mdash;</div><div class="summary-label">Advanced Rules</div></div>
          </div>
          <div class="summary-card" style="background:linear-gradient(135deg,#7C3AED,#A78BFA);">
            <div class="summary-icon">&#x2713;</div>
            <div><div class="summary-value" id="summaryActiveTotal">&mdash;</div><div class="summary-label">Total Active</div></div>
          </div>
          <div class="summary-card" style="background:linear-gradient(135deg,#0F2340,#2C4A7C);">
            <div class="summary-icon">&#x26A1;</div>
            <div><div class="summary-value" id="summaryEngine">WASM</div><div class="summary-label">Function Engine</div></div>
          </div>
        </div>

        <div class="tabs">
          <button class="tab active" data-tab="campaigns">Campaigns</button>
          ${permissions.canActivate ? '<button class="tab" data-tab="functions">Function Builder</button>' : ''}
          ${permissions.canActivate ? '<button class="tab" data-tab="shipping">Shipping Function</button>' : ''}
          ${permissions.canActivate ? '<button class="tab" data-tab="advanced">Advanced Functions</button>' : ''}
          ${permissions.canManageUsers ? '<button class="tab" data-tab="users">Users</button>' : ''}
          <button class="tab" data-tab="debuglog">Debug Log</button>
        </div>

        <div class="tab-panel active" id="tab-campaigns">
        
        <!-- Active Discounts Section -->
        <div class="section">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <div class="section-title" style="margin:0;">
              Active Campaigns
              <span class="badge" id="activeCount">Loading...</span>
            </div>
            <button id="refreshBtn" class="action-btn secondary" style="padding:8px 16px;font-size:12px;cursor:pointer;">&#x21BB; Refresh</button>
          </div>
          
          <div class="discount-grid" id="discountsList">
            <div style="text-align:center;padding:48px;grid-column:1/-1;">
              <div style="font-size:28px;margin-bottom:12px;">&#x23F3;</div>
              <div style="color:var(--text-muted);font-size:14px;">Loading discounts...</div>
            </div>
          </div>
        </div>
        
        <!-- Paused Discounts Section -->
        <div class="section" id="pausedSection" style="display:none;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <div class="section-title" style="margin:0;cursor:pointer;" onclick="togglePausedSection()">
              Paused &amp; Expired
              <span class="badge badge-muted" id="pausedCount">0 Paused</span>
              <span id="pausedToggleIcon" style="font-size:12px;margin-left:8px;color:var(--text-muted);">&#x25BC;</span>
            </div>
          </div>
          <div id="pausedDiscountsWrapper">
            <div class="discount-grid" id="pausedDiscountsList"></div>
          </div>
        </div>
        
        <!-- Archived Campaigns Section (admin only) -->
        ${permissions.canActivate ? `
        <div class="section" id="archivedSection" style="display:none;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <div class="section-title" style="margin:0;cursor:pointer;" onclick="toggleArchivedSection()">
              &#x1F4E6; Archived Campaigns
              <span class="badge badge-muted" id="archivedCount">0 Archived</span>
              <span id="archivedToggleIcon" style="font-size:12px;margin-left:8px;color:var(--text-muted);">&#x25B6;</span>
            </div>
          </div>
          <div id="archivedDiscountsWrapper" style="display:none;">
            <div class="discount-grid" id="archivedDiscountsList">
              <div style="text-align:center;padding:24px;grid-column:1/-1;color:var(--text-muted);font-size:13px;">Loading archived campaigns...</div>
            </div>
          </div>
        </div>
        ` : ''}
        
        <!-- Create New Section (builder+ only) -->
        ${permissions.canCreate ? `
        <div class="section">
          <div class="section-title">Create New Discount</div>
          
          <div class="create-options">
            <div class="create-card" onclick="document.querySelector('[data-tab=functions]')?.click()">
              <div class="create-icon">%</div>
              <div class="create-title">Percentage Off</div>
              <div class="create-desc">Deploy a product discount via the Function Builder</div>
              <button class="create-btn">Open Builder →</button>
            </div>
            
            <div class="create-card" onclick="document.querySelector('[data-tab=shipping]')?.click()">
              <div class="create-icon">🚚</div>
              <div class="create-title">Free Shipping</div>
              <div class="create-desc">Deploy a free-shipping rule via the Shipping Function tab</div>
              <button class="create-btn">Open Builder →</button>
            </div>
            
            <div class="create-card" onclick="document.querySelector('[data-tab=advanced]')?.click()">
              <div class="create-icon">📊</div>
              <div class="create-title">Tiered Discount</div>
              <div class="create-desc">Spend more, save more — e.g. $50→10%, $100→20%</div>
              <button class="create-btn">Open Builder →</button>
            </div>
            
            <div class="create-card" onclick="document.querySelector('[data-tab=advanced]')?.click()">
              <div class="create-icon">🎁</div>
              <div class="create-title">Buy X Get Y</div>
              <div class="create-desc">Buy 2 get 1 free (BOGO), or any custom BXGY rule</div>
              <button class="create-btn">Open Builder →</button>
            </div>
          </div>
        </div>
        ` : `
        <div class="section" style="opacity: 0.5;">
          <div class="section-title">Create New Campaign <span class="role-badge role-builder" style="font-size: 10px;">Builder+ Required</span></div>
          <p style="color: #999; padding: 20px;">You don't have permission to create discounts. Contact an admin to upgrade your role.</p>
        </div>
        `}
        </div>

        <!-- Users Tab (admin only) -->
        ${permissions.canManageUsers ? `
        <div class="tab-panel" id="tab-users">
          <div class="section">
            <div class="section-title">Team Permissions</div>
            <p style="color:var(--text-secondary);margin-bottom:16px;">User roles are managed through environment variables in Render. Users without an assigned role get view-only access.</p>

            <div id="usersList" class="deployed-list">
              <div class="deployed-placeholder">Loading users...</div>
            </div>

            <div class="info-box" style="margin-top:20px;">
              <strong>Role Definitions</strong><br>
              <span class="role-badge role-admin" style="margin:4px 2px;">Admin</span> Full access &mdash; deploy, activate, pause, and manage all discounts<br>
              <span class="role-badge role-builder" style="margin:4px 2px;">Builder</span> Create and edit draft discounts, cannot activate or pause live campaigns<br>
              <span class="role-badge role-viewer" style="margin:4px 2px;">Viewer</span> View-only dashboard access, no create or edit permissions
            </div>

            <div class="info-box" style="margin-top:12px;">
              To update roles, edit the environment variables in Render and restart the service:<br>
              <code>GCW_ADMIN_EMAILS</code> &middot; <code>GCW_BUILDER_EMAILS</code> &middot; <code>GCW_VIEWER_EMAILS</code>
            </div>
          </div>
        </div>
        ` : ''}

        <!-- Function Builder Tab (admin only) -->
        ${permissions.canActivate ? `
        <div class="tab-panel" id="tab-functions">
          <div class="section">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
              <div class="section-title" style="margin:0;">Function Engine</div>
              <span class="wasm-badge">WASM-Powered</span>
            </div>
            <p style="color:var(--text-secondary);margin-bottom:8px;">
              Deploy unlimited discount rules from this form. Each one creates a Shopify automatic
              discount powered by the compiled Rust/WASM function &mdash; no code needed.
            </p>
            <p style="color:var(--text-muted);margin-bottom:6px;font-size:12px;">
              Available product tags: <strong id="fe_tags_display">Loading from store...</strong>
            </p>
            <p style="color:var(--text-muted);margin-bottom:20px;font-size:12px;">
              Available vendors: <strong id="fe_vendors_display">${AVAILABLE_FUNCTION_VENDORS.join(', ')}</strong>
            </p>

            <!-- Create Form -->
            <div class="form-card">
              <div class="form-card-title">Create Function Discount</div>
              <div class="form-grid">
                <div class="form-group">
                  <label class="form-label">Discount Name *</label>
                  <input type="text" id="fe_title" placeholder="e.g. Midnight Flash Sale" class="form-input" />
                </div>
                <div class="form-group">
                  <label class="form-label">Percentage Off *</label>
                  <input type="number" id="fe_percentage" min="1" max="100" value="25" class="form-input" />
                </div>
                <div class="form-group">
                  <label class="form-label">Start Date & Hour <span style="font-weight:400;color:#6366f1;font-size:11px;">(EST)</span></label>
                  <div style="display:flex;gap:8px;">
                    <input type="date" id="fe_starts_date" class="form-input" style="flex:1;" />
                    <select id="fe_starts_hour" class="form-input" style="width:110px;">${START_HOUR_OPTIONS}</select>
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">End Date & Hour <span style="font-weight:400;color:#6366f1;font-size:11px;">(EST)</span></label>
                  <div style="display:flex;gap:8px;">
                    <input type="date" id="fe_ends_date" class="form-input" style="flex:1;" />
                    <select id="fe_ends_hour" class="form-input" style="width:110px;">${END_HOUR_OPTIONS}</select>
                  </div>
                </div>
                <div class="form-group full">
                  <label class="form-label">Checkout Message</label>
                  <input type="text" id="fe_message" placeholder="e.g. Enjoy your 25% discount!" class="form-input" />
                </div>
              </div>

              <!-- Tag Selection -->
              <div style="margin-top:18px;">
                <label class="form-label" style="margin-bottom:8px;display:block;">
                  Include Only Products With These Tags <span style="color:var(--text-muted);text-transform:none;font-weight:400;">(leave empty = all products)</span>
                </label>
                <div id="fe_included_tags" class="flair-input-wrap">
                  <div class="flair-chips"></div>
                  <input type="text" class="flair-text-input" placeholder="Type to add tags..." autocomplete="off" />
                  <div class="flair-suggestions"></div>
                </div>
              </div>

              <div style="margin-top:12px;">
                <label class="form-label" style="margin-bottom:8px;display:block;">
                  Exclude Products With These Tags
                </label>
                <div id="fe_exclude_tags" class="flair-input-wrap">
                  <div class="flair-chips"></div>
                  <input type="text" class="flair-text-input" placeholder="Type to exclude tags..." autocomplete="off" />
                  <div class="flair-suggestions"></div>
                </div>
              </div>

              <!-- Exclusions -->
              <div style="margin-top:18px;">
                <label class="form-label" style="margin-bottom:8px;display:block;">
                  Include Only These Vendors <span style="color:var(--text-muted);text-transform:none;font-weight:400;">(leave empty = all vendors)</span>
                </label>
                <div id="fe_included_vendors" class="flair-input-wrap">
                  <div class="flair-chips"></div>
                  <input type="text" class="flair-text-input" placeholder="Type to add vendors..." autocomplete="off" />
                  <div class="flair-suggestions"></div>
                </div>
              </div>

              <div style="margin-top:12px;">
                <label class="form-label" style="margin-bottom:8px;display:block;">
                  Exclude These Vendors
                </label>
                <div id="fe_exclude_vendors" class="flair-input-wrap">
                  <div class="flair-chips"></div>
                  <input type="text" class="flair-text-input" placeholder="Type to exclude vendors..." autocomplete="off" />
                  <div class="flair-suggestions"></div>
                </div>
              </div>

              <div class="form-grid" style="margin-top:16px;">
                <div class="form-group full">
                  <label class="form-label">Exclude Product Types (comma-separated)</label>
                  <input type="text" id="fe_excl_types" placeholder="e.g. Gift Card, Accessories" class="form-input" />
                </div>
              </div>

              <div class="checkbox-group" style="margin-top:16px;">
                <label class="checkbox-label">
                  <input type="checkbox" id="fe_excl_gc" checked /> Exclude Gift Cards
                </label>
              </div>

              <!-- Combines With -->
              <div style="margin-top:18px;">
                <label class="form-label" style="display:block;margin-bottom:8px;">Combines With</label>
                <div class="checkbox-group">
                  <label class="checkbox-label">
                    <input type="checkbox" id="fe_combine_order" checked /> Order Discounts
                  </label>
                  <label class="checkbox-label">
                    <input type="checkbox" id="fe_combine_product" checked /> Product Discounts
                  </label>
                  <label class="checkbox-label">
                    <input type="checkbox" id="fe_combine_shipping" /> Shipping Discounts
                  </label>
                </div>
              </div>

              <!-- Also Deploy Shipping Discount -->
              <div style="margin-top:18px;padding:14px;background:linear-gradient(135deg,#f0fdfa,#ecfdf5);border-radius:var(--radius-sm);border:1px solid #A7F3D0;">
                <label class="checkbox-label" style="font-weight:600;font-size:13px;">
                  <input type="checkbox" id="fe_also_shipping" /> 🚚 Also deploy a free-shipping discount with this campaign
                </label>
                <p style="color:var(--text-muted);font-size:12px;margin:6px 0 0 24px;">
                  Creates a paired shipping discount with the same schedule. Both discounts will activate and expire together.
                </p>
                <div id="fe_shipping_opts" style="display:none;margin-top:10px;padding-left:24px;">
                  <div class="form-group" style="max-width:200px;">
                    <label class="form-label">Minimum Cart for Free Shipping ($)</label>
                    <input type="number" id="fe_ship_threshold" min="10" max="100" value="50" class="form-input" />
                  </div>
                </div>
              </div>

              <!-- Discount Code Combination Rules -->
              <div style="margin-top:18px;padding:14px;background:var(--navy-50,#f0f4ff);border-radius:var(--radius-sm);border:1px solid var(--border);">
                <label class="form-label" style="display:block;margin-bottom:8px;">Discount Code Combination Rules</label>
                <p style="color:var(--text-muted);font-size:12px;margin-bottom:10px;">
                  These code prefixes are always allowed to stack with automatic function discounts.
                  Enable "Order Discounts" above to allow code stacking.
                </p>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">
                  <span class="detail-tag" style="font-size:11px;padding:3px 10px;">SMS*</span>
                  <span class="detail-tag" style="font-size:11px;padding:3px 10px;">FREESHIPPING*</span>
                  <span class="detail-tag" style="font-size:11px;padding:3px 10px;">Perks*</span>
                </div>
                <label class="checkbox-label" style="font-size:12px;">
                  <input type="checkbox" id="fe_allow_safe_codes" checked onchange="
                    if (this.checked) {
                      var co = document.getElementById('fe_combine_order');
                      var cp = document.getElementById('fe_combine_product');
                      if (co && !co.checked) co.checked = true;
                      if (cp && !cp.checked) cp.checked = true;
                    }
                  " />
                  Auto-allow stacking with SMS, FREESHIPPING &amp; Perks codes
                </label>
                <div style="margin-top:8px;">
                  <label class="form-label" style="margin-bottom:4px;display:block;font-size:11px;">Additional Allowed Prefixes <span style="font-weight:400;color:#999;">(comma-separated, optional)</span></label>
                  <input type="text" id="fe_extra_prefixes" placeholder="e.g. VIP, LOYALTY" class="form-input" style="font-size:12px;padding:6px 10px;" />
                </div>
              </div>

              <!-- Discount Simulator -->
              <div class="sim-panel">
                <div class="sim-header">
                  <div class="sim-header-title">
                    🧪 Discount Simulator
                    <span class="sim-header-badge">LIVE PREVIEW</span>
                  </div>
                  <button type="button" id="fe_sim_autofill" class="sim-btn" style="background:rgba(255,255,255,0.12);color:white;border-color:rgba(255,255,255,0.2);">
                    ⚡ Auto-fill from Config
                  </button>
                </div>
                <div class="sim-body">
                  <div class="sim-search-wrap">
                    <span class="sim-search-icon">🔍</span>
                    <input type="text" id="fe_sim_search" class="sim-search-input" placeholder="Search products by name…" autocomplete="off" />
                    <div id="fe_sim_dropdown" class="sim-dropdown"></div>
                  </div>
                  <div id="fe_sim_products" class="sim-product-list" style="display:none;"></div>
                  <div id="fe_sim_empty" class="sim-empty">
                    <div class="sim-empty-icon">📦</div>
                    Search for products above or click <strong>Auto-fill</strong> to pull samples from your tag/vendor config
                  </div>
                  <div class="sim-actions-bar">
                    <button type="button" id="fe_sim_run" class="sim-btn sim-btn-primary" disabled>
                      ▶ Run Simulation
                    </button>
                    <button type="button" id="fe_sim_clear" class="sim-btn">Clear All</button>
                  </div>
                  <div id="fe_sim_results" style="display:none;"></div>
                </div>
              </div>

              <div class="form-actions">
                <button id="fe_deploy_btn" class="btn btn-success" style="padding:12px 32px;font-size:14px;">
                  Deploy Function Discount
                </button>
                <span id="fe_deploy_status" class="deploy-status-text"></span>
              </div>
              <p style="color:var(--text-muted);font-size:12px;margin-top:12px;">Deployed discounts appear on the <strong>Campaigns</strong> tab.</p>
            </div>
          </div>
        </div>
        ` : ''}

        <!-- Shipping Function Tab (admin only) -->
        ${permissions.canActivate ? `
        <div class="tab-panel" id="tab-shipping">
          <div class="section">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
              <div class="section-title" style="margin:0;">Shipping Function Engine</div>
              <span class="wasm-badge">WASM-Powered</span>
            </div>
            <p style="color:var(--text-secondary);margin-bottom:20px;">
              Deploy free-shipping rules powered by a compiled Rust/WASM Shopify Function.
              Set a minimum cart threshold and the function automatically applies 100% off shipping for qualifying orders.
            </p>

            <!-- Create Form -->
            <div class="form-card">
              <div class="form-card-title">Create Free Shipping Rule</div>
              <div class="form-grid">
                <div class="form-group">
                  <label class="form-label">Discount Name <span style="font-weight:400;color:#999;">(auto-generated)</span></label>
                  <input type="text" id="sf_title" value="Free Shipping $50+" class="form-input" readonly style="background:#f9fafb;cursor:default;" />
                </div>
                <div class="form-group">
                  <label class="form-label">Minimum Cart Total ($) *</label>
                  <input type="number" id="sf_threshold" min="10" max="100" value="50" step="5" class="form-input" oninput="updateThresholdPreview()" />
                </div>
              </div>

              <!-- Threshold Visual Preview -->
              <div class="threshold-preview" id="sf_threshold_preview">
                <div class="threshold-header">
                  <span class="threshold-label">Threshold Preview</span>
                  <span class="threshold-value" id="sf_preview_value">$50.00</span>
                </div>
                <div class="threshold-bar-bg">
                  <div class="threshold-bar-fill" id="sf_preview_bar" style="width:44%;"></div>
                </div>
                <div class="threshold-footer">
                  <span>$10</span>
                  <span class="threshold-active-label" id="sf_preview_label">Cart &#x2265; $50 &#x2192; FREE SHIPPING</span>
                  <span>$100</span>
                </div>
              </div>

              <div class="form-grid" style="margin-top:16px;">
                <div class="form-group">
                  <label class="form-label">Start Date & Hour <span style="font-weight:400;color:#6366f1;font-size:11px;">(EST)</span></label>
                  <div style="display:flex;gap:8px;">
                    <input type="date" id="sf_starts_date" class="form-input" style="flex:1;" />
                    <select id="sf_starts_hour" class="form-input" style="width:110px;">${START_HOUR_OPTIONS}</select>
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">End Date & Hour <span style="font-weight:400;color:#6366f1;font-size:11px;">(EST)</span></label>
                  <div style="display:flex;gap:8px;">
                    <input type="date" id="sf_ends_date" class="form-input" style="flex:1;" />
                    <select id="sf_ends_hour" class="form-input" style="width:110px;">${END_HOUR_OPTIONS}</select>
                  </div>
                </div>
                <div class="form-group full">
                  <label class="form-label">Checkout Message <span style="font-weight:400;color:#999;">(optional — auto-generated if blank)</span></label>
                  <input type="text" id="sf_message" placeholder="Auto: Free shipping on orders over $50!" class="form-input" />
                </div>
              </div>

              <!-- Combines With -->
              <div style="margin-top:18px;">
                <label class="form-label" style="display:block;margin-bottom:8px;">Combines With</label>
                <div class="checkbox-group">
                  <label class="checkbox-label">
                    <input type="checkbox" id="sf_combine_order" checked /> Order Discounts
                  </label>
                  <label class="checkbox-label">
                    <input type="checkbox" id="sf_combine_product" checked /> Product Discounts
                  </label>
                  <label class="checkbox-label">
                    <input type="checkbox" id="sf_combine_shipping" /> Other Shipping Discounts
                  </label>
                </div>
              </div>

              <div class="form-actions">
                <button id="sf_deploy_btn" class="btn btn-success" style="padding:12px 32px;font-size:14px;">
                  Deploy Shipping Rule
                </button>
                <span id="sf_deploy_status" class="deploy-status-text"></span>
              </div>
              <p style="color:var(--text-muted);font-size:12px;margin-top:12px;">Deployed shipping rules appear on the <strong>Campaigns</strong> tab.</p>
            </div>
          </div>
        </div>
        ` : ''}

        <!-- Advanced Functions Tab (admin only) -->
        ${permissions.canActivate ? `
        <div class="tab-panel" id="tab-advanced">
          <div class="section">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
              <div class="section-title" style="margin:0;">Advanced Shopify Functions</div>
              <span class="wasm-badge">Phase 1</span>
            </div>
            <p style="color:var(--text-secondary);margin-bottom:20px;">
              Tiered discounts and Buy X Get Y — powered by Rust/WASM Shopify Functions.
            </p>

            <!-- Tiered Discount Form -->
            <div class="form-card" style="border-left:4px solid #D97706;">
              <div class="form-card-title" style="color:#D97706;">📊 Tiered Discount — Spend More, Save More</div>
              <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Customers unlock higher discounts as they add more to their cart. You define the tiers below.</p>
              <div class="form-grid">
                <div class="form-group">
                  <label class="form-label">Discount Name *</label>
                  <input type="text" id="td_title" placeholder="e.g. Spring Spend & Save" class="form-input" />
                </div>
                <div class="form-group">
                  <label class="form-label">Tier Mode</label>
                  <select id="td_mode" class="form-input">
                    <option value="subtotal">Cart Subtotal ($)</option>
                    <option value="quantity">Total Item Quantity</option>
                  </select>
                </div>
                <div class="form-group">
                  <label class="form-label">Start Date & Hour <span style="font-weight:400;color:#6366f1;font-size:11px;">(EST)</span></label>
                  <div style="display:flex;gap:8px;">
                    <input type="date" id="td_starts_date" class="form-input" style="flex:1;" />
                    <select id="td_starts_hour" class="form-input" style="width:110px;">${START_HOUR_OPTIONS}</select>
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">End Date & Hour <span style="font-weight:400;color:#6366f1;font-size:11px;">(EST)</span></label>
                  <div style="display:flex;gap:8px;">
                    <input type="date" id="td_ends_date" class="form-input" style="flex:1;" />
                    <select id="td_ends_hour" class="form-input" style="width:110px;">${END_HOUR_OPTIONS}</select>
                  </div>
                </div>
                <div class="form-group full">
                  <label class="form-label">Checkout Message <span style="font-weight:400;color:#999;">(optional)</span></label>
                  <input type="text" id="td_message" placeholder="Auto: Tier X unlocked: Y% off! (leave blank for smart default)" class="form-input" />
                </div>
              </div>

              <!-- Tier Builder -->
              <div style="margin-top:18px;">
                <label class="form-label" style="display:block;margin-bottom:8px;">Discount Tiers</label>
                <div style="display:flex;gap:12px;align-items:center;margin-bottom:6px;padding:0 0 4px;border-bottom:1px solid var(--border-color,#e2e8f0);">
                  <span style="width:72px;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Level</span>
                  <span style="flex:1;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Threshold ($ or Qty)</span>
                  <span style="flex:1;font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Percent Off (%)</span>
                  <span style="width:44px;"></span>
                </div>
                <div id="td_tiers_list">
                  <div class="tier-row" style="display:flex;gap:12px;align-items:center;margin-bottom:8px;">
                    <span class="tier-level-badge" style="display:inline-flex;align-items:center;justify-content:center;width:72px;height:28px;border-radius:6px;background:#eef2ff;color:#4f46e5;font-size:12px;font-weight:700;">Level 1</span>
                    <input type="number" class="form-input td-tier-min" placeholder="Min value (e.g. 50)" min="1" value="50" style="flex:1;" />
                    <input type="number" class="form-input td-tier-pct" placeholder="% off" min="1" max="100" value="10" style="flex:1;" />
                    <button type="button" class="btn btn-ghost" onclick="this.closest('.tier-row').remove();renumberTiers();" style="padding:6px 10px;font-size:12px;">✕</button>
                  </div>
                  <div class="tier-row" style="display:flex;gap:12px;align-items:center;margin-bottom:8px;">
                    <span class="tier-level-badge" style="display:inline-flex;align-items:center;justify-content:center;width:72px;height:28px;border-radius:6px;background:#ecfdf5;color:#059669;font-size:12px;font-weight:700;">Level 2</span>
                    <input type="number" class="form-input td-tier-min" placeholder="Min value (e.g. 100)" min="1" value="100" style="flex:1;" />
                    <input type="number" class="form-input td-tier-pct" placeholder="% off" min="1" max="100" value="15" style="flex:1;" />
                    <button type="button" class="btn btn-ghost" onclick="this.closest('.tier-row').remove();renumberTiers();" style="padding:6px 10px;font-size:12px;">✕</button>
                  </div>
                  <div class="tier-row" style="display:flex;gap:12px;align-items:center;margin-bottom:8px;">
                    <span class="tier-level-badge" style="display:inline-flex;align-items:center;justify-content:center;width:72px;height:28px;border-radius:6px;background:#fef3c7;color:#d97706;font-size:12px;font-weight:700;">Level 3</span>
                    <input type="number" class="form-input td-tier-min" placeholder="Min value (e.g. 150)" min="1" value="150" style="flex:1;" />
                    <input type="number" class="form-input td-tier-pct" placeholder="% off" min="1" max="100" value="20" style="flex:1;" />
                    <button type="button" class="btn btn-ghost" onclick="this.closest('.tier-row').remove();renumberTiers();" style="padding:6px 10px;font-size:12px;">✕</button>
                  </div>
                </div>
                <button type="button" class="btn btn-secondary" onclick="addTierRow()" style="margin-top:8px;padding:8px 16px;font-size:12px;">+ Add Tier</button>
              </div>

              <!-- Combines With -->
              <div style="margin-top:18px;">
                <label class="form-label" style="display:block;margin-bottom:8px;">Combines With</label>
                <div class="checkbox-group">
                  <label class="checkbox-label"><input type="checkbox" id="td_combine_order" checked /> Order Discounts</label>
                  <label class="checkbox-label"><input type="checkbox" id="td_combine_product" checked /> Product Discounts</label>
                  <label class="checkbox-label"><input type="checkbox" id="td_combine_shipping" checked /> Shipping Discounts</label>
                </div>
              </div>
              <div class="checkbox-group" style="margin-top:12px;">
                <label class="checkbox-label"><input type="checkbox" id="td_excl_gc" checked /> Exclude Gift Cards</label>
              </div>

              <!-- Product Tag Filtering -->
              <div style="margin-top:18px;">
                <label class="form-label" style="display:block;margin-bottom:8px;">Product Tag Filter <span style="font-weight:400;color:#999;">(optional — only discount products with these tags)</span></label>
                <div id="td_included_tags" class="flair-input-container">
                  <div class="flair-chips"></div>
                  <input type="text" class="flair-text-input form-input" placeholder="Type a tag and press Enter…" autocomplete="off" />
                  <div class="flair-suggestions" style="display:none;"></div>
                </div>
              </div>

              <div class="form-actions">
                <button id="td_deploy_btn" class="btn btn-success" style="padding:12px 32px;font-size:14px;">Deploy Tiered Discount</button>
                <span id="td_deploy_status" class="deploy-status-text"></span>
              </div>
            </div>

            <!-- Buy X Get Y Form -->
            <div class="form-card" style="border-left:4px solid #059669;margin-top:28px;">
              <div class="form-card-title" style="color:#059669;">🎁 Buy X Get Y — BOGO & Mix Deals</div>
              <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Classic "Buy 2 Get 1 Free" or any custom combination. The cheapest qualifying items get the discount.</p>
              <div class="form-grid">
                <div class="form-group">
                  <label class="form-label">Discount Name *</label>
                  <input type="text" id="bx_title" placeholder="e.g. Buy 2 Get 1 Free" class="form-input" />
                </div>
                <div class="form-group">
                  <label class="form-label">Buy Quantity *</label>
                  <input type="number" id="bx_buy_qty" min="1" value="2" class="form-input" />
                </div>
                <div class="form-group">
                  <label class="form-label">Get Quantity *</label>
                  <input type="number" id="bx_get_qty" min="1" value="1" class="form-input" />
                </div>
                <div class="form-group">
                  <label class="form-label">Discount on "Get" Items (%) *</label>
                  <input type="number" id="bx_get_pct" min="1" max="100" value="100" class="form-input" />
                  <div style="color:var(--text-muted);font-size:11px;margin-top:4px;">100% = FREE, 50% = half price</div>
                </div>
                <div class="form-group">
                  <label class="form-label">Start Date & Hour <span style="font-weight:400;color:#6366f1;font-size:11px;">(EST)</span></label>
                  <div style="display:flex;gap:8px;">
                    <input type="date" id="bx_starts_date" class="form-input" style="flex:1;" />
                    <select id="bx_starts_hour" class="form-input" style="width:110px;">${START_HOUR_OPTIONS}</select>
                  </div>
                </div>
                <div class="form-group">
                  <label class="form-label">End Date & Hour <span style="font-weight:400;color:#6366f1;font-size:11px;">(EST)</span></label>
                  <div style="display:flex;gap:8px;">
                    <input type="date" id="bx_ends_date" class="form-input" style="flex:1;" />
                    <select id="bx_ends_hour" class="form-input" style="width:110px;">${END_HOUR_OPTIONS}</select>
                  </div>
                </div>
                <div class="form-group full">
                  <label class="form-label">Checkout Message <span style="font-weight:400;color:#999;">(optional — auto-generated if blank)</span></label>
                  <input type="text" id="bx_message" placeholder="e.g. Buy 2 Get 1 Free!" class="form-input" />
                </div>
              </div>

              <!-- Qualifying tags -->
              <div style="margin-top:18px;">
                <label class="form-label" style="margin-bottom:8px;display:block;">
                  Qualifying Product Tags <span style="color:var(--text-muted);text-transform:none;font-weight:400;">(leave empty = all products)</span>
                </label>
                <div id="bx_qualifying_tags" class="flair-input-wrap">
                  <div class="flair-chips"></div>
                  <input type="text" class="flair-text-input" placeholder="Type to add qualifying tags..." autocomplete="off" />
                  <div class="flair-suggestions"></div>
                </div>
                <p style="color:#D97706;font-size:11px;margin-top:8px;">⚠ <strong>Note:</strong> Only pre-defined tags are auto-suggested. Custom tags can be typed and will be passed to the function config.</p>
              </div>

              <div class="checkbox-group" style="margin-top:16px;">
                <label class="checkbox-label"><input type="checkbox" id="bx_discount_cheapest" checked /> Discount cheapest qualifying items</label>
                <label class="checkbox-label"><input type="checkbox" id="bx_excl_gc" checked /> Exclude Gift Cards</label>
              </div>

              <!-- Combines With -->
              <div style="margin-top:14px;">
                <label class="form-label" style="display:block;margin-bottom:8px;">Combines With</label>
                <div class="checkbox-group">
                  <label class="checkbox-label"><input type="checkbox" id="bx_combine_order" checked /> Order Discounts</label>
                  <label class="checkbox-label"><input type="checkbox" id="bx_combine_product" checked /> Product Discounts</label>
                  <label class="checkbox-label"><input type="checkbox" id="bx_combine_shipping" checked /> Shipping Discounts</label>
                </div>
              </div>

              <div class="form-actions">
                <button id="bx_deploy_btn" class="btn btn-success" style="padding:12px 32px;font-size:14px;">Deploy BXGY Discount</button>
                <span id="bx_deploy_status" class="deploy-status-text"></span>
              </div>
            </div>

            <!-- Deployed Rules List -->
            <div style="margin-top:28px;">
              <div class="section-title" style="font-size:15px;">Deployed Advanced Rules</div>
              <div id="advancedRulesList" style="margin-top:12px;">
                <div style="text-align:center;padding:24px;color:var(--text-muted);font-size:13px;">Loading advanced rules...</div>
              </div>
            </div>

            <p style="color:var(--text-muted);font-size:12px;margin-top:20px;">
              All deployed discount rules also appear on the <strong>Campaigns</strong> tab.
            </p>
          </div>
        </div>
        ` : ''}

        <div class="tab-panel" id="tab-debuglog">
          <div class="section">
            <div class="section-title">Error & Debug Log</div>
            <p style="color:var(--text-secondary);font-size:13px;margin-bottom:16px;">Real-time error log from server and client. Last 200 entries are retained in memory.</p>
            <div class="debug-log-card">
              <div class="debug-log-header">
                <span style="font-size:13px;color:var(--text-muted);" id="debugLogCount">0 entries</span>
                <div style="display:flex;gap:8px;">
                  <button class="action-btn secondary" id="debugLogRefresh" style="font-size:12px;padding:6px 14px;">↻ Refresh</button>
                  <button class="action-btn" id="debugLogClear" style="font-size:12px;padding:6px 14px;background:var(--red-500);">Clear Log</button>
                </div>
              </div>
              <div class="debug-log-list" id="debugLogList">
                <div class="debug-log-empty">Loading error log...</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      
      <script>
        function reportClientError(error, context = {}) {
          console.error('[GCW Error]', context.area || 'client', error?.message || error);
          // Report to server error log
          fetch('/api/errors/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: error?.message || String(error),
              area: context.area || 'client',
              stack: error?.stack || '',
              extra: context,
            }),
          }).catch(() => {}); // fire-and-forget
        }

        const initialDiscounts = ${safeJsonForScript(Object.values(discountsStore))};

        function formatStartDate(value) {
          if (!value) return 'Immediate';
          try {
            const d = new Date(value);
            if (isNaN(d)) return value;
            return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
          } catch { return value; }
        }

        function formatEndDate(value) {
          if (!value) return 'No end date';
          try {
            const d = new Date(value);
            if (isNaN(d)) return value;
            return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
          } catch { return value; }
        }

        function isExpired(discount) {
          if (discount._functionStatus === 'EXPIRED') return true;
          if (discount.end_date) {
            try { return new Date(discount.end_date) < new Date(); } catch { return false; }
          }
          return false;
        }

        function isScheduled(discount) {
          if (discount._functionStatus === 'SCHEDULED') return true;
          if (discount.start_date && !discount.paused) {
            try { return new Date(discount.start_date) > new Date(); } catch { return false; }
          }
          return false;
        }

        function formatCountdown(targetIso) {
          const diff = new Date(targetIso).getTime() - Date.now();
          if (diff <= 0) return null;
          const days = Math.floor(diff / 86400000);
          const hours = Math.floor((diff % 86400000) / 3600000);
          const mins = Math.floor((diff % 3600000) / 60000);
          const secs = Math.floor((diff % 60000) / 1000);
          let text = '';
          if (days > 0) text += days + 'd ';
          if (hours > 0 || days > 0) text += hours + 'h ';
          text += mins + 'm ' + secs + 's';
          const color = diff < 3600000 ? '#ef4444' : diff < 86400000 ? '#f59e0b' : '#6366f1';
          return { text: text, color: color };
        }

        // Global countdown interval
        let _countdownInterval = null;
        function startCountdownTimers() {
          if (_countdownInterval) clearInterval(_countdownInterval);
          _countdownInterval = setInterval(function() {
            const timers = document.querySelectorAll('.countdown-timer');
            let needsRefresh = false;
            timers.forEach(function(el) {
              const result = formatCountdown(el.dataset.target);
              if (!result) {
                el.textContent = el.dataset.type === 'start' ? 'Starting now\u2026' : 'Ended';
                el.style.color = el.dataset.type === 'start' ? '#10b981' : '#ef4444';
                if (!el.dataset.fired) { el.dataset.fired = '1'; needsRefresh = true; }
                return;
              }
              el.textContent = result.text;
              el.style.color = result.color;
            });
            if (needsRefresh) {
              setTimeout(function() { loadDiscounts(); loadAdvancedRules(); }, 2000);
            }
          }, 1000);
        }

        // Load and render deployed function discounts on the Campaigns tab
        // Uses the unified /api/discounts/list-all endpoint (single Shopify query)
        async function loadDiscounts() {
          try {
            const headers = await getApiHeaders();
            const resp = await fetch(withShopParam('/api/discounts/list-all'), { headers });
            const data = await resp.json();
            if (!data.success) throw new Error(data.error || 'Failed to load discounts');

            // Normalize function engine discounts into campaign card format
            const feDiscounts = (data.feDiscounts || []).map(d => ({
              id: d.id,
              name: d.title || 'Untitled Function Discount',
              type: 'percentage',
              value: (d.config && d.config.percentage) || '?',
              paused: d.status !== 'ACTIVE' && d.status !== 'SCHEDULED',
              activated: true,
              start_date: d.startsAt || null,
              end_date: d.endsAt || null,
              _source: 'function-engine',
              _functionStatus: d.status,
              _config: d.config || {},
            }));

            // Normalize shipping function discounts
            const sfDiscounts = (data.sfDiscounts || []).map(d => ({
              id: d.id,
              name: d.title || 'Untitled Shipping Rule',
              type: 'free_shipping',
              value: (d.config && d.config.threshold) || '50',
              paused: d.status !== 'ACTIVE' && d.status !== 'SCHEDULED',
              activated: true,
              start_date: d.startsAt || null,
              end_date: d.endsAt || null,
              _source: 'shipping-function',
              _functionStatus: d.status,
              _config: d.config || {},
            }));

            // Normalize tiered discount data
            const tdDiscounts = (data.tdDiscounts || []).map(d => ({
              id: d.id,
              name: d.title || 'Untitled Tiered Discount',
              type: 'tiered',
              value: (d.config && d.config.tiers && d.config.tiers.length) ? d.config.tiers.length + ' tiers' : '?',
              paused: d.status !== 'ACTIVE' && d.status !== 'SCHEDULED',
              activated: true,
              start_date: d.startsAt || null,
              end_date: d.endsAt || null,
              _source: 'tiered-discount',
              _functionStatus: d.status,
              _config: d.config || {},
            }));

            // Normalize BXGY discount data
            const bxDiscounts = (data.bxDiscounts || []).map(d => ({
              id: d.id,
              name: d.title || 'Untitled BXGY Discount',
              type: 'bxgy',
              value: (d.config && d.config.buy_quantity && d.config.get_quantity) ? 'Buy ' + d.config.buy_quantity + ' Get ' + d.config.get_quantity : '?',
              paused: d.status !== 'ACTIVE' && d.status !== 'SCHEDULED',
              activated: true,
              start_date: d.startsAt || null,
              end_date: d.endsAt || null,
              _source: 'bxgy-discount',
              _functionStatus: d.status,
              _config: d.config || {},
            }));

            let allDiscounts = [...feDiscounts, ...sfDiscounts, ...tdDiscounts, ...bxDiscounts];
            // Apply status overrides for recently-toggled discounts (Shopify eventual consistency)
            allDiscounts = applyStatusOverrides(allDiscounts);
            // Only log when counts change or on first load
            const _sig = 'FE:' + feDiscounts.length + ' SF:' + sfDiscounts.length + ' TD:' + tdDiscounts.length + ' BX:' + bxDiscounts.length;
            if (_sig !== loadDiscounts._lastSig) {
              console.log('[loadDiscounts]', _sig, 'Total:', allDiscounts.length, data._meta ? '(' + data._meta.elapsed + 'ms)' : '');
              loadDiscounts._lastSig = _sig;
            }
            renderDiscounts(allDiscounts);
            updateActiveCount(allDiscounts);
            startCountdownTimers();
            // Keep dashboard summary in sync (use overridden allDiscounts for accurate counts)
            _feCount = allDiscounts.filter(d => d._source === 'function-engine').length;
            _feActiveCount = allDiscounts.filter(d => d._source === 'function-engine' && !d.paused).length;
            _sfCount = allDiscounts.filter(d => d._source === 'shipping-function').length;
            _sfActiveCount = allDiscounts.filter(d => d._source === 'shipping-function' && !d.paused).length;
            _tdCount = allDiscounts.filter(d => d._source === 'tiered-discount').length;
            _tdActiveCount = allDiscounts.filter(d => d._source === 'tiered-discount' && !d.paused).length;
            _bxCount = allDiscounts.filter(d => d._source === 'bxgy-discount').length;
            _bxActiveCount = allDiscounts.filter(d => d._source === 'bxgy-discount' && !d.paused).length;
            updateDashboardSummary();
          } catch (error) {
            reportClientError(error, { area: 'discounts_list' });
            renderDiscounts([]);
            updateActiveCount([]);
          }
        }
        
        // Auto-refresh discounts every 30 seconds (configurable via environment)
        let pollInterval = null;
        const POLL_INTERVAL = 30000; // 30 seconds for production
        
        function startPolling() {
          if (pollInterval) clearInterval(pollInterval);
          pollInterval = setInterval(() => {
            loadDiscounts();
          }, POLL_INTERVAL);
        }
        
        function stopPolling() {
          if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
          }
        }

        // ========== Shared auth / URL helpers (top-level so ALL functions can access) ==========
        const urlParams = new URLSearchParams(window.location.search);
        const shopParam = urlParams.get('shop') || (window.gcwConfig && window.gcwConfig.shop) || '';
        const withShopParam = (url) => url + (url.includes('?') ? '&' : '?') + 'shop=' + encodeURIComponent(shopParam);

        // Get a fresh session token from App Bridge (or fallback to URL id_token)
        let _tokenLogCount = 0;
        async function getFreshIdToken() {
          try {
            if (window.shopify && typeof window.shopify.idToken === 'function') {
              const token = await window.shopify.idToken();
              if (token) {
                if (_tokenLogCount++ < 1) console.log('[Auth] Session token from App Bridge OK');
                return token;
              }
            }
          } catch (e) {
            console.warn('[Auth] App Bridge idToken() failed:', e.message);
          }
          const urlToken = urlParams.get('id_token');
          if (urlToken) {
            if (_tokenLogCount++ < 1) console.log('[Auth] Using id_token from URL');
            return urlToken;
          }
          if (_tokenLogCount++ < 1) console.log('[Auth] No App Bridge token — server will use stored access token for shop:', shopParam);
          return '';
        }

        // Build headers with a fresh id_token for each API call
        async function getApiHeaders() {
          const headers = { 'Content-Type': 'application/json' };
          const idToken = await getFreshIdToken();
          if (idToken) headers['X-Shopify-Id-Token'] = idToken;
          headers['X-Shopify-Shop'] = shopParam;
          const userEmail = window.gcwConfig?.userEmail;
          if (userEmail) headers['X-GCW-User-Email'] = userEmail;
          return headers;
        }
        // ======================================================================================

        // Config storage for card details & inline editing
        window._discountConfigs = new Map();
        let _editingDiscountId = null;
        let _editingSource = null;
        
        function renderDiscounts(discounts) {
          const activeContainer = document.getElementById('discountsList');
          const pausedContainer = document.getElementById('pausedDiscountsList');
          const pausedSection = document.getElementById('pausedSection');
          
          if (!activeContainer) return;

          // Split into active, paused, and expired (non-archived)
          const active = discounts.filter(d => !d.paused && !d.archived && !isExpired(d));
          const paused = discounts.filter(d => (d.paused || isExpired(d)) && !d.archived);
          
          // Only log when render counts change
          const _renderSig = active.length + ':' + paused.length;
          if (_renderSig !== renderDiscounts._lastSig) {
            console.log('Rendering', active.length, 'active and', paused.length, 'paused/expired discounts');
            renderDiscounts._lastSig = _renderSig;
          }
          const perms = window.gcwConfig.permissions || {};

          // Format title: strip the appended #xxx uniqueness suffix from display
          // (Also defined at outer scope for loadAdvancedRules — keep both in sync)
          function formatTitle(name) {
            if (!name) return '';
            return name.replace(/ #[a-z0-9]{3,8}$/i, '');
          }
          // Extract just the #xxx suffix for bottom-corner display
          function getIdSuffix(name) {
            if (!name) return '';
            var m = name.match(/(#[a-z0-9]{3,8})$/i);
            return m ? m[1] : '';
          }

          // Shared card builder
          function buildCard(discount) {
            const isDeployedFunction = discount._source === 'function-engine' || discount._source === 'shipping-function' || discount._source === 'tiered-discount' || discount._source === 'bxgy-discount';
            const expired = isExpired(discount);
            
            // Status determination
            let badgeClass, badgeText, statusIcon;
            if (expired) {
              badgeClass = 'badge-expired';
              badgeText = 'EXPIRED';
              statusIcon = '⏱';
            } else if (discount.paused) {
              badgeClass = 'badge-inactive';
              badgeText = 'PAUSED';
              statusIcon = '⏸';
            } else if (isScheduled(discount)) {
              badgeClass = 'badge-scheduled';
              badgeText = 'SCHEDULED';
              statusIcon = '📅';
            } else {
              badgeClass = 'badge-active';
              badgeText = 'ACTIVE';
              statusIcon = '';
            }
            
            // Display value & type label based on discount type
            let displayValue, typeLabel, typeBadgeClass, typeIcon;
            switch (discount.type) {
              case 'tiered':
                displayValue = discount.value;
                typeLabel = 'Tiered Discount';
                typeBadgeClass = 'badge-percentage';
                typeIcon = '📊';
                break;
              case 'bxgy':
                displayValue = discount.value;
                typeLabel = 'Buy X Get Y';
                typeBadgeClass = 'badge-percentage';
                typeIcon = '🎁';
                break;
              case 'free_shipping':
                displayValue = '$' + discount.value + '+';
                typeLabel = 'Free Shipping';
                typeBadgeClass = 'badge-shipping';
                typeIcon = '🚚';
                break;
              default: // percentage
                displayValue = discount.value + '%';
                typeLabel = 'Percentage Off';
                typeBadgeClass = 'badge-percentage';
                typeIcon = '🏷';
            }
            
            // Source indicator
            const sourceBadge = discount._source === 'function-engine'
              ? '<span class="source-badge source-fn">⚡ Function</span>'
              : discount._source === 'shipping-function'
              ? '<span class="source-badge source-ship">🚚 Shipping</span>'
              : discount._source === 'tiered-discount'
              ? '<span class="source-badge source-fn" style="background:#D97706;color:#fff;">📊 Tiered</span>'
              : discount._source === 'bxgy-discount'
              ? '<span class="source-badge source-fn" style="background:#059669;color:#fff;">🎁 BXGY</span>'
              : '';

            // Card top accent color
            const accentStyle = expired
              ? 'background:linear-gradient(90deg,#9CA3AF,#D1D5DB)'
              : discount.paused
              ? 'background:linear-gradient(90deg,#F59E0B,#D97706)'
              : isScheduled(discount)
              ? 'background:linear-gradient(90deg,#6366F1,#818CF8)'
              : discount.type === 'tiered'
              ? 'background:linear-gradient(90deg,#D97706,#F59E0B)'
              : discount.type === 'bxgy'
              ? 'background:linear-gradient(90deg,#059669,#10B981)'
              : discount.type === 'percentage'
              ? 'background:linear-gradient(90deg,var(--navy-700),var(--navy-500))'
              : 'background:linear-gradient(90deg,#059669,#10B981)';

            // Store config for details & edit
            window._discountConfigs.set(discount.id, Object.assign({}, discount._config || {}, {
              _name: discount.name, _startDate: discount.start_date, _endDate: discount.end_date, _source: discount._source
            }));

            // Build expandable details rows
            let detailsRows = '';
            const cfg = discount._config || {};
            const dr = (label, val) => '<div class="detail-row"><span class="detail-label">' + label + '</span><span class="detail-value">' + val + '</span></div>';
            const dtags = (arr, excl) => arr.map(t => '<span class="detail-tag' + (excl ? ' exclude' : '') + '">' + escHtml(t) + '</span>').join(' ');
            if (isDeployedFunction) {
              if (discount._source === 'function-engine') {
                if (cfg.message) detailsRows += dr('Message', escHtml(cfg.message));
                if (cfg.included_tags && cfg.included_tags.length) detailsRows += dr('Include Tags', dtags(cfg.included_tags));
                if (cfg.exclude_tags && cfg.exclude_tags.length) detailsRows += dr('Exclude Tags', dtags(cfg.exclude_tags, true));
                if (cfg.included_vendors && cfg.included_vendors.length) detailsRows += dr('Vendors', dtags(cfg.included_vendors));
                if (cfg.exclude_vendors && cfg.exclude_vendors.length) detailsRows += dr('Excl. Vendors', dtags(cfg.exclude_vendors, true));
                if (cfg.exclude_product_types && cfg.exclude_product_types.length) detailsRows += dr('Excl. Types', escHtml(cfg.exclude_product_types.join(', ')));
                detailsRows += dr('Gift Cards', cfg.exclude_gift_cards !== false ? 'Excluded' : 'Included');
              } else if (discount._source === 'shipping-function') {
                if (cfg.message) detailsRows += dr('Message', escHtml(cfg.message));
              } else if (discount._source === 'tiered-discount') {
                if (cfg.mode) detailsRows += dr('Mode', cfg.mode === 'quantity' ? 'Item Quantity' : 'Cart Subtotal');
                if (cfg.tiers && cfg.tiers.length) {
                  detailsRows += dr('Tiers', cfg.tiers.map((t, i) => { const mv = t.min_value || t.min || 0; return '<strong style="color:#4f46e5;">Level ' + (i + 1) + ':</strong> ' + (cfg.mode === 'quantity' ? mv + '+ items' : '$' + mv + '+') + ' &rarr; ' + t.percentage + '% off'; }).join('<br>'));
                }
                if (cfg.included_tags && cfg.included_tags.length) detailsRows += dr('Product Tags', dtags(cfg.included_tags));
                if (cfg.message) detailsRows += dr('Message', escHtml(cfg.message));
              } else if (discount._source === 'bxgy-discount') {
                if (cfg.get_percentage) detailsRows += dr('Get Discount', cfg.get_percentage + '% off');
                if (cfg.message) detailsRows += dr('Message', escHtml(cfg.message));
              }
            }
            const detailsHtml = detailsRows
              ? '<button class="card-details-toggle">\u25BC View Details</button>' +
                '<div class="card-details"><div class="card-details-inner">' + detailsRows + '</div></div>'
              : '';

            let actionsHtml = '';
            if (isDeployedFunction) {
              // Edit button for function-engine and shipping-function
              if (!expired && (discount._source === 'function-engine' || discount._source === 'shipping-function')) {
                actionsHtml += '<button class="btn btn-edit btn-edit-deployed" data-node-id="' + discount.id + '" data-source="' + discount._source + '">Edit</button>';
              }
              if (expired) {
                // Expired: only delete
                actionsHtml += '<button class="btn btn-danger btn-delete-deployed" data-node-id="' + discount.id + '" data-source="' + discount._source + '">Delete</button>';
              } else if (discount.paused) {
                // Paused: resume + delete
                actionsHtml += '<button class="btn btn-resume btn-toggle-deployed" data-node-id="' + discount.id + '" data-action="activate" data-source="' + discount._source + '">Resume</button>';
                actionsHtml += '<button class="btn btn-ghost btn-delete-deployed" data-node-id="' + discount.id + '" data-source="' + discount._source + '">Delete</button>';
              } else {
                // Active: pause + delete
                actionsHtml += '<button class="btn btn-pause-deployed btn-toggle-deployed" data-node-id="' + discount.id + '" data-action="deactivate" data-source="' + discount._source + '">Pause</button>';
                actionsHtml += '<button class="btn btn-ghost btn-delete-deployed" data-node-id="' + discount.id + '" data-source="' + discount._source + '">Delete</button>';
              }
            } else {
              // Legacy campaign actions
              const isLive = !discount.paused && discount.activated;
              const canEdit = perms.canEditLive || (perms.canEditDraft && !isLive);
              if (canEdit) {
                actionsHtml += '<button class="btn btn-secondary btn-edit-action">Edit</button>';
              }
              if (perms.canActivate) {
                const pauseBtnText = discount.paused ? 'Resume' : 'Pause';
                actionsHtml += '<button class="btn btn-ghost btn-pause-action">' + pauseBtnText + '</button>';
                actionsHtml += '<button class="btn btn-ghost btn-delete-campaign" data-discount-id="' + discount.id + '">Delete</button>';
              }
            }
            
            // Build countdown row
            let countdownHtml = '';
            if (!expired && !discount.paused) {
              if (isScheduled(discount) && discount.start_date) {
                const cd = formatCountdown(discount.start_date);
                countdownHtml = '<div class="discount-info-row countdown-row">' +
                  '<span class="info-label">\u23f3 Starts in</span>' +
                  '<span class="info-value countdown-timer" data-target="' + new Date(discount.start_date).toISOString() + '" data-type="start"' +
                  ' style="color:' + (cd ? cd.color : '#6366f1') + '">' + (cd ? cd.text : '') + '</span></div>';
              } else if (discount.end_date) {
                const cd = formatCountdown(discount.end_date);
                if (cd) {
                  countdownHtml = '<div class="discount-info-row countdown-row">' +
                    '<span class="info-label">\u23f3 Ends in</span>' +
                    '<span class="info-value countdown-timer" data-target="' + new Date(discount.end_date).toISOString() + '" data-type="end"' +
                    ' style="color:' + cd.color + '">' + cd.text + '</span></div>';
                }
              }
            }

            const cardClass = expired ? 'discount-card expired-card' : discount.paused ? 'discount-card paused-card' : isScheduled(discount) ? 'discount-card scheduled-card' : 'discount-card';
            
            // Live on Shopify indicator for active deployed discounts
            const isLiveOnShopify = isDeployedFunction && !expired && !discount.paused && discount._functionStatus === 'ACTIVE';
            const liveHtml = isLiveOnShopify ? '<span class="live-indicator"><span class="live-dot"></span>LIVE</span>' : '';
            
            return '<div class="' + cardClass + '" data-id="' + discount.id + '" data-type="' + discount.type + '" data-source="' + (discount._source || 'campaign') + '">' +
              '<div class="card-accent" style="' + accentStyle + '"></div>' +
              '<div class="card-body">' +
              '<div class="discount-header">' +
              '<div>' +
              '<div class="discount-title">' + formatTitle(escHtml(discount.name)) + liveHtml + '</div>' +
              '<div class="discount-meta">' + sourceBadge + '<span class="discount-badge ' + typeBadgeClass + '">' + typeIcon + ' ' + typeLabel + '</span></div>' +
              '</div>' +
              '<span class="discount-badge ' + badgeClass + '">' + (statusIcon ? statusIcon + ' ' : '') + badgeText + '</span>' +
              '</div>' +
              '<div class="discount-value">' + displayValue + '</div>' +
              '<div class="discount-info">' +
              '<div class="discount-info-row">' +
              '<span class="info-label">Start</span>' +
              '<span class="info-value">' + formatStartDate(discount.start_date) + '</span>' +
              '</div>' +
              '<div class="discount-info-row">' +
              '<span class="info-label">End</span>' +
              '<span class="info-value">' + formatEndDate(discount.end_date) + '</span>' +
              '</div>' +
              '</div>' +
              countdownHtml +
              detailsHtml +
              '<div class="discount-actions">' + actionsHtml + '</div>' +
              (getIdSuffix(discount.name) ? '<div style="text-align:right;padding:2px 4px 0;margin-top:-4px;"><span style="font-size:10px;color:var(--text-muted,#94a3b8);opacity:0.5;font-weight:400;letter-spacing:0.5px;">' + getIdSuffix(discount.name) + '</span></div>' : '') +
              '</div></div>';
          }

          // Render active discounts
          if (active.length === 0) {
            activeContainer.innerHTML = '<div class="empty-state"><div class="empty-icon">🚀</div><div class="empty-text">No active campaigns — deploy one from the builder tabs above</div></div>';
          } else {
            activeContainer.innerHTML = active.map(buildCard).join('');
          }

          // Render paused/expired discounts
          if (pausedContainer) {
            if (paused.length === 0) {
              if (pausedSection) pausedSection.style.display = 'none';
            } else {
              if (pausedSection) pausedSection.style.display = 'block';
              pausedContainer.innerHTML = paused.map(buildCard).join('');
            }
            const pausedCountEl = document.getElementById('pausedCount');
            if (pausedCountEl) pausedCountEl.textContent = paused.length + ' Paused / Expired';
          }
          
          // Attach event listeners to both containers
          [activeContainer, pausedContainer].forEach(container => {
            if (!container) return;
            // Details toggle
            container.querySelectorAll('.card-details-toggle').forEach(btn => {
              btn.addEventListener('click', function() {
                const card = this.closest('.discount-card');
                const details = card.querySelector('.card-details');
                if (!details) return;
                const isOpen = details.classList.toggle('open');
                this.textContent = (isOpen ? '\u25B2 Hide Details' : '\u25BC View Details');
              });
            });
            // Edit deployed discount
            container.querySelectorAll('.btn-edit-deployed').forEach(btn => {
              btn.addEventListener('click', function() {
                const nodeId = this.dataset.nodeId;
                const source = this.dataset.source;
                editDeployedDiscount(nodeId, source);
              });
            });
            container.querySelectorAll('.btn-edit-action').forEach(btn => {
              btn.addEventListener('click', function() {
                const card = this.closest('.discount-card');
                editDiscount(card.dataset.type, card.dataset.id);
              });
            });
            container.querySelectorAll('.btn-pause-action').forEach(btn => {
              btn.addEventListener('click', async function() {
                const card = this.closest('.discount-card');
                const isPaused = card.classList.contains('paused-card');
                const action = isPaused ? 'resume' : 'pause';
                const confirmed = await showConfirmModal(
                  isPaused ? 'Resume Campaign?' : 'Pause Campaign?',
                  isPaused ? 'This campaign will become active again.' : 'This campaign will stop applying discounts until resumed.',
                  { style: isPaused ? 'primary' : 'warning', okLabel: isPaused ? 'Resume' : 'Pause' }
                );
                if (!confirmed) return;
                togglePause(card.dataset.id);
              });
            });
            container.querySelectorAll('.btn-preview-action').forEach(btn => {
              btn.addEventListener('click', function() {
                const discountId = this.dataset.discountId;
                if (discountId) window.location.href = '/preview/' + encodeURIComponent(discountId);
              });
            });
            container.querySelectorAll('.btn-activate-action').forEach(btn => {
              btn.addEventListener('click', async function() {
                const discountId = this.dataset.discountId;
                const button = this;
                const confirmed = await showConfirmModal(
                  'Publish Discount?',
                  'This will create an automatic discount in Shopify. It will apply immediately to qualifying orders.',
                  { style: 'primary', okLabel: 'Publish' }
                );
                if (!confirmed) return;
                button.disabled = true;
                button.textContent = 'Activating...';
                try {
                  const headers = await getApiHeaders();
                  const response = await fetch(withShopParam('/api/discount/' + discountId + '/activate'), {
                    method: 'POST', headers, body: JSON.stringify({ shop: shopParam })
                  });
                  const result = await response.json();
                  if (result.success) {
                    alert('Discount activated in Shopify! ID: ' + result.shopify_discount_id);
                    button.textContent = 'Activated ✓';
                    button.classList.remove('btn-success');
                    button.classList.add('btn-secondary');
                  } else {
                    alert('Error: ' + (result.error || 'Failed to activate discount'));
                    button.disabled = false;
                    button.textContent = 'Activate Basic';
                  }
                } catch (error) {
                  alert('Error: ' + error.message);
                  button.disabled = false;
                  button.textContent = 'Activate Basic';
                }
              });
            });
            container.querySelectorAll('.btn-activate-function-action').forEach(btn => {
              btn.addEventListener('click', async function() {
                const discountId = this.dataset.discountId;
                const button = this;
                const confirmed = await showConfirmModal(
                  'Publish Function Discount?',
                  'This will create a Function-based automatic discount in Shopify using your Rust/WASM function. It will apply immediately.',
                  { style: 'primary', okLabel: 'Publish' }
                );
                if (!confirmed) return;
                button.disabled = true;
                button.textContent = 'Activating...';
                try {
                  const headers = await getApiHeaders();
                  const response = await fetch(withShopParam('/api/discount/' + discountId + '/activate-function'), {
                    method: 'POST', headers, body: JSON.stringify({ shop: shopParam })
                  });
                  const result = await response.json();
                  if (result.success) {
                    const displayDiscountId = result.shopify_discount_id || 'unknown';
                    const functionTypePart = result.function_api_type ? ' | Function Type: ' + result.function_api_type : '';
                    const shopPart = result.shop ? ' | Shop: ' + result.shop : '';
                    alert('Function-based discount activated! Discount ID: ' + displayDiscountId + ' | Function ID: ' + result.function_id + functionTypePart + shopPart);
                    button.textContent = 'Function Active ✓';
                    button.classList.remove('btn-primary');
                    button.classList.add('btn-secondary');
                  } else {
                    alert('Error: ' + (result.error || 'Failed to activate function discount') + ' | Details: ' + JSON.stringify(result.details || result.availableFunctions || {}));
                    button.disabled = false;
                    button.textContent = 'Use Function';
                  }
                } catch (error) {
                  alert('Error: ' + error.message);
                  button.disabled = false;
                  button.textContent = 'Use Function';
                }
              });
            });
            container.querySelectorAll('.btn-archive-action').forEach(btn => {
              btn.addEventListener('click', function() {
                archiveCampaign(this.dataset.discountId, this);
              });
            });
            container.querySelectorAll('.btn-delete-campaign').forEach(btn => {
              btn.addEventListener('click', async function() {
                const confirmed = await showConfirmModal(
                  'Delete Campaign?',
                  'This will permanently delete this campaign. If it was activated on Shopify, it will be removed there too. This cannot be undone.',
                  { style: 'danger', okLabel: 'Delete' }
                );
                if (!confirmed) return;
                deleteCampaign(this.dataset.discountId, this);
              });
            });
            // Deployed function discount actions (Pause/Resume, Delete)
            container.querySelectorAll('.btn-toggle-deployed').forEach(btn => {
              btn.addEventListener('click', async function() {
                const nodeId = this.dataset.nodeId;
                const action = this.dataset.action;
                const button = this;
                const confirmed = await showConfirmModal(
                  action === 'activate' ? 'Resume Discount?' : 'Pause Discount?',
                  action === 'activate'
                    ? 'This discount will become active in your store again.'
                    : 'This discount will stop applying in your store until resumed.',
                  { style: action === 'activate' ? 'primary' : 'warning', okLabel: action === 'activate' ? 'Resume' : 'Pause' }
                );
                if (!confirmed) return;
                const originalText = button.textContent;
                button.disabled = true;
                button.classList.add('btn-loading');
                button.textContent = action === 'activate' ? 'Resuming…' : 'Pausing…';
                const success = await toggleDeployedStatus(nodeId, action, () => {
                  loadDiscounts();
                  loadFunctionDiscounts();
                  loadShippingDiscounts();
                  if (typeof loadAdvancedRules === 'function') loadAdvancedRules();
                });
                if (!success) {
                  // Re-enable button so user can retry
                  button.disabled = false;
                  button.classList.remove('btn-loading');
                  button.textContent = originalText;
                }
              });
            });
            container.querySelectorAll('.btn-delete-deployed').forEach(btn => {
              btn.addEventListener('click', async function() {
                const nodeId = this.dataset.nodeId;
                const source = this.dataset.source;
                const button = this;
                const confirmed = await showConfirmModal(
                  'Delete Discount?',
                  'This will permanently remove this discount from Shopify. This action cannot be undone.',
                  { style: 'danger', okLabel: 'Delete' }
                );
                if (!confirmed) return;
                const originalText = button.textContent;
                button.disabled = true;
                button.classList.add('btn-loading');
                button.textContent = 'Deleting…';
                if (source === 'function-engine') {
                  await deleteFunctionDiscount(nodeId);
                } else if (source === 'tiered-discount') {
                  await deleteTieredDiscount(nodeId);
                } else if (source === 'bxgy-discount') {
                  await deleteBxgyDiscount(nodeId);
                } else {
                  await deleteShippingDiscount(nodeId);
                }
                button.disabled = false;
                button.classList.remove('btn-loading');
                button.textContent = originalText;
                loadDiscounts();
              });
            });
          });
        }

        function togglePausedSection() {
          const wrapper = document.getElementById('pausedDiscountsWrapper');
          const icon = document.getElementById('pausedToggleIcon');
          if (!wrapper) return;
          const isHidden = wrapper.style.display === 'none';
          wrapper.style.display = isHidden ? 'block' : 'none';
          if (icon) icon.textContent = isHidden ? '▼' : '▶';
        }
        
        function updateActiveCount(discounts) {
          const active = discounts.filter(d => !d.paused && !d.archived);
          const paused = discounts.filter(d => d.paused && !d.archived);
          const countEl = document.getElementById('activeCount');
          if (countEl) countEl.textContent = active.length + ' Active';
          updateDashboardSummary();
        }
        
        async function togglePause(discountId) {
          try {
            const headers = await getApiHeaders();
            const response = await fetch(withShopParam('/api/discount/' + discountId + '/toggle-pause'), {
              method: 'PUT',
              headers: headers,
              body: JSON.stringify({ shop: shopParam })
            });
            
            const result = await response.json();
            if (result.success) {
              loadDiscounts(); // Reload to show updated state
            } else {
              alert('Error: ' + (result.error || 'Failed to toggle pause'));
            }
          } catch (error) {
            reportClientError(error, { area: 'discount_toggle_pause' });
            alert('Error: ' + error.message);
          }
        }
        
        function editDiscount(type, id) {
          const route = type === 'percentage' ? '/configure-percentage' : '/configure-shipping';
          window.location.href = route + '?id=' + id;
        }

        function editDeployedDiscount(nodeId, source) {
          const cfg = window._discountConfigs.get(nodeId);
          if (!cfg) { alert('Config not found for this discount.'); return; }

          _editingDiscountId = nodeId;
          _editingSource = source;

          // Switch to the correct tab
          const tabName = source === 'shipping-function' ? 'shipping' : 'functions';
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
          const tabBtn = document.querySelector('.tab[data-tab="' + tabName + '"]');
          const tabPanel = document.getElementById('tab-' + tabName);
          if (tabBtn) tabBtn.classList.add('active');
          if (tabPanel) tabPanel.classList.add('active');

          if (source === 'function-engine') {
            // Populate function engine form
            const t = document.getElementById('fe_title'); if (t) { t.value = (cfg._name || '').replace(/ #[a-z0-9]{3,8}$/i, ''); t.readOnly = true; t.style.background = '#f0f0f0'; }
            const p = document.getElementById('fe_percentage'); if (p) p.value = cfg.percentage || 25;
            const m = document.getElementById('fe_message'); if (m) m.value = cfg.message || '';
            const et = document.getElementById('fe_excl_types'); if (et) et.value = (cfg.exclude_product_types || []).join(', ');
            const gc = document.getElementById('fe_excl_gc'); if (gc) gc.checked = cfg.exclude_gift_cards !== false;
            // Populate flair tags
            setFlairValues('fe_included_tags', cfg.included_tags || [], 'include');
            setFlairValues('fe_exclude_tags', cfg.exclude_tags || [], 'exclude');
            setFlairValues('fe_included_vendors', cfg.included_vendors || [], 'vendor');
            setFlairValues('fe_exclude_vendors', cfg.exclude_vendors || [], 'vendor');
            // Populate dates
            if (cfg._startDate) {
              try {
                const sd = new Date(cfg._startDate);
                const sDateEl = document.getElementById('fe_starts_date');
                const sHourEl = document.getElementById('fe_starts_hour');
                if (sDateEl) sDateEl.value = sd.toISOString().slice(0, 10);
                if (sHourEl) sHourEl.value = String(sd.getHours()).padStart(2, '0');
              } catch(e) {}
            }
            if (cfg._endDate) {
              try {
                const ed = new Date(cfg._endDate);
                const eDateEl = document.getElementById('fe_ends_date');
                const eHourEl = document.getElementById('fe_ends_hour');
                if (eDateEl) eDateEl.value = ed.toISOString().slice(0, 10);
                if (eHourEl) eHourEl.value = String(ed.getHours()).padStart(2, '0');
              } catch(e) {}
            }
            // Populate combination checkboxes
            const co = document.getElementById('fe_combine_order'); if (co) co.checked = !!cfg.combines_with_order;
            const cpk = document.getElementById('fe_combine_product'); if (cpk) cpk.checked = !!cfg.combines_with_product;
            const csh = document.getElementById('fe_combine_shipping'); if (csh) csh.checked = !!cfg.combines_with_shipping;
            // Populate code prefix fields
            const prefixes = cfg.allowed_code_prefixes || [];
            const safeCodes = ['SMS', 'FREESHIPPING', 'Perks'];
            const asc = document.getElementById('fe_allow_safe_codes'); if (asc) asc.checked = prefixes.some(p => safeCodes.includes(p));
            const epf = document.getElementById('fe_extra_prefixes'); if (epf) epf.value = prefixes.filter(p => !safeCodes.includes(p)).join(', ');
            // Switch deploy button to update mode
            const btn = document.getElementById('fe_deploy_btn');
            if (btn) { btn.textContent = 'Update Discount Config'; btn.dataset.editMode = 'true'; }
          } else if (source === 'shipping-function') {
            const th = document.getElementById('sf_threshold'); if (th) { th.value = cfg.threshold || 50; updateThresholdPreview(); }
            const sm = document.getElementById('sf_message'); if (sm) sm.value = cfg.message || '';
            const btn = document.getElementById('sf_deploy_btn');
            if (btn) { btn.textContent = 'Update Shipping Config'; btn.dataset.editMode = 'true'; }
          }

          // Scroll to the form
          if (tabPanel) tabPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }

        function cancelEditMode() {
          _editingDiscountId = null;
          _editingSource = null;
          const feBtn = document.getElementById('fe_deploy_btn');
          if (feBtn) { feBtn.textContent = 'Deploy Function Discount'; delete feBtn.dataset.editMode; }
          const sfBtn = document.getElementById('sf_deploy_btn');
          if (sfBtn) { sfBtn.textContent = 'Deploy Shipping Rule'; delete sfBtn.dataset.editMode; }
          const t = document.getElementById('fe_title'); if (t) { t.readOnly = false; t.style.background = ''; }
        }

        // ========== Campaign Lifecycle: Delete, Archive, Unarchive ==========
        async function deleteCampaign(discountId, triggerButton) {
          if (triggerButton) { triggerButton.disabled = true; triggerButton.textContent = 'Deleting…'; }
          try {
            const headers = await getApiHeaders();
            const response = await fetch(withShopParam('/api/discount/' + discountId), {
              method: 'DELETE',
              headers: headers
            });
            const result = await response.json();
            if (result.success) {
              showToast('"' + (result.name || 'Campaign') + '" deleted' + (result.shopifyRemoved ? ' (also removed from Shopify)' : ''), 'success');
              loadDiscounts();
              loadArchivedDiscounts();
            } else {
              showToast('Error: ' + (result.error || 'Failed to delete campaign'), 'error');
              if (triggerButton) { triggerButton.disabled = false; triggerButton.textContent = '🗑 Delete'; }
            }
          } catch (error) {
            reportClientError(error, { area: 'campaign_delete' });
            showToast('Error deleting campaign: ' + error.message, 'error');
            if (triggerButton) { triggerButton.disabled = false; triggerButton.textContent = '🗑 Delete'; }
          }
        }

        async function archiveCampaign(discountId, triggerButton) {
          if (triggerButton) { triggerButton.disabled = true; triggerButton.textContent = 'Archiving…'; }
          try {
            const headers = await getApiHeaders();
            const response = await fetch(withShopParam('/api/discount/' + discountId + '/archive'), {
              method: 'PUT',
              headers: headers,
              body: JSON.stringify({ shop: shopParam })
            });
            const result = await response.json();
            if (result.success) {
              showToast('"' + (result.data?.name || 'Campaign') + '" archived — find it in the Archived section below', 'success');
              loadDiscounts();
              loadArchivedDiscounts();
            } else {
              showToast('Error: ' + (result.error || 'Failed to archive campaign'), 'error');
              if (triggerButton) { triggerButton.disabled = false; triggerButton.textContent = '📦 Archive'; }
            }
          } catch (error) {
            reportClientError(error, { area: 'campaign_archive' });
            showToast('Error archiving campaign: ' + error.message, 'error');
            if (triggerButton) { triggerButton.disabled = false; triggerButton.textContent = '📦 Archive'; }
          }
        }

        async function unarchiveCampaign(discountId, triggerButton) {
          if (triggerButton) { triggerButton.disabled = true; triggerButton.textContent = 'Restoring…'; }
          try {
            const headers = await getApiHeaders();
            const response = await fetch(withShopParam('/api/discount/' + discountId + '/unarchive'), {
              method: 'PUT',
              headers: headers,
              body: JSON.stringify({ shop: shopParam })
            });
            const result = await response.json();
            if (result.success) {
              showToast('"' + (result.data?.name || 'Campaign') + '" restored to active campaigns', 'success');
              loadDiscounts();
              loadArchivedDiscounts();
            } else {
              showToast('Error: ' + (result.error || 'Failed to unarchive campaign'), 'error');
              if (triggerButton) { triggerButton.disabled = false; triggerButton.textContent = '↩ Restore'; }
            }
          } catch (error) {
            reportClientError(error, { area: 'campaign_unarchive' });
            showToast('Error restoring campaign: ' + error.message, 'error');
            if (triggerButton) { triggerButton.disabled = false; triggerButton.textContent = '↩ Restore'; }
          }
        }

        // Confirmation modal — returns a Promise<boolean>
        var _confirmPendingResolve = null;
        function showConfirmModal(title, message, opts) {
          // Dismiss any pending modal before opening a new one
          if (_confirmPendingResolve) { _confirmPendingResolve(false); _confirmPendingResolve = null; }
          opts = opts || {};
          var style = opts.style || 'danger'; // danger | warning | primary
          var okLabel = opts.okLabel || 'Confirm';
          var cancelLabel = opts.cancelLabel || 'Cancel';
          return new Promise(function(resolve) {
            _confirmPendingResolve = resolve;
            var overlay = document.getElementById('confirmModal');
            var titleEl = document.getElementById('confirmTitle');
            var msgEl = document.getElementById('confirmMessage');
            var okBtn = document.getElementById('confirmOk');
            var cancelBtn = document.getElementById('confirmCancel');
            titleEl.textContent = title;
            msgEl.textContent = message;
            okBtn.textContent = okLabel;
            okBtn.className = 'btn-confirm-ok ' + style;
            cancelBtn.textContent = cancelLabel;
            overlay.style.display = 'flex';
            requestAnimationFrame(function() { overlay.classList.add('visible'); });
            function cleanup(result) {
              _confirmPendingResolve = null;
              overlay.classList.remove('visible');
              setTimeout(function() { overlay.style.display = 'none'; }, 200);
              okBtn.removeEventListener('click', onOk);
              cancelBtn.removeEventListener('click', onCancel);
              overlay.removeEventListener('click', onOverlay);
              document.removeEventListener('keydown', onKey);
              resolve(result);
            }
            function onOk() { cleanup(true); }
            function onCancel() { cleanup(false); }
            function onOverlay(e) { if (e.target === overlay) cleanup(false); }
            function onKey(e) { if (e.key === 'Escape') cleanup(false); }
            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            overlay.addEventListener('click', onOverlay);
            document.addEventListener('keydown', onKey);
          });
        }

        // Toast notification system
        function showToast(message, type) {
          type = type || 'info';
          const colors = { success: '#059669', error: '#dc2626', info: '#1B365D' };
          const icons = { success: '✓', error: '✕', info: 'ℹ' };
          const toast = document.createElement('div');
          toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:10000;display:flex;align-items:center;gap:10px;padding:14px 22px;border-radius:10px;color:white;font-size:14px;font-weight:500;box-shadow:0 8px 24px rgba(0,0,0,0.25);transform:translateY(80px);opacity:0;transition:all 0.35s cubic-bezier(.4,0,.2,1);max-width:420px;background:' + (colors[type] || colors.info);
          toast.innerHTML = '<span style="font-size:18px;flex-shrink:0;">' + (icons[type] || icons.info) + '</span><span>' + escHtml(message) + '</span>';
          document.body.appendChild(toast);
          requestAnimationFrame(function() {
            requestAnimationFrame(function() {
              toast.style.transform = 'translateY(0)';
              toast.style.opacity = '1';
            });
          });
          setTimeout(function() {
            toast.style.transform = 'translateY(80px)';
            toast.style.opacity = '0';
            setTimeout(function() { toast.remove(); }, 400);
          }, type === 'error' ? 5000 : 3500);
        }

        async function loadArchivedDiscounts() {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);
            const response = await fetch('/api/discounts?include_archived=true', { signal: controller.signal });
            clearTimeout(timeoutId);
            const result = await response.json();
            if (!result.success) return;
            const archived = result.data.filter(d => d.archived);
            renderArchivedDiscounts(archived);
          } catch (error) {
            if (error.name !== 'AbortError') {
              console.warn('[Archive] Failed to load archived:', error.message);
            }
          }
        }

        function renderArchivedDiscounts(archivedDiscounts) {
          const container = document.getElementById('archivedDiscountsList');
          const countBadge = document.getElementById('archivedCount');
          const section = document.getElementById('archivedSection');
          if (!container || !countBadge) return;

          countBadge.textContent = archivedDiscounts.length + ' Archived';

          if (archivedDiscounts.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 24px; grid-column: 1/-1; color: #999; font-size: 13px;">No archived campaigns</div>';
            if (section) section.style.display = 'none';
            return;
          }

          if (section) section.style.display = 'block';
          const perms = window.gcwConfig.permissions || {};

          const html = archivedDiscounts.map(discount => {
            const displayValue = discount.type === 'percentage' ? discount.value + '%' : '$' + discount.value + '+';
            const typeLabel = discount.type === 'percentage' ? 'Percentage Off' : 'Free Shipping';
            const typeBadgeClass = discount.type === 'percentage' ? 'badge-percentage' : 'badge-shipping';
            const archivedDate = discount.archivedAt ? new Date(discount.archivedAt).toLocaleDateString() : 'Unknown';

            let actionsHtml = '';
            if (perms.canActivate) {
              actionsHtml += '<button class="btn btn-success btn-unarchive-action" data-discount-id="' + discount.id + '">↩ Restore</button>';
              actionsHtml += '<button class="btn btn-danger btn-delete-archived" data-discount-id="' + discount.id + '">🗑 Delete</button>';
            }

            return '<div class="discount-card archived-card" data-id="' + discount.id + '" data-type="' + discount.type + '">' +
              '<div class="discount-header">' +
              '<div class="discount-title">' + formatTitle(escHtml(discount.name)) + '</div>' +
              '<span class="discount-badge badge-archived">ARCHIVED</span>' +
              '</div>' +
              '<div class="discount-value">' + displayValue + '</div>' +
              '<div class="discount-info">' +
              '<div class="discount-info-row">' +
              '<span class="info-label">Type:</span>' +
              '<span class="info-value"><span class="discount-badge ' + typeBadgeClass + '">' + typeLabel + '</span></span>' +
              '</div>' +
              '<div class="discount-info-row">' +
              '<span class="info-label">Archived:</span>' +
              '<span class="info-value">' + archivedDate + '</span>' +
              '</div>' +
              (discount.activated ? '<div class="discount-info-row"><span class="info-label">Was Active:</span><span class="info-value">Yes (Shopify)</span></div>' : '') +
              '</div>' +
              '<div class="discount-actions">' + actionsHtml + '</div>' +
              (getIdSuffix(discount.name) ? '<div style="text-align:right;padding:2px 4px 0;margin-top:-4px;"><span style="font-size:10px;color:var(--text-muted,#94a3b8);opacity:0.5;font-weight:400;letter-spacing:0.5px;">' + getIdSuffix(discount.name) + '</span></div>' : '') +
              '</div>';
          }).join('');

          container.innerHTML = html;

          // Reattach listeners for archived cards (scoped to archived container)
          container.querySelectorAll('.btn-unarchive-action').forEach(btn => {
            btn.addEventListener('click', function() {
              unarchiveCampaign(this.dataset.discountId, this);
            });
          });
          container.querySelectorAll('.btn-delete-archived').forEach(btn => {
            btn.addEventListener('click', function() {
              deleteCampaign(this.dataset.discountId, this);
            });
          });
        }

        function toggleArchivedSection() {
          const wrapper = document.getElementById('archivedDiscountsWrapper');
          const icon = document.getElementById('archivedToggleIcon');
          if (!wrapper) return;
          const isHidden = wrapper.style.display === 'none';
          wrapper.style.display = isHidden ? 'block' : 'none';
          if (icon) icon.textContent = isHidden ? '▼' : '▶';
        }
        // ==============================================================

        function setStatus(elementId, isOk, text) {
          const el = document.getElementById(elementId);
          if (!el) return;
          el.textContent = text;
          el.className = 'status-pill ' + (isOk ? 'status-ok' : 'status-bad');
        }

        async function loadDebugLog() {
          try {
            const headers = await getApiHeaders();
            const response = await fetch(withShopParam('/api/errors/log?limit=100'), { headers });
            const result = await response.json();
            if (!result.success) throw new Error('Failed to load error log');
            const list = document.getElementById('debugLogList');
            const countEl = document.getElementById('debugLogCount');
            if (countEl) countEl.textContent = result.total + ' total entries';
            if (!list) return;
            if (!result.errors || result.errors.length === 0) {
              list.innerHTML = '<div class="debug-log-empty">No errors logged. The system is running clean.</div>';
              return;
            }
            list.innerHTML = result.errors.map(e => {
              const t = new Date(e.timestamp);
              const time = t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '<br>' + t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
              return '<div class="debug-log-entry">'
                + '<span class="log-time">' + time + '</span>'
                + '<span class="log-area">' + escHtml(e.area || 'unknown') + '</span>'
                + '<span class="log-message">' + escHtml(e.message || '') + '</span>'
                + '</div>';
            }).join('');
          } catch (error) {
            console.error('Failed to load debug log:', error);
            const list = document.getElementById('debugLogList');
            if (list) list.innerHTML = '<div class="debug-log-empty">Failed to load error log.</div>';
          }
        }

        async function clearDebugLog() {
          if (!confirm('Clear all error log entries?')) return;
          try {
            const headers = await getApiHeaders();
            await fetch(withShopParam('/api/errors/clear'), { method: 'DELETE', headers });
            loadDebugLog();
          } catch (error) {
            console.error('Failed to clear debug log:', error);
          }
        }

        function setupTabs() {
          const tabs = document.querySelectorAll('.tab');
          tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
              const target = tab.dataset.tab;
              document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
              document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
              
              tab.classList.add('active');
              const panel = document.getElementById('tab-' + target);
              if (panel) {
                panel.classList.add('active');
              }
            });
          });
        }
        
        // ========================
        // User Management (admin)
        // ========================
        async function loadUsers() {
          const container = document.getElementById('usersList');
          if (!container) return;
          try {
            const headers = await getApiHeaders();
            const response = await fetch(withShopParam('/api/roles/users'), { headers });
            if (response.status === 403) {
              container.innerHTML = '<div style="text-align: center; padding: 20px; color: #c62828;">Access denied. Admin role required.</div>';
              return;
            }
            const result = await response.json();
            if (!result.success) throw new Error(result.error);
            renderUsers(result.users);
          } catch (err) {
            container.innerHTML = '<div style="text-align: center; padding: 20px; color: #c62828;">Failed to load users: ' + err.message + '</div>';
          }
        }

        function renderUsers(users) {
          const container = document.getElementById('usersList');
          if (!container) return;
          if (users.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 20px; color: #999;">No users configured. Set GCW_ADMIN_EMAILS, GCW_BUILDER_EMAILS, or GCW_VIEWER_EMAILS in Render.</div>';
            return;
          }
          const allRoles = ['admin', 'builder', 'viewer'];
          const roleColors = { admin: 'role-admin', builder: 'role-builder', viewer: 'role-viewer' };
          container.innerHTML = users.map(u =>
            '<div class="user-row">' +
              '<div class="user-row-email">' + escHtml(u.email) + '</div>' +
              '<div class="user-row-actions">' +
                allRoles.map(r =>
                  '<span class="role-badge ' + roleColors[r] + '" style="' +
                    (r === u.role ? 'opacity:1;' : 'opacity:0.25;') +
                  '">' + r.charAt(0).toUpperCase() + r.slice(1) + '</span>'
                ).join('') +
              '</div>' +
            '</div>'
          ).join('');
        }

        // ===== FUNCTION ENGINE JS =====
        function getCheckedTags(containerId) {
          const container = document.getElementById(containerId);
          if (!container) return [];
          return Array.from(container.querySelectorAll('.flair-chip')).map(c => c.dataset.value);
        }

        function initFlairInput(containerId, suggestions, chipClass) {
          const wrap = document.getElementById(containerId);
          if (!wrap) return;
          const chipsEl = wrap.querySelector('.flair-chips');
          const input = wrap.querySelector('.flair-text-input');
          const sugBox = wrap.querySelector('.flair-suggestions');
          if (!input || !chipsEl || !sugBox) return;

          function addChip(val) {
            val = val.trim();
            if (!val) return;
            if (Array.from(chipsEl.querySelectorAll('.flair-chip')).some(c => c.dataset.value === val)) return;
            const chip = document.createElement('span');
            chip.className = 'flair-chip ' + (chipClass || 'include');
            chip.dataset.value = val;
            chip.innerHTML = escHtml(val) + ' <span class="flair-chip-remove">&times;</span>';
            chip.querySelector('.flair-chip-remove').addEventListener('click', () => chip.remove());
            chipsEl.appendChild(chip);
          }

          function showSuggestions(filter) {
            const existing = new Set(Array.from(chipsEl.querySelectorAll('.flair-chip')).map(c => c.dataset.value));
            const matches = suggestions.filter(s => !existing.has(s) && s.toLowerCase().includes(filter.toLowerCase()));
            if (matches.length === 0 || !filter) { sugBox.classList.remove('open'); sugBox.innerHTML = ''; return; }
            sugBox.innerHTML = matches.map(m => '<div class="flair-suggestion-item" data-val="' + escHtml(m) + '">' + escHtml(m) + '</div>').join('');
            sugBox.classList.add('open');
            sugBox.querySelectorAll('.flair-suggestion-item').forEach(item => {
              item.addEventListener('mousedown', function(e) {
                e.preventDefault();
                addChip(this.dataset.val);
                input.value = '';
                sugBox.classList.remove('open');
                sugBox.innerHTML = '';
              });
            });
          }

          input.addEventListener('input', () => showSuggestions(input.value));
          input.addEventListener('focus', () => { if (input.value) showSuggestions(input.value); });
          input.addEventListener('blur', () => { setTimeout(() => { sugBox.classList.remove('open'); }, 150); });
          input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); addChip(input.value); input.value = ''; sugBox.classList.remove('open'); }
            if (e.key === 'Backspace' && !input.value) {
              const last = chipsEl.querySelector('.flair-chip:last-child');
              if (last) last.remove();
            }
          });
          wrap.addEventListener('click', () => input.focus());
        }

        function setFlairValues(containerId, values, chipClass) {
          const wrap = document.getElementById(containerId);
          if (!wrap) return;
          const chipsEl = wrap.querySelector('.flair-chips');
          if (!chipsEl) return;
          chipsEl.innerHTML = '';
          (values || []).forEach(val => {
            const chip = document.createElement('span');
            chip.className = 'flair-chip ' + (chipClass || 'include');
            chip.dataset.value = val;
            chip.innerHTML = escHtml(val) + ' <span class="flair-chip-remove">&times;</span>';
            chip.querySelector('.flair-chip-remove').addEventListener('click', () => chip.remove());
            chipsEl.appendChild(chip);
          });
        }

        function clearFlairValues(containerId) {
          const wrap = document.getElementById(containerId);
          if (!wrap) return;
          const chipsEl = wrap.querySelector('.flair-chips');
          if (chipsEl) chipsEl.innerHTML = '';
        }

        function getDateTimeValue(dateId, hourId) {
          const d = document.getElementById(dateId)?.value;
          if (!d) return undefined;
          const h = document.getElementById(hourId)?.value || '00';
          // Convert user-selected date+hour (treated as Eastern time) to UTC ISO string.
          // This ensures midnight EST = 05:00 UTC (or 04:00 UTC during EDT).
          const [year, mon, day] = d.split('-').map(Number);
          const hour = parseInt(h, 10);
          // Initial guess: assume EST (UTC-5)
          const guess = new Date(Date.UTC(year, mon - 1, day, hour + 5, 0, 0));
          // Verify what Eastern hour that maps to using Intl
          const estHourStr = guess.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
          const actualEstHour = parseInt(estHourStr, 10) % 24;
          if (actualEstHour !== hour) {
            guess.setUTCHours(guess.getUTCHours() + (hour - actualEstHour));
          }
          return guess.toISOString();
        }

        // Track deployed counts for dashboard summary
        let _feCount = 0, _sfCount = 0, _feActiveCount = 0, _sfActiveCount = 0;
        let _tdCount = 0, _bxCount = 0, _tdActiveCount = 0, _bxActiveCount = 0;
        function updateDashboardSummary() {
          const el1 = document.getElementById('summaryProductRules');
          const el2 = document.getElementById('summaryShippingRules');
          const el3 = document.getElementById('summaryActiveTotal');
          const el4 = document.getElementById('summaryAdvancedRules');
          if (el1) el1.textContent = _feActiveCount;
          if (el2) el2.textContent = _sfActiveCount;
          if (el4) el4.textContent = _tdActiveCount + _bxActiveCount;
          if (el3) el3.textContent = _feActiveCount + _sfActiveCount + _tdActiveCount + _bxActiveCount;
        }

        // STATUS OVERRIDE SYSTEM:
        // Shopify's discountAutomaticActivate/Deactivate mutations succeed immediately
        // but the status is eventually consistent — re-querying within seconds often
        // returns the OLD status. We keep a map of overrides that loadDiscounts()
        // and loadAdvancedRules() apply BEFORE rendering.
        // Overrides persist in sessionStorage so they survive tab refreshes.
        const _STATUS_OVERRIDE_TTL = 120000; // 2 minutes
        const _STATUS_OVERRIDE_KEY = 'gcw_status_overrides';

        // Load persisted overrides from sessionStorage
        function _loadOverrides() {
          try {
            const raw = sessionStorage.getItem(_STATUS_OVERRIDE_KEY);
            return raw ? JSON.parse(raw) : {};
          } catch { return {}; }
        }
        function _saveOverrides(map) {
          try { sessionStorage.setItem(_STATUS_OVERRIDE_KEY, JSON.stringify(map)); } catch {}
        }
        const _statusOverrides = _loadOverrides();

        function setStatusOverride(discountId, paused) {
          _statusOverrides[discountId] = { paused: paused, until: Date.now() + _STATUS_OVERRIDE_TTL };
          _saveOverrides(_statusOverrides);
        }

        function applyStatusOverrides(discounts) {
          const now = Date.now();
          let purged = false;
          for (const id of Object.keys(_statusOverrides)) {
            if (_statusOverrides[id].until < now) { delete _statusOverrides[id]; purged = true; }
          }
          if (purged) _saveOverrides(_statusOverrides);
          if (Object.keys(_statusOverrides).length === 0) return discounts;
          return discounts.map(function(d) {
            const ov = _statusOverrides[d.id];
            if (!ov) return d;
            console.log('[StatusOverride] Applying override for', d.id, '-> paused:', ov.paused, '(expires in', Math.round((ov.until - now) / 1000), 's)');
            var copy = {};
            for (var k in d) { copy[k] = d[k]; }
            copy.paused = ov.paused;
            copy._functionStatus = ov.paused ? 'INACTIVE' : 'ACTIVE';
            return copy;
          });
        }

        // Apply overrides to raw API list data (used by loadAdvancedRules)
        function applyStatusOverridesToRaw(items) {
          const now = Date.now();
          if (Object.keys(_statusOverrides).length === 0) return items;
          return items.map(function(d) {
            const ov = _statusOverrides[d.id];
            if (!ov || ov.until < now) return d;
            var copy = {};
            for (var k in d) { copy[k] = d[k]; }
            copy.status = ov.paused ? 'INACTIVE' : 'ACTIVE';
            return copy;
          });
        }

        // Shared: toggle deployed discount status (pause/activate)
        // Returns true on success, false on failure (so caller can restore button state)
        async function toggleDeployedStatus(discountNodeId, action, reloadFn) {
          try {
            const headers = await getApiHeaders();
            const resp = await fetch(withShopParam('/api/deployed-discount/' + encodeURIComponent(discountNodeId) + '/toggle-status'), {
              method: 'POST', headers, body: JSON.stringify({ action })
            });
            const data = await resp.json();
            if (!resp.ok) {
              showToast('Error: ' + (data.error || 'Failed to ' + action), 'error');
              return false;
            }
            showToast(action === 'activate' ? 'Campaign resumed successfully' : 'Campaign paused', 'success');

            // Record a status override so every subsequent loadDiscounts() render
            // shows the correct paused/active state regardless of Shopify lag.
            setStatusOverride(discountNodeId, action === 'deactivate');

            // Reload immediately — the override map will correct any stale status
            if (reloadFn) reloadFn();
            return true;
          } catch (err) {
            showToast('Error: ' + err.message, 'error');
            return false;
          }
        }

        async function loadFunctionDiscounts() {
          // Just update dashboard summary counts — deployed list is on Campaigns tab
          try {
            const headers = await getApiHeaders();
            const resp = await fetch(withShopParam('/api/function-engine/list'), { headers });
            const data = await resp.json();
            if (!data.success || !data.discounts?.length) {
              _feCount = 0; _feActiveCount = 0; updateDashboardSummary();
              return;
            }
            _feCount = data.discounts.length;
            _feActiveCount = data.discounts.filter(d => d.status === 'ACTIVE').length;
            updateDashboardSummary();
          } catch (err) {
            console.error('loadFunctionDiscounts error:', err);
          }
        }

        async function deleteFunctionDiscount(discountId) {
          try {
            const headers = await getApiHeaders();
            const resp = await fetch(withShopParam('/api/function-engine/' + encodeURIComponent(discountId)), {
              method: 'DELETE', headers
            });
            const data = await resp.json();
            if (!resp.ok) { showToast('Error: ' + (data.error || 'Failed to delete'), 'error'); return; }
            showToast('Discount deleted', 'success');
            loadFunctionDiscounts();
            loadDiscounts();
          } catch (err) { showToast('Error: ' + err.message, 'error'); }
        }

        function initFunctionEngine() {
          const deployBtn = document.getElementById('fe_deploy_btn');
          if (!deployBtn) return;

          // Toggle shipping options visibility
          const shipToggle = document.getElementById('fe_also_shipping');
          const shipOpts = document.getElementById('fe_shipping_opts');
          if (shipToggle && shipOpts) {
            shipToggle.addEventListener('change', () => {
              shipOpts.style.display = shipToggle.checked ? 'block' : 'none';
            });
          }

          deployBtn.addEventListener('click', async () => {
            const status = document.getElementById('fe_deploy_status');
            const title = document.getElementById('fe_title')?.value?.trim();
            const percentage = Number(document.getElementById('fe_percentage')?.value);
            if (!title) { alert('Please enter a discount name.'); return; }
            if (!percentage || percentage < 1 || percentage > 100) { alert('Percentage must be 1-100.'); return; }

            // Check if we're in edit mode
            const isEditMode = deployBtn.dataset.editMode === 'true' && _editingDiscountId && _editingSource === 'function-engine';

            deployBtn.disabled = true;
            deployBtn.textContent = isEditMode ? 'Updating...' : 'Deploying...';
            if (status) status.textContent = '';

            try {
              const headers = await getApiHeaders();

              if (isEditMode) {
                // Update mode: just update the metafield config
                const safePrefixes = ['SMS', 'FREESHIPPING', 'Perks'];
                const extraPrefixVal = document.getElementById('fe_extra_prefixes')?.value?.trim() || '';
                const extraPrefixes = extraPrefixVal.split(',').map(s => s.trim()).filter(Boolean);
                const config = {
                  percentage,
                  message: document.getElementById('fe_message')?.value?.trim() || ('Extra ' + percentage + '% Off Applied!'),
                  included_tags: getCheckedTags('fe_included_tags'),
                  exclude_tags: getCheckedTags('fe_exclude_tags'),
                  included_vendors: getCheckedTags('fe_included_vendors'),
                  exclude_vendors: getCheckedTags('fe_exclude_vendors'),
                  exclude_product_types: (document.getElementById('fe_excl_types')?.value?.trim() || '').split(',').map(s => s.trim()).filter(Boolean),
                  exclude_gift_cards: document.getElementById('fe_excl_gc')?.checked !== false,
                  exclude_product_ids: [],
                  allowed_code_prefixes: document.getElementById('fe_allow_safe_codes')?.checked ? safePrefixes.concat(extraPrefixes) : extraPrefixes.length ? extraPrefixes : [],
                };
                const resp = await fetch(withShopParam('/api/deployed-discount/' + encodeURIComponent(_editingDiscountId) + '/update-config'), {
                  method: 'PUT', headers, body: JSON.stringify({ config, metafieldKey: 'discount_config' })
                });
                const data = await resp.json();
                if (!resp.ok) {
                  if (status) { status.textContent = 'Error: ' + (data.error || 'Update failed'); status.style.color = '#c0392b'; }
                  return;
                }
                if (status) { status.textContent = 'Config updated!'; status.style.color = '#4CAF50'; }
                cancelEditMode();
                // Switch back to campaigns tab
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                const campTab = document.querySelector('.tab[data-tab="campaigns"]');
                const campPanel = document.getElementById('tab-campaigns');
                if (campTab) campTab.classList.add('active');
                if (campPanel) campPanel.classList.add('active');
                loadDiscounts();
                return;
              }

              const body = {
                title,
                percentage,
                message: document.getElementById('fe_message')?.value?.trim() || undefined,
                included_tags: getCheckedTags('fe_included_tags'),
                exclude_tags: getCheckedTags('fe_exclude_tags'),
                included_vendors: getCheckedTags('fe_included_vendors'),
                exclude_vendors: getCheckedTags('fe_exclude_vendors'),
                exclude_product_types: (document.getElementById('fe_excl_types')?.value?.trim() || '').split(',').map(s => s.trim()).filter(Boolean),
                exclude_gift_cards: document.getElementById('fe_excl_gc')?.checked !== false,
                starts_at: getDateTimeValue('fe_starts_date', 'fe_starts_hour'),
                ends_at: getDateTimeValue('fe_ends_date', 'fe_ends_hour'),
                combines_with_order: document.getElementById('fe_combine_order')?.checked || false,
                combines_with_product: document.getElementById('fe_combine_product')?.checked || false,
                combines_with_shipping: document.getElementById('fe_combine_shipping')?.checked || false,
                allowed_code_prefixes: (function() {
                  var _safePfx = ['SMS', 'FREESHIPPING', 'Perks'];
                  var _extraVal = (document.getElementById('fe_extra_prefixes')?.value?.trim() || '');
                  var _extraPfx = _extraVal.split(',').map(function(s){return s.trim();}).filter(Boolean);
                  return document.getElementById('fe_allow_safe_codes')?.checked ? _safePfx.concat(_extraPfx) : _extraPfx.length ? _extraPfx : [];
                })(),
              };

              const resp = await fetch(withShopParam('/api/function-engine/deploy'), {
                method: 'POST', headers, body: JSON.stringify(body)
              });
              const data = await resp.json();
              if (!resp.ok) {
                let detail = data.details || data.hint || data.error;
                if (typeof detail === 'object') detail = Array.isArray(detail) ? detail.map(e => e.message || JSON.stringify(e)).join('; ') : JSON.stringify(detail);
                if (status) status.textContent = 'Error: ' + detail;
                if (status) status.style.color = '#c0392b';
                return;
              }
              if (status) { status.textContent = 'Deployed successfully!'; status.style.color = '#4CAF50'; }
              // Also deploy shipping discount if toggle is checked
              const alsoShipping = document.getElementById('fe_also_shipping');
              if (alsoShipping && alsoShipping.checked) {
                try {
                  const shipThreshold = Number(document.getElementById('fe_ship_threshold')?.value) || 50;
                  const shipBody = {
                    title: title + ' - Free Shipping',
                    threshold: shipThreshold,
                    message: 'Free shipping on orders $' + shipThreshold + '+',
                    starts_at: body.starts_at,
                    ends_at: body.ends_at,
                    combines_with_order: body.combines_with_order,
                    combines_with_product: body.combines_with_product,
                    combines_with_shipping: true,
                  };
                  const shipResp = await fetch(withShopParam('/api/shipping-function/deploy'), {
                    method: 'POST', headers, body: JSON.stringify(shipBody)
                  });
                  const shipData = await shipResp.json();
                  if (shipResp.ok) {
                    showToast('Paired shipping discount also deployed!', 'success');
                  } else {
                    console.warn('[FE] Shipping pair deploy failed:', shipData.error);
                    showToast('Product discount deployed, but shipping pair failed: ' + (shipData.error || 'Unknown error'), 'warning');
                  }
                } catch (shipErr) {
                  console.warn('[FE] Shipping pair deploy error:', shipErr.message);
                  showToast('Product discount deployed, but shipping pair failed: ' + shipErr.message, 'warning');
                }
              }
              // Show scheduled confirmation if start date is in the future
              if (body.starts_at && new Date(body.starts_at) > new Date()) {
                const _fmtStart = new Date(body.starts_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
                const _fmtEnd = body.ends_at ? new Date(body.ends_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'No end date';
                showToast('\ud83d\udcc5 Discount "' + title + '" scheduled! ' + _fmtStart + ' \u2192 ' + _fmtEnd, 'info');
              } else {
                showToast('Discount "' + title + '" deployed!', 'success');
              }
              // Clear form
              const _feTitle = document.getElementById('fe_title'); if (_feTitle) _feTitle.value = '';
              const _feMsg = document.getElementById('fe_message'); if (_feMsg) _feMsg.value = '';
              const _feStarts = document.getElementById('fe_starts_date'); if (_feStarts) _feStarts.value = '';
              const _feEnds = document.getElementById('fe_ends_date'); if (_feEnds) _feEnds.value = '';
              const _feExclTypes = document.getElementById('fe_excl_types'); if (_feExclTypes) _feExclTypes.value = '';
              const _fePct = document.getElementById('fe_percentage'); if (_fePct) _fePct.value = '25';
              clearFlairValues('fe_included_tags'); clearFlairValues('fe_exclude_tags'); clearFlairValues('fe_included_vendors'); clearFlairValues('fe_exclude_vendors');
              loadFunctionDiscounts();
              loadDiscounts(); // Refresh campaigns tab
            } catch (err) {
              if (status) { status.textContent = 'Error: ' + err.message; status.style.color = '#c0392b'; }
            } finally {
              deployBtn.disabled = false;
              if (!deployBtn.dataset.editMode) {
                deployBtn.textContent = 'Deploy Function Discount';
              } else {
                deployBtn.textContent = 'Update Discount Config';
              }
            }
          });

          // ===== DISCOUNT SIMULATOR =====
          var _simProducts = [];   // [{id, title, vendor, tags, productType, isGiftCard, image, price, compareAtPrice}]
          var _simDebounce = null;
          var _simSearchResults = [];  // temp store for current search dropdown results

          function simRenderProducts() {
            var list = document.getElementById('fe_sim_products');
            var empty = document.getElementById('fe_sim_empty');
            var runBtn = document.getElementById('fe_sim_run');
            if (!list) return;
            if (_simProducts.length === 0) {
              list.style.display = 'none';
              if (empty) empty.style.display = 'block';
              if (runBtn) runBtn.disabled = true;
              return;
            }
            if (empty) empty.style.display = 'none';
            if (runBtn) runBtn.disabled = false;
            list.style.display = 'block';
            list.innerHTML = _simProducts.map(function(p, i) {
              var img = p.image
                ? '<img src="' + escHtml(p.image) + '&width=72" />'
                : '<div class="no-img"></div>';
              var price = parseFloat(p.price) || 0;
              return '<div class="sim-product-row" data-idx="' + i + '">' +
                img +
                '<div class="sim-product-info">' +
                '<div class="sim-product-title">' + escHtml(p.title) + '</div>' +
                '<div class="sim-product-meta">' + escHtml(p.vendor) + (p.tags.length ? ' · ' + p.tags.slice(0, 3).map(function(t){return escHtml(t);}).join(', ') : '') + '</div>' +
                '</div>' +
                '<div class="sim-product-price">$' + price.toFixed(2) + '</div>' +
                '<button type="button" class="sim-product-remove" data-idx="' + i + '" title="Remove">✕</button>' +
                '</div>';
            }).join('');
            // Remove button listeners
            list.querySelectorAll('.sim-product-remove').forEach(function(btn) {
              btn.addEventListener('click', function(e) {
                e.stopPropagation();
                _simProducts.splice(parseInt(this.dataset.idx), 1);
                simRenderProducts();
                // Clear results when products change
                var res = document.getElementById('fe_sim_results');
                if (res) res.style.display = 'none';
              });
            });
          }

          function simAddProduct(product) {
            if (_simProducts.some(function(p) { return p.id === product.id; })) return;
            _simProducts.push(product);
            simRenderProducts();
          }

          // Search type-ahead
          var searchInput = document.getElementById('fe_sim_search');
          var dropdown = document.getElementById('fe_sim_dropdown');
          if (searchInput && dropdown) {
            searchInput.addEventListener('input', function() {
              var q = this.value.trim();
              if (_simDebounce) clearTimeout(_simDebounce);
              if (q.length < 2) { dropdown.classList.remove('open'); return; }
              _simDebounce = setTimeout(async function() {
                try {
                  var headers = await getApiHeaders();
                  var resp = await fetch(withShopParam('/api/products/search') + '&q=' + encodeURIComponent(q), { headers });
                  var data = await resp.json();
                  if (!data.success || !data.products.length) {
                    dropdown.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;text-align:center;">No products found</div>';
                    dropdown.classList.add('open');
                    return;
                  }
                  _simSearchResults = data.products;
                  dropdown.innerHTML = data.products.map(function(p, idx) {
                    var img = p.image
                      ? '<img src="' + escHtml(p.image) + '&width=64" />'
                      : '<div class="no-img"></div>';
                    var price = parseFloat(p.price) || 0;
                    return '<div class="sim-dropdown-item" data-idx="' + idx + '">' +
                      img +
                      '<div style="flex:1;min-width:0;">' +
                      '<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(p.title) + '</div>' +
                      '<div style="color:var(--text-muted);font-size:10px;">' + escHtml(p.vendor) + ' · $' + price.toFixed(2) + '</div>' +
                      '</div></div>';
                  }).join('');
                  dropdown.classList.add('open');
                  // Click to add
                  dropdown.querySelectorAll('.sim-dropdown-item').forEach(function(item) {
                    item.addEventListener('click', function() {
                      var idx = parseInt(this.dataset.idx);
                      var p = _simSearchResults[idx];
                      if (p) simAddProduct(p);
                      searchInput.value = '';
                      dropdown.classList.remove('open');
                    });
                  });
                } catch(e) {
                  dropdown.innerHTML = '<div style="padding:12px;color:#c0392b;font-size:12px;">Search error</div>';
                  dropdown.classList.add('open');
                }
              }, 300);
            });
            // Close dropdown on blur
            document.addEventListener('click', function(e) {
              if (!searchInput.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.classList.remove('open');
              }
            });
          }

          // Auto-fill from config
          var autofillBtn = document.getElementById('fe_sim_autofill');
          if (autofillBtn) {
            autofillBtn.addEventListener('click', async function() {
              var tags = getCheckedTags('fe_included_tags');
              var vendors = getCheckedTags('fe_included_vendors');
              this.disabled = true;
              this.textContent = 'Loading…';
              try {
                var headers = await getApiHeaders();
                var params = new URLSearchParams();
                if (tags.length) params.set('tags', tags.join(','));
                if (vendors.length) params.set('vendors', vendors.join(','));
                var resp = await fetch(withShopParam('/api/products/preview') + '&' + params.toString(), { headers });
                var data = await resp.json();
                if (!data.success) throw new Error(data.error || 'Failed');
                if (data.products.length === 0) {
                  showToast('No products match your tag/vendor config', 'info');
                } else {
                  // Deduplicate by selecting one per unique vendor (category sampling)
                  var seenVendors = {};
                  var sampled = [];
                  data.products.forEach(function(p) {
                    var v = (p.vendor || '').toLowerCase();
                    if (!seenVendors[v]) {
                      seenVendors[v] = true;
                      sampled.push(p);
                    }
                  });
                  // Fill remaining up to 12 products
                  data.products.forEach(function(p) {
                    if (sampled.length >= 12) return;
                    if (!sampled.some(function(s) { return s.id === p.id; })) sampled.push(p);
                  });
                  sampled.forEach(function(p) { simAddProduct(p); });
                  showToast(sampled.length + ' product(s) added from config', 'success');
                }
              } catch(e) {
                showToast('Error loading products: ' + e.message, 'error');
              }
              this.disabled = false;
              this.textContent = '⚡ Auto-fill from Config';
            });
          }

          // Clear all
          var clearBtn = document.getElementById('fe_sim_clear');
          if (clearBtn) {
            clearBtn.addEventListener('click', function() {
              _simProducts = [];
              simRenderProducts();
              var res = document.getElementById('fe_sim_results');
              if (res) res.style.display = 'none';
            });
          }

          // Run Simulation
          var simRunBtn = document.getElementById('fe_sim_run');
          if (simRunBtn) {
            simRunBtn.addEventListener('click', async function() {
              if (_simProducts.length === 0) return;
              this.disabled = true;
              this.textContent = '⏳ Simulating…';
              var resultsDiv = document.getElementById('fe_sim_results');

              // Build config from current form state
              var config = {
                percentage: parseFloat(document.getElementById('fe_percentage')?.value) || 0,
                included_tags: getCheckedTags('fe_included_tags'),
                exclude_tags: getCheckedTags('fe_exclude_tags'),
                included_vendors: getCheckedTags('fe_included_vendors'),
                exclude_vendors: getCheckedTags('fe_exclude_vendors'),
                exclude_product_types: (document.getElementById('fe_excl_types')?.value?.trim() || '').split(',').map(function(s){return s.trim();}).filter(Boolean),
                exclude_gift_cards: document.getElementById('fe_excl_gc')?.checked !== false,
              };

              try {
                var headers = await getApiHeaders();
                var resp = await fetch(withShopParam('/api/discount-simulator/simulate'), {
                  method: 'POST',
                  headers: headers,
                  body: JSON.stringify({
                    config: config,
                    productIds: _simProducts.map(function(p) { return p.id; }),
                  }),
                });
                var data = await resp.json();
                if (!data.success) throw new Error(data.error || 'Simulation failed');

                // Render results
                var html = '';

                // Summary bar
                html += '<div class="sim-summary">' +
                  '<div class="sim-stat"><div class="sim-stat-value">' + data.summary.total + '</div><div class="sim-stat-label">Products</div></div>' +
                  '<div class="sim-stat"><div class="sim-stat-value green">' + data.summary.eligible + '</div><div class="sim-stat-label">Eligible</div></div>' +
                  '<div class="sim-stat"><div class="sim-stat-value red">' + data.summary.excluded + '</div><div class="sim-stat-label">Excluded</div></div>' +
                  '<div class="sim-stat"><div class="sim-stat-value green">$' + data.summary.totalSavings.toFixed(2) + '</div><div class="sim-stat-label">Total Savings</div></div>' +
                  '</div>';

                // Per-product results
                html += '<div class="sim-product-list" style="margin-top:12px;">';
                data.results.forEach(function(r) {
                  var img = r.image
                    ? '<img src="' + escHtml(r.image) + '&width=72" style="width:36px;height:36px;object-fit:cover;border-radius:6px;flex-shrink:0;" />'
                    : '<div class="no-img" style="width:36px;height:36px;background:var(--navy-100);border-radius:6px;flex-shrink:0;"></div>';
                  var rowClass = r.eligible ? 'sim-result-row eligible' : 'sim-result-row excluded';
                  var badge = r.eligible
                    ? '<span class="sim-result-badge pass">✓ ELIGIBLE</span>'
                    : '<span class="sim-result-badge fail">✕ EXCLUDED</span>';

                  // Reasons
                  var reasonHtml = '<div class="sim-reason">';
                  r.reasons.forEach(function(reason) {
                    var cls = reason.pass ? 'sim-reason-chip pass' : 'sim-reason-chip fail';
                    var icon = reason.pass ? '✓' : '✕';
                    reasonHtml += '<span class="' + cls + '">' + icon + ' ' + escHtml(reason.rule) + ': ' + escHtml(reason.detail) + '</span>';
                  });
                  reasonHtml += '</div>';

                  // Pricing
                  var priceHtml = '';
                  if (r.eligible && r.discount > 0) {
                    priceHtml = '<div class="sim-product-price">' +
                      '<div class="sim-price-strike">$' + r.price.toFixed(2) + '</div>' +
                      '<div class="sim-price-final">$' + r.finalPrice.toFixed(2) + '</div>' +
                      '<div class="sim-price-savings">-$' + r.discount.toFixed(2) + ' (' + data.summary.percentage + '%)</div>' +
                      '</div>';
                  } else {
                    priceHtml = '<div class="sim-product-price">$' + r.price.toFixed(2) + '</div>';
                  }

                  html += '<div class="' + rowClass + '">' +
                    img +
                    '<div class="sim-product-info">' +
                    '<div class="sim-product-title">' + escHtml(r.title) + ' ' + badge + '</div>' +
                    '<div class="sim-product-meta">' + escHtml(r.vendor) + (r.productType ? ' · ' + escHtml(r.productType) : '') + '</div>' +
                    reasonHtml +
                    '</div>' +
                    priceHtml +
                    '</div>';
                });
                html += '</div>';

                if (resultsDiv) {
                  resultsDiv.innerHTML = html;
                  resultsDiv.style.display = 'block';
                }
              } catch(e) {
                if (resultsDiv) {
                  resultsDiv.innerHTML = '<div style="color:#c0392b;padding:12px;font-size:12px;">Simulation error: ' + escHtml(e.message) + '</div>';
                  resultsDiv.style.display = 'block';
                }
              }
              this.disabled = false;
              this.textContent = '▶ Run Simulation';
            });
          }
        }

        // ===== SHIPPING FUNCTION ENGINE JS =====
        function updateThresholdPreview() {
          const val = Number(document.getElementById('sf_threshold')?.value) || 50;
          const clamped = Math.min(100, Math.max(10, val));
          const pct = ((clamped - 10) / 90) * 100;
          const previewValue = document.getElementById('sf_preview_value');
          const previewBar = document.getElementById('sf_preview_bar');
          const previewLabel = document.getElementById('sf_preview_label');
          const titleField = document.getElementById('sf_title');
          if (previewValue) previewValue.textContent = '$' + clamped.toFixed(2);
          if (previewBar) previewBar.style.width = pct + '%';
          if (previewLabel) previewLabel.textContent = 'Cart \\u2265 $' + clamped + ' \\u2192 FREE SHIPPING';
          // Auto-generate title from threshold so it always reflects the actual rule
          if (titleField) titleField.value = 'Free Shipping $' + clamped + '+';
          // Update message placeholder to match threshold
          const msgField = document.getElementById('sf_message');
          if (msgField) msgField.placeholder = 'Auto: Free shipping on orders over $' + clamped + '!';
        }

        async function loadShippingDiscounts() {
          // Just update dashboard summary counts — deployed list is on Campaigns tab
          try {
            const headers = await getApiHeaders();
            const resp = await fetch(withShopParam('/api/shipping-function/list'), { headers });
            const data = await resp.json();
            if (!data.success || !data.discounts?.length) {
              _sfCount = 0; _sfActiveCount = 0; updateDashboardSummary();
              return;
            }
            _sfCount = data.discounts.length;
            _sfActiveCount = data.discounts.filter(d => d.status === 'ACTIVE').length;
            updateDashboardSummary();
          } catch (err) {
            console.error('loadShippingDiscounts error:', err);
          }
        }

        async function deleteShippingDiscount(discountId) {
          try {
            const headers = await getApiHeaders();
            const resp = await fetch(withShopParam('/api/shipping-function/' + encodeURIComponent(discountId)), {
              method: 'DELETE', headers
            });
            const data = await resp.json();
            if (!resp.ok) { showToast('Error: ' + (data.error || 'Failed to delete'), 'error'); return; }
            showToast('Shipping rule deleted', 'success');
            loadShippingDiscounts();
            loadDiscounts();
          } catch (err) { showToast('Error: ' + err.message, 'error'); }
        }

        // Format title: strip the appended #xxx uniqueness suffix from display
        // (Outer-scope copies so loadAdvancedRules can access them)
        function formatTitle(name) {
          if (!name) return '';
          return name.replace(/ #[a-z0-9]{3,8}$/i, '');
        }
        function getIdSuffix(name) {
          if (!name) return '';
          var m = name.match(/(#[a-z0-9]{3,8})$/i);
          return m ? m[1] : '';
        }

        // ===== TIERED DISCOUNT ENGINE =====
        const TIER_LEVEL_COLORS = [
          { bg: '#eef2ff', fg: '#4f46e5' },
          { bg: '#ecfdf5', fg: '#059669' },
          { bg: '#fef3c7', fg: '#d97706' },
          { bg: '#fce7f3', fg: '#db2777' },
          { bg: '#f0f9ff', fg: '#0284c7' },
          { bg: '#faf5ff', fg: '#9333ea' },
        ];

        function tierBadgeStyle(num) {
          const c = TIER_LEVEL_COLORS[(num - 1) % TIER_LEVEL_COLORS.length];
          return 'display:inline-flex;align-items:center;justify-content:center;width:72px;height:28px;border-radius:6px;background:' + c.bg + ';color:' + c.fg + ';font-size:12px;font-weight:700;';
        }

        function addTierRow() {
          const list = document.getElementById('td_tiers_list');
          if (!list) return;
          const rows = list.querySelectorAll('.tier-row');
          const num = rows.length + 1;
          const row = document.createElement('div');
          row.className = 'tier-row';
          row.style.cssText = 'display:flex;gap:12px;align-items:center;margin-bottom:8px;';
          row.innerHTML = '<span class="tier-level-badge" style="' + tierBadgeStyle(num) + '">Level ' + num + '</span>' +
            '<input type="number" class="form-input td-tier-min" placeholder="Min threshold" min="1" style="flex:1;" />' +
            '<input type="number" class="form-input td-tier-pct" placeholder="% off" min="1" max="100" style="flex:1;" />' +
            '<button type="button" class="btn btn-ghost" onclick="this.closest(\\'.tier-row\\').remove();renumberTiers();" style="padding:6px 10px;font-size:12px;">✕</button>';
          list.appendChild(row);
        }

        function renumberTiers() {
          const list = document.getElementById('td_tiers_list');
          if (!list) return;
          list.querySelectorAll('.tier-row').forEach((row, i) => {
            const badge = row.querySelector('.tier-level-badge');
            if (badge) {
              badge.textContent = 'Level ' + (i + 1);
              badge.style.cssText = tierBadgeStyle(i + 1);
            }
          });
        }

        async function deleteTieredDiscount(discountId) {
          try {
            const headers = await getApiHeaders();
            const resp = await fetch(withShopParam('/api/tiered-discount/' + encodeURIComponent(discountId)), {
              method: 'DELETE', headers
            });
            const data = await resp.json();
            if (!resp.ok) { showToast('Error: ' + (data.error || 'Failed to delete'), 'error'); return; }
            showToast('Tiered discount deleted', 'success');
            loadDiscounts();
            loadAdvancedRules();
          } catch (err) { showToast('Error: ' + err.message, 'error'); }
        }

        async function deleteBxgyDiscount(discountId) {
          try {
            const headers = await getApiHeaders();
            const resp = await fetch(withShopParam('/api/bxgy-discount/' + encodeURIComponent(discountId)), {
              method: 'DELETE', headers
            });
            const data = await resp.json();
            if (!resp.ok) { showToast('Error: ' + (data.error || 'Failed to delete'), 'error'); return; }
            showToast('BXGY discount deleted', 'success');
            loadDiscounts();
            loadAdvancedRules();
          } catch (err) { showToast('Error: ' + err.message, 'error'); }
        }

        // Escape HTML to prevent XSS in dynamic content
        function escHtml(str) {
          const div = document.createElement('div');
          div.textContent = str || '';
          return div.innerHTML;
        }

        async function loadAdvancedRules() {
          const container = document.getElementById('advancedRulesList');
          if (!container) return;
          container.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);">Loading advanced rules…</div>';
          try {
            const headers = await getApiHeaders();
            const [tdResp, bxResp] = await Promise.allSettled([
              fetch(withShopParam('/api/tiered-discount/list'), { headers }).then(r => r.json()).catch(() => ({ success: false })),
              fetch(withShopParam('/api/bxgy-discount/list'), { headers }).then(r => r.json()).catch(() => ({ success: false })),
            ]);

            const tdData = tdResp.status === 'fulfilled' ? tdResp.value : null;
            const bxData = bxResp.status === 'fulfilled' ? bxResp.value : null;

            const tdRulesRaw = (tdData && tdData.success && tdData.discounts) ? tdData.discounts : [];
            const bxRulesRaw = (bxData && bxData.success && bxData.discounts) ? bxData.discounts : [];
            const tdRules = applyStatusOverridesToRaw(tdRulesRaw);
            const bxRules = applyStatusOverridesToRaw(bxRulesRaw);

            if (tdRules.length === 0 && bxRules.length === 0) {
              container.innerHTML = '<div class="empty-state"><div class="empty-icon">📊</div><div class="empty-text">No advanced rules deployed yet — use the forms above to create one</div></div>';
              return;
            }

            let html = '';

            // Tiered discount cards
            tdRules.forEach(d => {
              const cfg = (d.config) || {};
              const tierCount = cfg.tiers ? cfg.tiers.length : 0;
              const mode = cfg.mode || 'subtotal';
              const tdScheduled = d.status === 'SCHEDULED' || (d.startsAt && new Date(d.startsAt) > new Date());
              const statusClass = d.status === 'ACTIVE' ? 'badge-active' : tdScheduled ? 'badge-scheduled' : 'badge-inactive';
              const statusText = d.status === 'ACTIVE' ? 'ACTIVE' : tdScheduled ? 'SCHEDULED' : 'PAUSED';
              const safeTitle = escHtml(d.title || 'Untitled');
              const safeId = encodeURIComponent(d.id);
              const isPaused = d.status !== 'ACTIVE' && !tdScheduled;
              const pauseBtn = isPaused
                ? '<button class="btn btn-resume btn-toggle-adv" data-node-id="' + escHtml(d.id) + '" data-action="activate" style="margin-right:8px;">Resume</button>'
                : tdScheduled ? '' : '<button class="btn btn-pause-deployed btn-toggle-adv" data-node-id="' + escHtml(d.id) + '" data-action="deactivate" style="margin-right:8px;">Pause</button>';
              // Build tier level details
              let tierDetails = '';
              if (cfg.tiers && cfg.tiers.length) {
                tierDetails = '<div style="margin-top:8px;padding:8px 12px;background:var(--bg-tertiary,#f9fafb);border-radius:6px;font-size:12px;">';
                cfg.tiers.forEach(function(t, i) {
                  const mv = t.min_value || t.min || 0;
                  const label = mode === 'quantity' ? (mv + '+ items') : ('$' + mv + '+');
                  tierDetails += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:' + (i < cfg.tiers.length - 1 ? '4px' : '0') + ';">' +
                    '<span style="display:inline-block;padding:1px 8px;border-radius:4px;background:#eef2ff;color:#4f46e5;font-weight:700;font-size:11px;">Level ' + (i + 1) + '</span>' +
                    '<span>' + label + ' &rarr; <strong>' + t.percentage + '% off</strong></span>' +
                    '</div>';
                });
                tierDetails += '</div>';
              }
              // Tags
              let tagHtml = '';
              if (cfg.included_tags && cfg.included_tags.length) {
                tagHtml = '<div style="margin-top:6px;font-size:11px;">' +
                  '<span style="color:var(--text-muted);">Tags: </span>' +
                  cfg.included_tags.map(function(tag) { return '<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:#dbeafe;color:#1d4ed8;font-size:10px;margin-right:4px;">' + escHtml(tag) + '</span>'; }).join('') +
                  '</div>';
              }
              // Countdown for tiered cards
              let tdCountdownHtml = '';
              if (tdScheduled && d.startsAt) {
                const cdInfo = formatCountdown(d.startsAt);
                if (cdInfo) {
                  tdCountdownHtml = '<div class="countdown-row" style="margin-top:8px;"><span style="font-size:11px;color:var(--text-muted);">⏳ Starts in </span><span class="countdown-timer" data-target="' + new Date(d.startsAt).toISOString() + '" data-type="start" style="font-size:12px;font-weight:600;color:' + cdInfo.color + ';">' + cdInfo.text + '</span></div>';
                }
              } else if (d.status === 'ACTIVE' && d.endsAt) {
                const cdInfo = formatCountdown(d.endsAt);
                if (cdInfo) {
                  tdCountdownHtml = '<div class="countdown-row" style="margin-top:8px;"><span style="font-size:11px;color:var(--text-muted);">⏳ Ends in </span><span class="countdown-timer" data-target="' + new Date(d.endsAt).toISOString() + '" data-type="end" style="font-size:12px;font-weight:600;color:' + cdInfo.color + ';">' + cdInfo.text + '</span></div>';
                }
              }
              const tdAccentColor = tdScheduled ? '#6366F1' : '#D97706';
              html += '<div class="discount-card' + (tdScheduled ? ' scheduled-card' : '') + '" style="border-left:4px solid ' + tdAccentColor + ';" data-id="' + escHtml(d.id) + '">' +
                '<div class="card-body" style="padding:16px;">' +
                '<div class="discount-header">' +
                '<div><div class="discount-title">' + formatTitle(safeTitle) + '</div>' +
                '<div class="discount-meta"><span class="source-badge" style="background:#D97706;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;">📊 Tiered</span>' +
                '<span style="color:var(--text-muted);font-size:12px;margin-left:8px;">' + tierCount + ' tiers • ' + escHtml(mode) + '</span></div></div>' +
                '<span class="discount-badge ' + statusClass + '">' + statusText + '</span>' +
                '</div>' +
                tierDetails + tagHtml + tdCountdownHtml +
                '<div class="discount-actions" style="margin-top:12px;">' +
                pauseBtn +
                '<button class="btn btn-ghost" onclick="deleteTieredDiscount(decodeURIComponent(\\'' + safeId + '\\'))">Delete</button>' +
                '</div>' +
                (getIdSuffix(d.title) ? '<div style="text-align:right;padding:2px 4px 0;margin-top:-4px;"><span style="font-size:10px;color:var(--text-muted,#94a3b8);opacity:0.5;font-weight:400;letter-spacing:0.5px;">' + getIdSuffix(escHtml(d.title)) + '</span></div>' : '') +
                '</div></div>';
            });

            // BXGY discount cards
            bxRules.forEach(d => {
              const buyQty = (d.config && d.config.buy_quantity) || '?';
              const getQty = (d.config && d.config.get_quantity) || '?';
              const getPct = (d.config && d.config.get_percentage) || '?';
              const bxScheduled = d.status === 'SCHEDULED' || (d.startsAt && new Date(d.startsAt) > new Date());
              const statusClass = d.status === 'ACTIVE' ? 'badge-active' : bxScheduled ? 'badge-scheduled' : 'badge-inactive';
              const statusText = d.status === 'ACTIVE' ? 'ACTIVE' : bxScheduled ? 'SCHEDULED' : 'PAUSED';
              const safeTitle = escHtml(d.title || 'Untitled');
              const safeId = encodeURIComponent(d.id);
              const bxIsPaused = d.status !== 'ACTIVE' && !bxScheduled;
              const bxPauseBtn = bxIsPaused
                ? '<button class="btn btn-resume btn-toggle-adv" data-node-id="' + escHtml(d.id) + '" data-action="activate" style="margin-right:8px;">Resume</button>'
                : bxScheduled ? '' : '<button class="btn btn-pause-deployed btn-toggle-adv" data-node-id="' + escHtml(d.id) + '" data-action="deactivate" style="margin-right:8px;">Pause</button>';
              // Countdown for BXGY cards
              let bxCountdownHtml = '';
              if (bxScheduled && d.startsAt) {
                const cdInfo = formatCountdown(d.startsAt);
                if (cdInfo) {
                  bxCountdownHtml = '<div class="countdown-row" style="margin-top:8px;"><span style="font-size:11px;color:var(--text-muted);">⏳ Starts in </span><span class="countdown-timer" data-target="' + new Date(d.startsAt).toISOString() + '" data-type="start" style="font-size:12px;font-weight:600;color:' + cdInfo.color + ';">' + cdInfo.text + '</span></div>';
                }
              } else if (d.status === 'ACTIVE' && d.endsAt) {
                const cdInfo = formatCountdown(d.endsAt);
                if (cdInfo) {
                  bxCountdownHtml = '<div class="countdown-row" style="margin-top:8px;"><span style="font-size:11px;color:var(--text-muted);">⏳ Ends in </span><span class="countdown-timer" data-target="' + new Date(d.endsAt).toISOString() + '" data-type="end" style="font-size:12px;font-weight:600;color:' + cdInfo.color + ';">' + cdInfo.text + '</span></div>';
                }
              }
              const bxAccentColor = bxScheduled ? '#6366F1' : '#059669';
              html += '<div class="discount-card' + (bxScheduled ? ' scheduled-card' : '') + '" style="border-left:4px solid ' + bxAccentColor + ';" data-id="' + escHtml(d.id) + '">' +
                '<div class="card-body" style="padding:16px;">' +
                '<div class="discount-header">' +
                '<div><div class="discount-title">' + formatTitle(safeTitle) + '</div>' +
                '<div class="discount-meta"><span class="source-badge" style="background:#059669;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;">🎁 BXGY</span>' +
                '<span style="color:var(--text-muted);font-size:12px;margin-left:8px;">Buy ' + buyQty + ' Get ' + getQty + ' at ' + getPct + '% off</span></div></div>' +
                '<span class="discount-badge ' + statusClass + '">' + statusText + '</span>' +
                '</div>' +
                bxCountdownHtml +
                '<div class="discount-actions" style="margin-top:12px;">' +
                bxPauseBtn +
                '<button class="btn btn-ghost" onclick="deleteBxgyDiscount(decodeURIComponent(\\'' + safeId + '\\'))">Delete</button>' +
                '</div>' +
                (getIdSuffix(d.title) ? '<div style="text-align:right;padding:2px 4px 0;margin-top:-4px;"><span style="font-size:10px;color:var(--text-muted,#94a3b8);opacity:0.5;font-weight:400;letter-spacing:0.5px;">' + getIdSuffix(escHtml(d.title)) + '</span></div>' : '') +
                '</div></div>';
            });

            container.innerHTML = html;
            startCountdownTimers();

            // Wire up pause/resume buttons in advanced rules cards
            container.querySelectorAll('.btn-toggle-adv').forEach(function(btn) {
              btn.addEventListener('click', async function() {
                const nodeId = this.dataset.nodeId;
                const action = this.dataset.action;
                const button = this;
                const originalText = button.textContent;
                button.disabled = true;
                button.textContent = action === 'activate' ? 'Resuming…' : 'Pausing…';
                const success = await toggleDeployedStatus(nodeId, action, function() {
                  loadDiscounts();
                  loadAdvancedRules();
                });
                if (!success) {
                  button.disabled = false;
                  button.textContent = originalText;
                }
              });
            });
          } catch (err) {
            console.error('loadAdvancedRules error:', err);
            container.innerHTML = '<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-text">Error loading advanced rules</div></div>';
          }
        }

        function initTieredDiscount() {
          const deployBtn = document.getElementById('td_deploy_btn');
          if (!deployBtn) return;

          deployBtn.addEventListener('click', async () => {
            const status = document.getElementById('td_deploy_status');
            const title = document.getElementById('td_title')?.value?.trim();
            const mode = document.getElementById('td_mode')?.value || 'subtotal';
            if (!title) { showToast('Please enter a discount name.', 'error'); return; }

            // Gather tiers from dynamic rows
            const tierRows = document.querySelectorAll('#td_tiers_list .tier-row');
            const tiers = [];
            let tierError = false;
            tierRows.forEach(row => {
              const minVal = Number(row.querySelector('.td-tier-min')?.value);
              const pct = Number(row.querySelector('.td-tier-pct')?.value);
              if (!minVal || !pct || pct < 1 || pct > 100) { tierError = true; return; }
              tiers.push({ min_value: minVal, percentage: pct });
            });
            if (tierError || tiers.length === 0) { showToast('Each tier needs a valid min value and percentage (1-100).', 'error'); return; }

            deployBtn.disabled = true;
            deployBtn.textContent = 'Deploying…';
            if (status) status.textContent = '';

            try {
              const headers = await getApiHeaders();
              const body = {
                title,
                mode,
                tiers,
                message: document.getElementById('td_message')?.value?.trim() || undefined,
                exclude_gift_cards: document.getElementById('td_excl_gc')?.checked !== false,
                included_tags: (typeof getFlairValues === 'function' ? getFlairValues('td_included_tags') : []),
                starts_at: getDateTimeValue('td_starts_date', 'td_starts_hour'),
                ends_at: getDateTimeValue('td_ends_date', 'td_ends_hour'),
                combines_with_order: document.getElementById('td_combine_order')?.checked || false,
                combines_with_product: document.getElementById('td_combine_product')?.checked || false,
                combines_with_shipping: document.getElementById('td_combine_shipping')?.checked || false,
              };

              const resp = await fetch(withShopParam('/api/tiered-discount/deploy'), {
                method: 'POST', headers, body: JSON.stringify(body)
              });
              const data = await resp.json();
              if (!resp.ok) {
                const detail = data.details || data.hint || data.error;
                if (status) { status.textContent = 'Error: ' + detail; status.style.color = '#c0392b'; }
                return;
              }
              if (status) { status.textContent = 'Deployed successfully!'; status.style.color = '#10b981'; }
              const _tdStartVal = body.starts_at;
              const _tdEndVal = body.ends_at;
              if (_tdStartVal && new Date(_tdStartVal) > new Date()) {
                const _fmtStart = new Date(_tdStartVal).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
                const _fmtEnd = _tdEndVal ? new Date(_tdEndVal).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'No end date';
                showToast('\ud83d\udcc5 Tiered discount "' + title + '" scheduled! ' + _fmtStart + ' \u2192 ' + _fmtEnd, 'info');
              } else {
                showToast('Tiered discount "' + title + '" deployed!', 'success');
              }
              // Clear form
              const _tdTitle = document.getElementById('td_title'); if (_tdTitle) _tdTitle.value = '';
              const _tdMsg = document.getElementById('td_message'); if (_tdMsg) _tdMsg.value = '';
              const _tdStarts = document.getElementById('td_starts_date'); if (_tdStarts) _tdStarts.value = '';
              const _tdEnds = document.getElementById('td_ends_date'); if (_tdEnds) _tdEnds.value = '';
              if (typeof setFlairValues === 'function') setFlairValues('td_included_tags', []);
              loadAdvancedRules();
              loadDiscounts();
            } catch (err) {
              if (status) { status.textContent = 'Error: ' + err.message; status.style.color = '#c0392b'; }
            } finally {
              deployBtn.disabled = false;
              deployBtn.textContent = 'Deploy Tiered Discount';
            }
          });
        }

        function initBxgyDiscount() {
          const deployBtn = document.getElementById('bx_deploy_btn');
          if (!deployBtn) return;

          deployBtn.addEventListener('click', async () => {
            const status = document.getElementById('bx_deploy_status');
            const title = document.getElementById('bx_title')?.value?.trim();
            const buyQty = Number(document.getElementById('bx_buy_qty')?.value);
            const getQty = Number(document.getElementById('bx_get_qty')?.value);
            const getPct = Number(document.getElementById('bx_get_pct')?.value);

            if (!title) { showToast('Please enter a discount name.', 'error'); return; }
            if (!buyQty || buyQty < 1) { showToast('Buy quantity must be at least 1.', 'error'); return; }
            if (!getQty || getQty < 1) { showToast('Get quantity must be at least 1.', 'error'); return; }
            if (!getPct || getPct < 1 || getPct > 100) { showToast('Discount percentage must be 1-100.', 'error'); return; }

            deployBtn.disabled = true;
            deployBtn.textContent = 'Deploying…';
            if (status) status.textContent = '';

            try {
              const headers = await getApiHeaders();
              const body = {
                title,
                buy_quantity: buyQty,
                get_quantity: getQty,
                get_percentage: getPct,
                qualifying_tags: getCheckedTags('bx_qualifying_tags'),
                discount_cheapest: document.getElementById('bx_discount_cheapest')?.checked !== false,
                exclude_gift_cards: document.getElementById('bx_excl_gc')?.checked !== false,
                message: document.getElementById('bx_message')?.value?.trim() || undefined,
                starts_at: getDateTimeValue('bx_starts_date', 'bx_starts_hour'),
                ends_at: getDateTimeValue('bx_ends_date', 'bx_ends_hour'),
                combines_with_order: document.getElementById('bx_combine_order')?.checked || false,
                combines_with_product: document.getElementById('bx_combine_product')?.checked || false,
                combines_with_shipping: document.getElementById('bx_combine_shipping')?.checked || false,
              };

              const resp = await fetch(withShopParam('/api/bxgy-discount/deploy'), {
                method: 'POST', headers, body: JSON.stringify(body)
              });
              const data = await resp.json();
              if (!resp.ok) {
                const detail = data.details || data.hint || data.error;
                if (status) { status.textContent = 'Error: ' + detail; status.style.color = '#c0392b'; }
                return;
              }
              if (status) { status.textContent = 'Deployed successfully!'; status.style.color = '#10b981'; }
              const _bxStartVal = body.starts_at;
              const _bxEndVal = body.ends_at;
              if (_bxStartVal && new Date(_bxStartVal) > new Date()) {
                const _fmtStart = new Date(_bxStartVal).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
                const _fmtEnd = _bxEndVal ? new Date(_bxEndVal).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'No end date';
                showToast('\ud83d\udcc5 BXGY discount "' + title + '" scheduled! ' + _fmtStart + ' \u2192 ' + _fmtEnd, 'info');
              } else {
                showToast('BXGY discount "' + title + '" deployed!', 'success');
              }
              // Clear form
              const _bxTitle = document.getElementById('bx_title'); if (_bxTitle) _bxTitle.value = '';
              const _bxMsg = document.getElementById('bx_message'); if (_bxMsg) _bxMsg.value = '';
              const _bxStarts = document.getElementById('bx_starts_date'); if (_bxStarts) _bxStarts.value = '';
              const _bxEnds = document.getElementById('bx_ends_date'); if (_bxEnds) _bxEnds.value = '';
              document.getElementById('bx_buy_qty').value = '2';
              document.getElementById('bx_get_qty').value = '1';
              document.getElementById('bx_get_pct').value = '100';
              clearFlairValues('bx_qualifying_tags');
              loadAdvancedRules();
              loadDiscounts();
            } catch (err) {
              if (status) { status.textContent = 'Error: ' + err.message; status.style.color = '#c0392b'; }
            } finally {
              deployBtn.disabled = false;
              deployBtn.textContent = 'Deploy BXGY Discount';
            }
          });
        }

        function initShippingFunction() {
          const deployBtn = document.getElementById('sf_deploy_btn');
          if (!deployBtn) return;

          // Initialize threshold preview
          updateThresholdPreview();

          deployBtn.addEventListener('click', async () => {
            const status = document.getElementById('sf_deploy_status');
            const threshold = Number(document.getElementById('sf_threshold')?.value);
            if (!threshold || threshold < 10 || threshold > 100) { alert('Threshold must be between $10 and $100.'); return; }
            // Title always generated from threshold for consistency
            const title = 'Free Shipping $' + Math.min(100, Math.max(10, threshold)) + '+';

            // Check if we're in edit mode
            const isEditMode = deployBtn.dataset.editMode === 'true' && _editingDiscountId && _editingSource === 'shipping-function';

            deployBtn.disabled = true;
            deployBtn.textContent = isEditMode ? 'Updating...' : 'Deploying...';
            if (status) status.textContent = '';

            try {
              const headers = await getApiHeaders();

              if (isEditMode) {
                const config = {
                  threshold,
                  message: document.getElementById('sf_message')?.value?.trim() || ('Free shipping on orders over $' + threshold + '!'),
                };
                const resp = await fetch(withShopParam('/api/deployed-discount/' + encodeURIComponent(_editingDiscountId) + '/update-config'), {
                  method: 'PUT', headers, body: JSON.stringify({ config, metafieldKey: 'shipping_config' })
                });
                const data = await resp.json();
                if (!resp.ok) {
                  if (status) { status.textContent = 'Error: ' + (data.error || 'Update failed'); status.style.color = '#c0392b'; }
                  return;
                }
                if (status) { status.textContent = 'Config updated!'; status.style.color = '#10b981'; }
                cancelEditMode();
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
                const campTab = document.querySelector('.tab[data-tab="campaigns"]');
                const campPanel = document.getElementById('tab-campaigns');
                if (campTab) campTab.classList.add('active');
                if (campPanel) campPanel.classList.add('active');
                loadDiscounts();
                return;
              }

              const body = {
                title,
                threshold,
                message: document.getElementById('sf_message')?.value?.trim() || undefined,
                starts_at: getDateTimeValue('sf_starts_date', 'sf_starts_hour'),
                ends_at: getDateTimeValue('sf_ends_date', 'sf_ends_hour'),
                combines_with_order: document.getElementById('sf_combine_order')?.checked || false,
                combines_with_product: document.getElementById('sf_combine_product')?.checked || false,
                combines_with_shipping: document.getElementById('sf_combine_shipping')?.checked || false,
              };

              const resp = await fetch(withShopParam('/api/shipping-function/deploy'), {
                method: 'POST', headers, body: JSON.stringify(body)
              });
              const data = await resp.json();
              if (!resp.ok) {
                let detail = data.details || data.hint || data.error;
                if (typeof detail === 'object') detail = Array.isArray(detail) ? detail.map(e => e.message || JSON.stringify(e)).join('; ') : JSON.stringify(detail);
                if (status) status.textContent = 'Error: ' + detail;
                if (status) status.style.color = '#c0392b';
                return;
              }
              if (status) { status.textContent = 'Deployed successfully!'; status.style.color = '#10b981'; }
              // Show scheduled confirmation
              if (body.starts_at && new Date(body.starts_at) > new Date()) {
                const _fmtStart = new Date(body.starts_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
                const _fmtEnd = body.ends_at ? new Date(body.ends_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : 'No end date';
                showToast('\ud83d\udcc5 Shipping rule scheduled! ' + _fmtStart + ' \u2192 ' + _fmtEnd, 'info');
              } else {
                showToast('Shipping rule deployed!', 'success');
              }
              // Clear form
              const _sfMsg = document.getElementById('sf_message'); if (_sfMsg) _sfMsg.value = '';
              const _sfStarts = document.getElementById('sf_starts_date'); if (_sfStarts) _sfStarts.value = '';
              const _sfEnds = document.getElementById('sf_ends_date'); if (_sfEnds) _sfEnds.value = '';
              const _sfThreshold = document.getElementById('sf_threshold'); if (_sfThreshold) _sfThreshold.value = '50';
              updateThresholdPreview();
              loadShippingDiscounts();
              loadDiscounts(); // Refresh campaigns tab
            } catch (err) {
              if (status) { status.textContent = 'Error: ' + err.message; status.style.color = '#c0392b'; }
            } finally {
              deployBtn.disabled = false;
              if (!deployBtn.dataset.editMode) {
                deployBtn.textContent = 'Deploy Shipping Rule';
              } else {
                deployBtn.textContent = 'Update Shipping Config';
              }
            }
          });
        }

        function initUserManagement() {
          loadUsers();
        }

        // Load discounts when page loads
        document.addEventListener('DOMContentLoaded', () => {
          console.log('DOMContentLoaded fired!');
          setupTabs();
          // Show loading state, then fetch real deployed discounts
          renderDiscounts([]);
          loadDiscounts();
          startPolling();
          loadDebugLog();
          initUserManagement();
          initFunctionEngine();
          initShippingFunction();
          initTieredDiscount();
          initBxgyDiscount();

          // Init flair-style tag/vendor inputs — start with static list, upgrade to real tags
          const _staticTags = ${safeJsonForScript(AVAILABLE_FUNCTION_TAGS)};
          const _staticVendors = ${safeJsonForScript(AVAILABLE_FUNCTION_VENDORS)};
          initFlairInput('fe_included_tags', _staticTags, 'include');
          initFlairInput('fe_exclude_tags', _staticTags, 'exclude');
          initFlairInput('fe_included_vendors', _staticVendors, 'vendor');
          initFlairInput('fe_exclude_vendors', _staticVendors, 'vendor');
          initFlairInput('bx_qualifying_tags', _staticTags, 'bxgy');
          initFlairInput('td_included_tags', _staticTags, 'include');

          // Fetch real product tags from Shopify and reinit all tag inputs
          (async function() {
            try {
              const headers = await getApiHeaders();
              const resp = await fetch(withShopParam('/api/product-tags') + '&refresh=1', { headers, cache: 'no-store' });
              const data = await resp.json();
              if (data.success && data.tags && data.tags.length > 0) {
                const realTags = data.tags;
                initFlairInput('fe_included_tags', realTags, 'include');
                initFlairInput('fe_exclude_tags', realTags, 'exclude');
                initFlairInput('bx_qualifying_tags', realTags, 'bxgy');
                initFlairInput('td_included_tags', realTags, 'include');
                // Update the display text with real tag count
                const tagsDisplay = document.getElementById('fe_tags_display');
                if (tagsDisplay) tagsDisplay.textContent = realTags.length + ' tags loaded from store (type to search)';
                console.log('[Tags] Loaded ' + realTags.length + ' product tags from Shopify');
              } else {
                // Show fallback tags in display
                const tagsDisplay = document.getElementById('fe_tags_display');
                if (tagsDisplay) tagsDisplay.textContent = _staticTags.join(', ');
              }
            } catch (err) {
              console.warn('[Tags] Could not fetch real product tags, using defaults:', err.message);
              const tagsDisplay = document.getElementById('fe_tags_display');
              if (tagsDisplay) tagsDisplay.textContent = _staticTags.join(', ');
            }
          })();

          loadAdvancedRules();
          
          // Refresh button
          const refreshBtn = document.getElementById('refreshBtn');
          if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
              loadDiscounts();
              refreshBtn.textContent = '↻ Refreshing…';
              refreshBtn.disabled = true;
              setTimeout(() => {
                refreshBtn.textContent = '↻ Refresh';
                refreshBtn.disabled = false;
              }, 1200);
            });
          }
          
          const debugRefreshBtn = document.getElementById('debugLogRefresh');
          if (debugRefreshBtn) {
            debugRefreshBtn.addEventListener('click', loadDebugLog);
          }
          const debugClearBtn = document.getElementById('debugLogClear');
          if (debugClearBtn) {
            debugClearBtn.addEventListener('click', clearDebugLog);
          }
        });
        
        // Stop polling when page unloads
        window.addEventListener('beforeunload', stopPolling);

        // Refresh counters instantly when user returns to the tab
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') {
            loadDiscounts();
            if (typeof loadFunctionDiscounts === 'function') loadFunctionDiscounts();
            if (typeof loadShippingDiscounts === 'function') loadShippingDiscounts();
            if (typeof loadAdvancedRules === 'function') loadAdvancedRules();
          }
        });
      </script>

      <!-- Confirmation Modal -->
      <div id="confirmModal" class="confirm-overlay" style="display:none;">
        <div class="confirm-dialog">
          <h3 id="confirmTitle">Are you sure?</h3>
          <p id="confirmMessage"></p>
          <div class="confirm-actions">
            <button class="btn-confirm-cancel" id="confirmCancel">Cancel</button>
            <button class="btn-confirm-ok danger" id="confirmOk">Confirm</button>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <footer class="app-footer">
        <div style="display:flex;align-items:center;gap:10px;">
          <img src="/gcw-logo.svg" alt="GCW" style="height:22px;width:auto;opacity:0.35;filter:grayscale(1);" />
          <span>Gerber Childrenswear &copy; ${new Date().getFullYear()}</span>
        </div>
        <span>Discount Manager v3.0 &middot; Shopify Functions &amp; Rust/WASM</span>
        <span>Developer: Nicholas Cassidy</span>
      </footer>
    </body>
    </html>
  `);
  } catch (err) {
    console.error('[Dashboard] Unhandled error rendering home page:', err);
    reportError(err, { area: 'dashboard_render' });
    if (!res.headersSent) {
      res.status(500).send('Internal server error — please reload.');
    }
  }
});

// Percentage Off Configuration Page
app.get('/configure-percentage', (req, res) => {
  const apiKey = process.env.SHOPIFY_API_KEY || '';
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Configure Percentage Off - GCW Discount Manager</title>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${apiKey}"></script>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
      <style>
        :root {
          --navy-700: #1B365D; --navy-800: #0F2340; --navy-500: #4A6FA5; --navy-100: #EAF0F6; --navy-50: #F5F8FB;
          --bg: #FAF8F5; --surface: #FFFFFF; --text-primary: #1A1D21; --text-secondary: #5E6470; --text-muted: #9CA3AF;
          --border: #E5E7EB; --green-500: #059669; --green-100: #D1FAE5;
          --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px;
          --shadow-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
          --shadow-lg: 0 10px 25px -3px rgba(0,0,0,0.08), 0 4px 6px -4px rgba(0,0,0,0.04);
          --transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: var(--bg); padding: 32px 20px;
          -webkit-font-smoothing: antialiased; color: var(--text-primary); font-size: 14px; line-height: 1.5;
        }
        .container {
          max-width: 700px; margin: 0 auto; background: var(--surface);
          border-radius: var(--radius-lg); border: 1px solid var(--border);
          box-shadow: var(--shadow-lg); padding: 44px;
        }
        .breadcrumb {
          display: flex; align-items: center; gap: 8px; margin-bottom: 28px; font-size: 13px; color: var(--text-muted);
        }
        .breadcrumb a {
          color: var(--navy-700); text-decoration: none; font-weight: 600; cursor: pointer;
          transition: color var(--transition);
        }
        .breadcrumb a:hover { color: var(--navy-800); text-decoration: underline; }
        h1 {
          color: var(--navy-800); margin-bottom: 8px; font-size: 26px; font-weight: 800; letter-spacing: -0.04em;
        }
        .subtitle { color: var(--text-secondary); margin-bottom: 28px; font-size: 14px; }
        .form-group { margin-bottom: 22px; }
        label {
          display: block; margin-bottom: 6px; color: var(--text-secondary); font-weight: 600;
          font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;
        }
        input, textarea, select {
          width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm);
          font-family: inherit; font-size: 14px; color: var(--text-primary); background: var(--surface);
          transition: all var(--transition);
        }
        input:focus, textarea:focus, select:focus {
          outline: none; border-color: var(--navy-500); box-shadow: 0 0 0 3px rgba(74,111,165,0.12);
        }
        input::placeholder, textarea::placeholder { color: var(--text-muted); }
        textarea { resize: vertical; min-height: 80px; }
        .help-text { font-size: 11px; color: var(--text-muted); margin-top: 5px; }
        .divider { height: 1px; background: var(--border); margin: 32px 0; }
        .button-group { display: flex; gap: 12px; margin-top: 32px; }
        button {
          padding: 12px 24px; border: none; border-radius: var(--radius-sm);
          font-size: 14px; font-weight: 600; cursor: pointer; transition: all var(--transition); font-family: inherit;
        }
        .btn-primary {
          background: var(--navy-700); color: white; flex: 1;
        }
        .btn-primary:hover { background: var(--navy-800); box-shadow: var(--shadow-sm); transform: translateY(-1px); }
        .btn-secondary {
          background: var(--navy-50); color: var(--navy-700); border: 1px solid var(--border); flex: 1;
        }
        .btn-secondary:hover { background: var(--navy-100); }
        .info-box {
          background: var(--navy-50); border-left: 4px solid var(--navy-700);
          padding: 14px 18px; margin-bottom: 24px; border-radius: var(--radius-sm);
          font-size: 13px; line-height: 1.6; color: var(--text-primary);
        }
        .info-box strong { color: var(--navy-700); }
        h3 { color: var(--text-primary); margin-bottom: 14px; font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
        @media (max-width: 640px) { .container { padding: 24px; } h1 { font-size: 22px; } }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="breadcrumb">
          <a onclick="window.location.href='/'">← Home</a>
          <span>/</span>
          <span>Configure Percentage Off</span>
        </div>
        
        <h1>Percentage Off Discount</h1>
        <p class="subtitle">Set up a discount that gives customers a percentage off their purchase</p>
        
        <div class="info-box">
          <strong>💡 Tip:</strong> You can create unlimited discounts with different percentages and settings. Each one can have its own message and excluded products.
        </div>
        
        <form onsubmit="handleSave(event)">
          <div class="form-group">
            <label>Discount Name *</label>
            <input type="text" id="discountName" placeholder="e.g., Spring Sale 25% Off" required>
            <div class="help-text">How you'll identify this discount in your dashboard</div>
          </div>
          
          <div class="form-group">
            <label>Discount Percentage *</label>
            <div style="display: flex; gap: 8px; align-items: center;">
              <input type="number" id="discountPercent" value="25" min="0" max="100" required style="flex: 1;">
              <span style="color: #999; font-weight: 500;">%</span>
            </div>
            <div class="help-text">The percentage off applied (0-100%)</div>
          </div>
          
          <div class="form-group">
            <label>Cart Drawer Message</label>
            <input type="text" id="cartMessage" value="25% OFF APPLIED!!!" placeholder="Message shown in cart drawer">
            <div class="help-text">Message shown to customers when they view their cart</div>
          </div>
          
          <div class="form-group">
            <label>Checkout Message</label>
            <input type="text" id="checkoutMessage" value="Enjoy your 25% discount!" placeholder="Message shown at checkout">
            <div class="help-text">Message shown to customers at checkout (Shopify Plus feature)</div>
          </div>
          
          <div class="form-group">
            <label>Excluded Product Tags</label>
            <textarea id="excludedTags" placeholder="tag1,tag2,tag3">flag:doorbuster,no discount,collection:semi annual sale</textarea>
            <div class="help-text">Comma-separated tags. Products with ANY of these tags won't get the discount.</div>
          </div>

          <div class="form-group">
            <label>Included Product Tags</label>
            <textarea id="includedTags" placeholder="tag1,tag2,tag3">discount</textarea>
            <div class="help-text">Comma-separated tags. Only products with ANY of these tags will get the discount.</div>
          </div>
          
          <div class="divider"></div>
          
          <h3 style="color: #333; margin-bottom: 15px; font-size: 16px;">Schedule (Optional)</h3>
          <div class="help-text" style="margin: -8px 0 16px;">All times are interpreted as EST (America/New_York).</div>
          
          <div class="form-group">
            <label>Start Date</label>
            <input type="datetime-local" id="startDate">
            <div class="help-text">When this discount becomes active. Leave blank for immediate.</div>
          </div>
          
          <div class="form-group">
            <label>Stop Date</label>
            <input type="datetime-local" id="stopDate">
            <div class="help-text">When this discount expires. Leave blank to run indefinitely.</div>
          </div>

          <div class="form-group" style="margin-top: 20px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="activateNow" checked style="width: auto; accent-color: #1B365D;">
              <span>Activate in Shopify immediately (push to Discounts tab)</span>
            </label>
            <div class="help-text">If checked, this discount will be created in Shopify right away. Uncheck to save as draft only.</div>
          </div>
          
          <div class="button-group">
            <button type="submit" class="btn-primary">Save & Activate</button>
            <button type="button" class="btn-secondary" onclick="window.location.href='/'">Cancel</button>
          </div>
        </form>
      </div>
      
      <script>
        const urlParams = new URLSearchParams(window.location.search);
        const discountId = urlParams.get('id');

        function reportClientError(error, context = {}) {
          console.error('[GCW Error]', context.area || 'client', error?.message || error);
          fetch('/api/errors/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: error?.message || String(error),
              area: context.area || 'client',
              stack: error?.stack || '',
              extra: context,
            }),
          }).catch(() => {});
        }
        
        // Load existing discount data if editing
        async function loadDiscount() {
          if (!discountId || discountId === 'new') return;
          
          try {
            const response = await fetch('/api/discount/' + discountId + '/load');
            const result = await response.json();
            
            if (result.success) {
              const data = result.data;
              document.getElementById('discountName').value = data.name || '';
              document.getElementById('discountPercent').value = data.value || 25;
              document.getElementById('cartMessage').value = data.cart_message || '';
              document.getElementById('checkoutMessage').value = data.checkout_message || '';
              document.getElementById('excludedTags').value = data.excluded_tags || '';
              document.getElementById('includedTags').value = data.included_tags || '';
              document.getElementById('startDate').value = data.start_date || '';
              document.getElementById('stopDate').value = data.end_date || '';
            }
          } catch (error) {
            reportClientError(error, { area: 'percentage_load' });
          }
        }
        
        async function getFreshIdToken() {
          try {
            if (window.shopify && typeof window.shopify.idToken === 'function') {
              const token = await window.shopify.idToken();
              if (token) return token;
            }
          } catch (e) { /* ignore */ }
          const urlParams2 = new URLSearchParams(window.location.search);
          return urlParams2.get('id_token') || '';
        }

        async function handleSave(e) {
          e.preventDefault();
          const submitBtn = e.target.querySelector('button[type=submit]');
          submitBtn.disabled = true;
          submitBtn.textContent = 'Saving...';
          
          const settings = {
            type: 'percentage',
            name: document.getElementById('discountName').value,
            value: parseInt(document.getElementById('discountPercent').value),
            cart_message: document.getElementById('cartMessage').value,
            checkout_message: document.getElementById('checkoutMessage').value,
            excluded_tags: document.getElementById('excludedTags').value,
            included_tags: document.getElementById('includedTags').value,
            start_date: document.getElementById('startDate').value || null,
            end_date: document.getElementById('stopDate').value || null,
            paused: false
          };
          
          const activateNow = document.getElementById('activateNow').checked;
          const newId = discountId && discountId !== 'new' ? discountId : null;
          const shopParam = urlParams.get('shop') || '';
          const idToken = await getFreshIdToken();
          
          const headers = { 'Content-Type': 'application/json' };
          if (idToken) headers['X-Shopify-Id-Token'] = idToken;
          
          const url = '/api/discount/' + (newId ? 'save' : 'create') + (shopParam ? '?shop=' + encodeURIComponent(shopParam) : '');
          
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(newId ? { id: newId, settings } : { settings, activateNow })
            });
            const result = await response.json();
            if (result.success) {
              const activated = result.data?.activated ? ' and activated in Shopify!' : ' (draft — not yet in Shopify)';
              alert('✓ Discount saved' + activated + ' | ' + settings.name + ' | ' + settings.value + '% off');
              window.location.href = '/' + (shopParam ? '?shop=' + encodeURIComponent(shopParam) : '');
            } else {
              alert('Error: ' + (result.error || 'Failed to save'));
              submitBtn.disabled = false;
              submitBtn.textContent = 'Save & Activate';
            }
          } catch (err) {
            reportClientError(err, { area: 'percentage_save' });
            alert('Error saving discount: ' + err.message);
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save & Activate';
          }
        }
        
        document.addEventListener('DOMContentLoaded', loadDiscount);
      </script>
    </body>
    </html>
  `);
});

// Free Shipping Configuration Page
app.get('/configure-shipping', (req, res) => {
  const apiKey = process.env.SHOPIFY_API_KEY || '';
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Configure Free Shipping - GCW Discount Manager</title>
      <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${apiKey}"></script>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
      <style>
        :root {
          --navy-700: #1B365D; --navy-800: #0F2340; --navy-500: #4A6FA5; --navy-100: #EAF0F6; --navy-50: #F5F8FB;
          --bg: #FAF8F5; --surface: #FFFFFF; --text-primary: #1A1D21; --text-secondary: #5E6470; --text-muted: #9CA3AF;
          --border: #E5E7EB; --green-500: #059669; --green-100: #D1FAE5;
          --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px;
          --shadow-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
          --shadow-lg: 0 10px 25px -3px rgba(0,0,0,0.08), 0 4px 6px -4px rgba(0,0,0,0.04);
          --transition: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: var(--bg); padding: 32px 20px;
          -webkit-font-smoothing: antialiased; color: var(--text-primary); font-size: 14px; line-height: 1.5;
        }
        .container {
          max-width: 700px; margin: 0 auto; background: var(--surface);
          border-radius: var(--radius-lg); border: 1px solid var(--border);
          box-shadow: var(--shadow-lg); padding: 44px;
        }
        .breadcrumb {
          display: flex; align-items: center; gap: 8px; margin-bottom: 28px; font-size: 13px; color: var(--text-muted);
        }
        .breadcrumb a {
          color: var(--navy-700); text-decoration: none; font-weight: 600; cursor: pointer;
          transition: color var(--transition);
        }
        .breadcrumb a:hover { color: var(--navy-800); text-decoration: underline; }
        h1 {
          color: var(--navy-800); margin-bottom: 8px; font-size: 26px; font-weight: 800; letter-spacing: -0.04em;
        }
        .subtitle { color: var(--text-secondary); margin-bottom: 28px; font-size: 14px; }
        .form-group { margin-bottom: 22px; }
        label {
          display: block; margin-bottom: 6px; color: var(--text-secondary); font-weight: 600;
          font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em;
        }
        input, textarea, select {
          width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm);
          font-family: inherit; font-size: 14px; color: var(--text-primary); background: var(--surface);
          transition: all var(--transition);
        }
        input:focus, textarea:focus, select:focus {
          outline: none; border-color: var(--navy-500); box-shadow: 0 0 0 3px rgba(74,111,165,0.12);
        }
        input::placeholder, textarea::placeholder { color: var(--text-muted); }
        textarea { resize: vertical; min-height: 80px; }
        .help-text { font-size: 11px; color: var(--text-muted); margin-top: 5px; }
        .divider { height: 1px; background: var(--border); margin: 32px 0; }
        .price-input-group { display: flex; gap: 8px; align-items: center; }
        .price-input-group span { color: var(--text-muted); font-weight: 600; }
        .button-group { display: flex; gap: 12px; margin-top: 32px; }
        button {
          padding: 12px 24px; border: none; border-radius: var(--radius-sm);
          font-size: 14px; font-weight: 600; cursor: pointer; transition: all var(--transition); font-family: inherit;
        }
        .btn-primary {
          background: var(--navy-700); color: white; flex: 1;
        }
        .btn-primary:hover { background: var(--navy-800); box-shadow: var(--shadow-sm); transform: translateY(-1px); }
        .btn-secondary {
          background: var(--navy-50); color: var(--navy-700); border: 1px solid var(--border); flex: 1;
        }
        .btn-secondary:hover { background: var(--navy-100); }
        .info-box {
          background: var(--navy-50); border-left: 4px solid var(--navy-700);
          padding: 14px 18px; margin-bottom: 24px; border-radius: var(--radius-sm);
          font-size: 13px; line-height: 1.6; color: var(--text-primary);
        }
        .info-box strong { color: var(--navy-700); }
        h3 { color: var(--text-primary); margin-bottom: 14px; font-size: 15px; font-weight: 700; letter-spacing: -0.01em; }
        @media (max-width: 640px) { .container { padding: 24px; } h1 { font-size: 22px; } }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="breadcrumb">
          <a onclick="window.location.href='/'">← Home</a>
          <span>/</span>
          <span>Configure Free Shipping</span>
        </div>
        
        <h1>Free Shipping Discount</h1>
        <p class="subtitle">Offer free shipping when customers meet a minimum order amount</p>
        
        <div class="info-box">
          <strong>🚚 How it works:</strong> When a customer's cart reaches the minimum amount you set, free shipping is automatically applied at checkout.
        </div>
        
        <form onsubmit="handleSave(event)">
          <div class="form-group">
            <label>Discount Name *</label>
            <input type="text" id="discountName" placeholder="e.g., Free Shipping on $50+" required>
            <div class="help-text">How you'll identify this discount in your dashboard</div>
          </div>
          
          <div class="form-group">
            <label>Minimum Order Amount *</label>
            <div class="price-input-group">
              <span>$</span>
              <input type="number" id="freeShippingThreshold" placeholder="e.g., 50" min="0" step="0.01" required style="flex: 1;">
            </div>
            <div class="help-text">Customers get free shipping when their cart is at least this amount</div>
          </div>
          
          <div class="form-group">
            <label>Checkout Message</label>
            <input type="text" id="checkoutMessage" value="FREE SHIPPING ON THIS ORDER!" placeholder="Message shown at checkout">
            <div class="help-text">Message displayed to customers at checkout when free shipping is applied</div>
          </div>
          
          <div class="form-group">
            <label>Promotional Message (Optional)</label>
            <input type="text" id="promotionalMessage" placeholder="e.g., Free shipping on orders $50 and up" value="">
            <div class="help-text">Display on your store to encourage customers to add more to their cart</div>
          </div>
          
          <div class="divider"></div>
          
          <h3 style="color: #333; margin-bottom: 15px; font-size: 16px;">Schedule (Optional)</h3>
          
          <div class="form-group">
            <label>Start Date</label>
            <input type="datetime-local" id="startDate">
            <div class="help-text">When this discount becomes active. Leave blank for immediate.</div>
          </div>
          
          <div class="form-group">
            <label>Stop Date</label>
            <input type="datetime-local" id="stopDate">
            <div class="help-text">When this discount expires. Leave blank to run indefinitely.</div>
          </div>

          <div class="form-group" style="margin-top: 20px;">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="activateNow" checked style="width: auto; accent-color: #1B365D;">
              <span>Activate in Shopify immediately (push to Discounts tab)</span>
            </label>
            <div class="help-text">If checked, this discount will be created in Shopify right away. Uncheck to save as draft only.</div>
          </div>
          
          <div class="button-group">
            <button type="submit" class="btn-primary">Save & Activate</button>
            <button type="button" class="btn-secondary" onclick="window.location.href='/'">Cancel</button>
          </div>
        </form>
      </div>
      
      <script>
        const urlParams = new URLSearchParams(window.location.search);
        const discountId = urlParams.get('id');

        function reportClientError(error, context = {}) {
          console.error('[GCW Error]', context.area || 'client', error?.message || error);
          fetch('/api/errors/report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: error?.message || String(error),
              area: context.area || 'client',
              stack: error?.stack || '',
              extra: context,
            }),
          }).catch(() => {});
        }

        // Load existing discount data if editing
        async function loadDiscount() {
          if (!discountId || discountId === 'new') return;
          
          try {
            const response = await fetch('/api/discount/' + discountId + '/load');
            const result = await response.json();
            
            if (result.success) {
              const data = result.data;
              document.getElementById('discountName').value = data.name || '';
              document.getElementById('freeShippingThreshold').value = data.value || 50;
              document.getElementById('checkoutMessage').value = data.checkout_message || '';
              document.getElementById('promotionalMessage').value = data.promo_message || '';
              document.getElementById('startDate').value = data.start_date || '';
              document.getElementById('stopDate').value = data.end_date || '';
            }
          } catch (error) {
            reportClientError(error, { area: 'shipping_load' });
          }
        }
        
        async function getFreshIdToken() {
          try {
            if (window.shopify && typeof window.shopify.idToken === 'function') {
              const token = await window.shopify.idToken();
              if (token) return token;
            }
          } catch (e) { /* ignore */ }
          return urlParams.get('id_token') || '';
        }

        async function handleSave(e) {
          e.preventDefault();
          const submitBtn = e.target.querySelector('button[type=submit]');
          submitBtn.disabled = true;
          submitBtn.textContent = 'Saving...';

          const threshold = document.getElementById('freeShippingThreshold').value;
          
          const settings = {
            type: 'free_shipping',
            name: document.getElementById('discountName').value,
            value: parseFloat(threshold),
            checkout_message: document.getElementById('checkoutMessage').value,
            promo_message: document.getElementById('promotionalMessage').value,
            start_date: document.getElementById('startDate').value || null,
            end_date: document.getElementById('stopDate').value || null,
            paused: false
          };
          
          const activateNow = document.getElementById('activateNow').checked;
          const newId = discountId && discountId !== 'new' ? discountId : null;
          const shopParam = urlParams.get('shop') || '';
          const idToken = await getFreshIdToken();

          const headers = { 'Content-Type': 'application/json' };
          if (idToken) headers['X-Shopify-Id-Token'] = idToken;

          const url = '/api/discount/' + (newId ? 'save' : 'create') + (shopParam ? '?shop=' + encodeURIComponent(shopParam) : '');
          
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(newId ? { id: newId, settings } : { settings, activateNow })
            });
            const result = await response.json();
            if (result.success) {
              const activated = result.data?.activated ? ' and activated in Shopify!' : ' (draft)';
              alert('✓ Discount saved' + activated + ' | ' + settings.name + ' | Free shipping on orders $' + threshold + '+');
              window.location.href = '/' + (shopParam ? '?shop=' + encodeURIComponent(shopParam) : '');
            } else {
              alert('Error: ' + (result.error || 'Failed to save'));
              submitBtn.disabled = false;
              submitBtn.textContent = 'Save & Activate';
            }
          } catch (err) {
            reportClientError(err, { area: 'shipping_save' });
            alert('Error saving discount: ' + err.message);
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save & Activate';
          }
        }
        
        document.addEventListener('DOMContentLoaded', loadDiscount);
      </script>
    </body>
    </html>
  `);
});

// Graceful shutdown & crash handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
  reportError(reason instanceof Error ? reason : new Error(String(reason)), { area: 'unhandled_rejection' });
});


process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  reportError(err, { area: 'uncaught_exception' });
  process.exit(1);
});

const server = app.listen(PORT, () => {
  console.log(`
[GCW Discount App] Server started
  Port: ${PORT}
  URL: ${appUrl}
  Status: Ready for OAuth
  
  Credentials:
  - SHOPIFY_API_KEY: ${process.env.SHOPIFY_API_KEY ? 'SET' : 'MISSING'}
  - SHOPIFY_API_SECRET: ${process.env.SHOPIFY_API_SECRET ? 'SET' : 'MISSING'}
  - SHOPIFY_APP_URL: ${process.env.SHOPIFY_APP_URL ? 'SET' : 'MISSING'}
  
  Config:
  - Callback URL: ${hostScheme}://${hostName}/api/auth/callback
  - Diagnostics: https://${hostName}/api/diagnostics
`);
});

// Graceful shutdown for Render / container environments
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[Shutdown] Received ${signal}, closing server...`);
    server.close(() => {
      console.log('[Shutdown] Server closed.');
      process.exit(0);
    });
    // Force exit after 10s if connections don't drain
    setTimeout(() => process.exit(1), 10000).unref();
  });
}