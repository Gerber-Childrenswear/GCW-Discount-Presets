import crypto from 'crypto';
import { DEFAULT_SHOP, SHOPIFY_API_VERSION, appUrl, hostName, hostScheme } from './config.js';
import { shopSessions, persistSessions, getAccessToken, setRuntimeAccessToken } from './session-store.js';
import { makeGqlClient } from './graphql-client.js';
import { reportError } from './error-logger.js';
import { discountsStore, registerDiscount } from './discount-store.js';

// Fetch with timeout — prevents hanging requests to Shopify
const DEFAULT_FETCH_TIMEOUT = 15000; // 15 seconds
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Request to ${new URL(url).hostname} timed out after ${timeoutMs / 1000}s`);
    throw err;
  }
}

// Validate Shopify shop domain (*.myshopify.com format)
export function isValidShopDomain(shop) {
  return typeof shop === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop);
}

export async function resolveShopifyAccess(req, res, next) {
  const shopRaw = req.query.shop || req.body?.shop || req.headers['x-shopify-shop'] || DEFAULT_SHOP;
  const shop = isValidShopDomain(shopRaw) ? shopRaw : DEFAULT_SHOP;
  req.shopifyShop = shop;

  let accessToken = getAccessToken(shop);

  if (!accessToken) {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const sessionToken = authHeader.slice(7);
      console.log(`[Auth Middleware] No token for ${shop}, attempting token exchange from Authorization header...`);
      accessToken = await exchangeToken(shop, sessionToken);
    }
  }

  req.shopifyAccessToken = accessToken;

  if (next) {
    next();
  } else {
    return { shop, accessToken };
  }
}

export async function getOrExchangeToken(req) {
  const shopRaw = req.query.shop || req.body?.shop || req.headers['x-shopify-shop'] || DEFAULT_SHOP;
  const shop = isValidShopDomain(shopRaw) ? shopRaw : null;
  if (!shop) return { shop: null, accessToken: null };
  
  let accessToken = getAccessToken(shop);
  if (accessToken) return { shop, accessToken };
  
  const idToken = req.headers['x-shopify-id-token'] 
    || (req.headers.authorization && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null)
    || req.query.id_token;
  if (idToken) {
    console.log(`[getOrExchangeToken] No stored token for ${shop}, trying token exchange...`);
    accessToken = await exchangeToken(shop, idToken);
    if (accessToken) return { shop, accessToken };
  }
  
  console.error(`[getOrExchangeToken] No token and no id_token available for ${shop}`);
  return { shop, accessToken: null };
}

export async function exchangeToken(shop, idToken) {
  try {
    console.log(`[TokenExchange] Exchanging id_token for ${shop} (token length: ${idToken?.length || 0})...`);
    
    const params = new URLSearchParams({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
    });

    const response = await fetchWithTimeout(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
    });

    const text = await response.text();
    console.log(`[TokenExchange] Response status: ${response.status}, body length: ${text.length}`);
    let data;
    try { data = JSON.parse(text); } catch {
      console.error(`[TokenExchange] Non-JSON response (${response.status}) for ${shop}:`, text.substring(0, 300));
      return null;
    }

    if (!response.ok || !data.access_token) {
      console.error(`[TokenExchange] Failed for ${shop}:`, data);
      return null;
    }

    shopSessions[shop] = {
      accessToken: data.access_token,
      scope: data.scope,
      shop,
      installedAt: new Date().toISOString(),
    };
    persistSessions();

    console.log(`[TokenExchange] ✓ Access token obtained for ${shop} (scope: ${data.scope})`);

    autoActivateDiscounts(shop, data.access_token).catch(err => {
      console.error(`[AutoActivate] Error:`, err.message);
    });

    return data.access_token;
  } catch (err) {
    console.error(`[TokenExchange] Error for ${shop}:`, err.message);
    return null;
  }
}

// Cache: Shopify user ID (JWT sub) → email
const userEmailCache = {};

export async function resolveUserEmail(shop, idToken) {
  if (!idToken || !shop) return null;
  try {
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const sub = payload.sub;
    if (sub && userEmailCache[sub]) return userEmailCache[sub];

    // Approach 1: Online token exchange (returns associated_user.email)
    try {
      const params = new URLSearchParams({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: idToken,
        subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        requested_token_type: 'urn:shopify:params:oauth:token-type:online-access-token',
      });
      const resp = await fetchWithTimeout(`https://${shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: params.toString(),
      });
      const text = await resp.text();
      let data; try { data = JSON.parse(text); } catch { data = null; }
      if (resp.ok && data?.associated_user?.email) {
        const email = data.associated_user.email.toLowerCase();
        if (sub) userEmailCache[sub] = email;
        console.log(`[ResolveEmail] User ${sub} → ${email} (online exchange)`);
        return email;
      }
      console.warn(`[ResolveEmail] Online exchange (${resp.status}):`, (text || '').substring(0, 200));
    } catch (e) {
      console.warn(`[ResolveEmail] Online exchange error:`, e.message);
    }

    // Approach 2: GraphQL staffMembers query using offline access token
    const accessToken = getAccessToken(shop);
    if (accessToken && sub) {
      try {
        const gqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
        const resp = await fetchWithTimeout(gqlUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
          body: JSON.stringify({ query: '{ staffMembers(first: 100) { edges { node { id email } } } }' }),
        });
        const data = await resp.json();
        const edges = data.data?.staffMembers?.edges || [];
        for (const { node } of edges) {
          const memberId = node.id?.split('/').pop();
          if (node.email && memberId) {
            userEmailCache[memberId] = node.email.toLowerCase();
          }
        }
        if (userEmailCache[sub]) {
          console.log(`[ResolveEmail] User ${sub} → ${userEmailCache[sub]} (GraphQL staffMembers)`);
          return userEmailCache[sub];
        }
        if (data.errors) {
          console.warn(`[ResolveEmail] GraphQL errors:`, JSON.stringify(data.errors).substring(0, 300));
        } else {
          console.warn(`[ResolveEmail] GraphQL: ${edges.length} staff found, sub ${sub} not matched`);
        }
      } catch (e) {
        console.warn(`[ResolveEmail] GraphQL staffMembers error:`, e.message);
      }
    }

    console.warn(`[ResolveEmail] All approaches failed for sub ${sub}`);
    return null;
  } catch (err) {
    console.error('[ResolveEmail] Error:', err.message);
    return null;
  }
}

export { userEmailCache };

export async function autoActivateDiscounts(shop, accessToken) {
  const discountsToActivate = Object.values(discountsStore).filter(d => !d.paused && !d.activated);
  
  if (discountsToActivate.length === 0) {
    console.log(`[AutoActivate] No discounts need activation`);
    return;
  }

  console.log(`[AutoActivate] Activating ${discountsToActivate.length} discounts for ${shop}...`);
  const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  for (const discount of discountsToActivate) {
    try {
      const fnResult = await autoActivateAsFunction(shop, accessToken, graphqlUrl, discount);
      if (fnResult) {
        console.log(`[AutoActivate] ✓ ${discount.id} (${discount.name}) → Function discount created: ${fnResult}`);
        continue;
      }
      const basicResult = await autoActivateAsBasic(shop, accessToken, graphqlUrl, discount);
      if (basicResult) {
        console.log(`[AutoActivate] ✓ ${discount.id} (${discount.name}) → Basic discount created: ${basicResult}`);
      } else {
        console.error(`[AutoActivate] ✗ ${discount.id} (${discount.name}) → Failed to create`);
      }
    } catch (err) {
      console.error(`[AutoActivate] ✗ ${discount.id} error:`, err.message);
    }
  }
}

export async function autoActivateAsFunction(shop, accessToken, graphqlUrl, discount) {
  try {
    const fnResponse = await fetchWithTimeout(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: '{ shopifyFunctions(first: 50) { nodes { id apiType title } } }' })
    });
    const fnResult = await fnResponse.json();
    const functions = fnResult.data?.shopifyFunctions?.nodes || [];
    
    const isDiscountFn = (fn) => fn.apiType === 'product_discounts' || (fn.apiType && fn.apiType.toLowerCase().includes('discount'));
    const isShippingApiType = (fn) => {
      const t = (fn.apiType || '').toLowerCase();
      return t.includes('delivery') || t.includes('shipping') || t.includes('discount');
    };
    const isNotShipping = (fn) => !(fn.title || '').toLowerCase().includes('shipping');
    const isShippingFn = (fn) => (fn.title || '').toLowerCase().includes('shipping') && isShippingApiType(fn);

    const isShippingDiscount = discount.type === 'free_shipping';
    const discountFunction = isShippingDiscount
      ? (functions.find(fn => isShippingFn(fn)) || null)
      : (functions.find(fn => isDiscountFn(fn) && isNotShipping(fn)) || (functions.length === 1 ? functions[0] : null));
    
    if (!discountFunction) return null;

    const title = discount.name || `Discount ${discount.id}`;
    const startsAt = discount.start_date ? new Date(discount.start_date).toISOString() : new Date().toISOString();
    const endsAt = discount.end_date ? new Date(discount.end_date).toISOString() : null;

    const autoNormalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const autoNormalizedTitle = autoNormalize(title);
    try {
      let autoAllNodes = [];
      let autoCursor = null;
      for (let page = 0; page < 5; page++) {
        const afterClause = autoCursor ? `, after: "${autoCursor}"` : '';
        const searchResp = await fetchWithTimeout(graphqlUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
          body: JSON.stringify({ query: `query { discountNodes(first: 50${afterClause}) { nodes { id discount { ... on DiscountAutomaticApp { title } ... on DiscountAutomaticBasic { title } } } pageInfo { hasNextPage endCursor } } }` })
        });
        const searchData = await searchResp.json();
        const nodes = searchData.data?.discountNodes?.nodes || [];
        autoAllNodes = autoAllNodes.concat(nodes);
        const pi = searchData.data?.discountNodes?.pageInfo;
        if (!pi?.hasNextPage) break;
        autoCursor = pi.endCursor;
      }
      const existing = autoAllNodes.filter(n => {
        const t = n.discount?.title;
        return t === title || autoNormalize(t) === autoNormalizedTitle;
      });
      for (const node of existing) {
        console.log(`[AutoActivate] Deleting duplicate "${title}" (${node.id})`);
        await fetchWithTimeout(graphqlUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
          body: JSON.stringify({ query: `mutation deleteDupe($id: ID!) { discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId } }`, variables: { id: node.id } })
        });
      }
    } catch (e) { console.warn('[AutoActivate] Duplicate check failed:', e.message); }

    let metafieldConfig, metafieldKey, discountClasses;
    if (isShippingDiscount) {
      metafieldKey = 'shipping_config';
      discountClasses = ['SHIPPING'];
      metafieldConfig = {
        threshold: discount.value || 50,
        message: discount.checkout_message || `Free shipping on orders over $${discount.value || 50}!`,
      };
    } else {
      metafieldKey = 'discount_config';
      discountClasses = ['PRODUCT'];
      metafieldConfig = {
        percentage: discount.value || 25,
        message: discount.checkout_message || `${discount.value}% Off!`,
        exclude_gift_cards: true,
        included_tags: discount.included_tags
          ? String(discount.included_tags).split(',').map(t => t.trim()).filter(Boolean)
          : [],
        exclude_tags: discount.excluded_tags
          ? String(discount.excluded_tags).split(',').map(t => t.trim()).filter(Boolean)
          : [],
        exclude_product_types: [],
        exclude_vendors: [],
        exclude_product_ids: [],
      };
    }

    const mutation = `
      mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { discountId title status }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      automaticAppDiscount: {
        title,
        functionId: discountFunction.id,
        startsAt,
        endsAt,
        discountClasses,
        combinesWith: {
          orderDiscounts: !!discount.combines_with_order,
          productDiscounts: !!discount.combines_with_product,
          shippingDiscounts: !!discount.combines_with_shipping
        },
        metafields: [{
          namespace: 'gcw',
          key: metafieldKey,
          type: 'json',
          value: JSON.stringify(metafieldConfig),
        }],
      }
    };

    const createResponse = await fetchWithTimeout(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: mutation, variables })
    });
    const createResult = await createResponse.json();
    const createData = createResult.data?.discountAutomaticAppCreate;
    
    if (createData?.userErrors?.length) {
      console.warn(`[AutoActivate] Function userErrors for ${discount.id}:`, createData.userErrors);
      return null;
    }

    const discountId = createData?.automaticAppDiscount?.discountId;
    if (discountId) {
      registerDiscount(
        discountId,
        shop,
        isShippingDiscount ? 'shipping-function' : 'function-engine'
      );
      discount.shopify_discount_id = discountId;
      discount.activated = true;
      discount.function_id = discountFunction.id;
    }
    return discountId;
  } catch (err) {
    console.warn(`[AutoActivate] Function activation failed for ${discount.id}:`, err.message);
    return null;
  }
}

export async function autoActivateAsBasic(shop, accessToken, graphqlUrl, discount) {
  if (discount.type !== 'percentage') return null;
  
  const title = discount.name || `Discount ${discount.id}`;
  const startsAt = discount.start_date ? new Date(discount.start_date).toISOString() : new Date().toISOString();
  const endsAt = discount.end_date ? new Date(discount.end_date).toISOString() : null;
  const percentageValue = parseFloat(discount.value) || 0;

  const mutation = `
    mutation discountAutomaticBasicCreate($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
      discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }
  `;
  const variables = {
    automaticBasicDiscount: {
      title,
      startsAt,
      endsAt,
      combinesWith: {
        orderDiscounts: !!discount.combines_with_order,
        productDiscounts: !!discount.combines_with_product,
        shippingDiscounts: !!discount.combines_with_shipping
      },
      customerGets: {
        value: { percentage: percentageValue / 100 },
        items: { all: true }
      },
      discountClasses: ['PRODUCT']
    }
  };

  const response = await fetchWithTimeout(graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query: mutation, variables })
  });
  const result = await response.json();
  const createData = result.data?.discountAutomaticBasicCreate;
  
  if (createData?.userErrors?.length) {
    console.warn(`[AutoActivate] Basic userErrors for ${discount.id}:`, createData.userErrors);
    return null;
  }

  const discountId = createData?.automaticDiscountNode?.id;
  if (discountId) {
    discount.shopify_discount_id = discountId;
    discount.activated = true;
  }
  return discountId;
}

export async function setDiscountMetafield(shop, accessToken, graphqlUrl, discount) {
  try {
    const discountGid = discount.shopify_discount_id;
    if (!discountGid) {
      console.warn(`[setDiscountMetafield] No shopify_discount_id for ${discount.id}`);
      return;
    }

    const configMetafield = {
      percentage: discount.value || 25,
      message: discount.checkout_message || `${discount.value}% Off!`,
      exclude_gift_cards: true,
      included_tags: discount.included_tags
        ? String(discount.included_tags).split(',').map(t => t.trim()).filter(Boolean)
        : [],
      exclude_tags: discount.excluded_tags
        ? String(discount.excluded_tags).split(',').map(t => t.trim()).filter(Boolean)
        : [],
      exclude_product_types: [],
      exclude_vendors: [],
      exclude_product_ids: [],
    };

    await fetchWithTimeout(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({
        query: `mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } }
        }`,
        variables: {
          metafields: [{
            ownerId: discountGid,
            namespace: 'gcw',
            key: 'discount_config',
            type: 'json',
            value: JSON.stringify(configMetafield)
          }]
        }
      })
    });
  } catch (err) {
    console.warn(`[setDiscountMetafield] Failed for ${discount.id}:`, err.message);
  }
}
