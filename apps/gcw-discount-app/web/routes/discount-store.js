import { Router } from 'express';
import { SHOPIFY_API_VERSION } from '../config.js';
import { requireAdmin, requireBuilder, requireViewer, hasPermission } from '../rbac.js';
import { getOrExchangeToken } from '../shopify-utils.js';
import { reportError } from '../error-logger.js';
import { discountsStore } from '../discount-store.js';
import { DEFAULT_SHOP } from '../config.js';
import { autoActivateAsFunction, autoActivateAsBasic } from '../shopify-utils.js';

const router = Router();

// Fetch with timeout to prevent hanging requests
const FETCH_TIMEOUT = 15000;
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Shopify API timeout after ${FETCH_TIMEOUT / 1000}s`);
    throw err;
  }
}

router.post('/api/discount/save', requireBuilder, (req, res) => {
  try {
    const { id, settings } = req.body;
    if (!id || !settings) {
      return res.status(400).json({ error: 'Missing id or settings' });
    }
    const existing = discountsStore[id];
    if (existing && existing.activated && !existing.paused && !hasPermission(req.userRole, 3)) {
      return res.status(403).json({ error: 'Only admins can edit live/active discounts' });
    }
    
    discountsStore[id] = { id, ...settings };
    if (process.env.NODE_ENV === 'development') {
      console.log(`Discount ${id} saved`);
    }
    
    res.json({ success: true, data: discountsStore[id] });
  } catch (error) {
    reportError(error, { area: 'discount_save' });
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/discount/:id/activate', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const discount = discountsStore[id];
    
    if (!discount) {
      return res.status(404).json({ error: 'Discount not found' });
    }

    const { shop, accessToken } = await getOrExchangeToken(req);
    
    if (!shop) {
      return res.status(401).json({ error: 'Missing shop parameter' });
    }
    if (!accessToken) {
      return res.status(401).json({ error: 'Missing Shopify access token. Send id_token header or install the app first.' });
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`Activating basic discount ${id}`);
    }
    
    let mutation, variables;
    
    if (discount.type === 'percentage') {
      const title = discount.name || `Discount ${id}`;
      const startsAt = discount.start_date ? new Date(discount.start_date).toISOString() : new Date().toISOString();
      const endsAt = discount.end_date ? new Date(discount.end_date).toISOString() : null;
      const percentageValue = parseFloat(discount.value) || 0;
      
      mutation = `
        mutation discountAutomaticBasicCreate($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
          discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
            automaticDiscountNode {
              id
              automaticDiscount {
                ... on DiscountAutomaticBasic { title startsAt endsAt status }
              }
            }
            userErrors { field message }
          }
        }
      `;

      variables = {
        automaticBasicDiscount: {
          title, startsAt, endsAt,
          combinesWith: {
            orderDiscounts: !!discount.combines_with_order,
            productDiscounts: !!discount.combines_with_product,
            shippingDiscounts: !!discount.combines_with_shipping
          },
          customerGets: {
            value: { percentage: (percentageValue / 100) },
            items: { all: true }
          }
        }
      };

    } else if (discount.type === 'free_shipping') {
      const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
      const fnResult = await autoActivateAsFunction(shop, accessToken, graphqlUrl, discount);
      if (fnResult) {
        discountsStore[id].shopify_discount_id = fnResult;
        discountsStore[id].activated = true;
        return res.json({ success: true, shopify_discount_id: fnResult, data: discountsStore[id] });
      }
      return res.status(400).json({ error: 'Free shipping requires the Shipping Function. Deploy gcw-shipping-function first via "shopify app deploy".' });
    } else {
      return res.status(400).json({ error: 'Unsupported discount type' });
    }

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    
    const graphqlResponse = await fetchWithTimeout(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query: mutation, variables })
    });

    const result = await graphqlResponse.json();

    if (!graphqlResponse.ok) {
      const errorMsg = result.errors?.[0]?.message || result.data?.discountAutomaticBasicCreate?.userErrors?.[0]?.message || 'Unknown Shopify API error';
      return res.status(graphqlResponse.status).json({ error: 'Shopify API error', details: errorMsg });
    }

    if (result.errors) {
      const errorMsg = result.errors[0]?.message || 'Unknown error';
      return res.status(400).json({ error: 'GraphQL error', details: errorMsg });
    }

    const shopifyDiscountId = result.data?.discountAutomaticBasicCreate?.automaticDiscountNode?.id;
    
    if (!shopifyDiscountId) {
      const userErrors = result.data?.discountAutomaticBasicCreate?.userErrors;
      const errorMsg = userErrors?.[0]?.message || 'Failed to create discount';
      return res.status(400).json({ error: 'Failed to create discount', details: errorMsg });
    }
    
    discountsStore[id].shopify_discount_id = shopifyDiscountId;
    discountsStore[id].activated = true;
    
    res.json({ success: true, shopify_discount_id: shopifyDiscountId, data: discountsStore[id] });
  } catch (error) {
    reportError(error, { area: 'discount_activate' });
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/discount/:id/activate-function', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const discount = discountsStore[id];
    console.log(`[ActivateFunction] POST /api/discount/${id}/activate-function`);
    
    if (!discount) {
      return res.status(404).json({ error: 'Discount not found' });
    }

    const { shop, accessToken } = await getOrExchangeToken(req);
    
    if (!shop) return res.status(401).json({ error: 'Missing shop parameter' });
    if (!accessToken) return res.status(401).json({ error: 'Missing Shopify access token. Send id_token header or install the app first.' });

    const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

    const callShopify = async (query, variables = {}) => {
      const response = await fetchWithTimeout(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({ query, variables })
      });
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch {
        return { ok: false, error: `Non-JSON response (HTTP ${response.status})`, result: null };
      }
      if (!response.ok || result.errors) {
        const errorMsg = result.errors?.[0]?.message || 'Shopify API error';
        return { ok: false, error: errorMsg, result };
      }
      return { ok: true, result };
    };

    const functionsResponse = await callShopify('{ shopifyFunctions(first: 50) { nodes { id apiType title } } }');
    if (!functionsResponse.ok) {
      return res.status(400).json({ error: 'Failed to load functions', details: functionsResponse.error });
    }

    const functions = functionsResponse.result.data?.shopifyFunctions?.nodes || [];

    const isDiscountFn = (fn) => fn.apiType === 'product_discounts' || fn.apiType === 'order_discounts' || fn.apiType === 'discount' || (fn.apiType && fn.apiType.toLowerCase().includes('discount'));
    const looksLikeGcw = (fn) => (fn.title && fn.title.toLowerCase().includes('discount')) || (fn.title && fn.title.toLowerCase().includes('gcw'));
    const isNotShipping = (fn) => !(fn.title || '').toLowerCase().includes('shipping');
    const isShippingFn = (fn) => (fn.title || '').toLowerCase().includes('shipping') && isDiscountFn(fn);

    const isShippingDiscount = discount.type === 'free_shipping';
    const discountFunction = isShippingDiscount
      ? (functions.find(fn => isShippingFn(fn)) || null)
      : (functions.find(fn => isDiscountFn(fn) && looksLikeGcw(fn) && isNotShipping(fn)) ||
         functions.find(fn => isDiscountFn(fn) && isNotShipping(fn)) ||
         functions.find(fn => looksLikeGcw(fn) && isNotShipping(fn)) ||
         (functions.length === 1 ? functions[0] : null));

    if (!discountFunction) {
      return res.status(400).json({
        error: isShippingDiscount
          ? 'Shipping function not found. Deploy gcw-shipping-function via "shopify app deploy" first.'
          : 'Discount function not found. Make sure it is deployed via "shopify app deploy".',
        details: `Found ${functions.length} functions but none matched.`,
      });
    }

    const title = discount.name || `Discount ${id}`;
    const startsAt = discount.start_date ? new Date(discount.start_date).toISOString() : new Date().toISOString();
    const endsAt = discount.end_date ? new Date(discount.end_date).toISOString() : null;

    let functionConfig, metafieldKey, discountClasses;
    if (isShippingDiscount) {
      metafieldKey = 'shipping_config';
      discountClasses = ['SHIPPING'];
      functionConfig = {
        threshold: discount.value || 50,
        message: discount.checkout_message || discount.cart_message || `Free shipping on orders over $${discount.value || 50}!`,
      };
    } else {
      metafieldKey = 'discount_config';
      discountClasses = ['PRODUCT'];
      functionConfig = {
        percentage: discount.value || 25,
        message: discount.checkout_message || discount.cart_message || `${discount.value}% Off!`,
        exclude_gift_cards: true,
        included_tags: discount.included_tags ? discount.included_tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        exclude_tags: discount.excluded_tags ? discount.excluded_tags.split(',').map(t => t.trim()).filter(Boolean) : [],
        exclude_product_types: discount.exclude_product_types ? discount.exclude_product_types.split(',').map(t => t.trim()).filter(Boolean) : [],
        exclude_vendors: discount.exclude_vendors ? discount.exclude_vendors.split(',').map(t => t.trim()).filter(Boolean) : [],
        exclude_product_ids: discount.exclude_product_ids || [],
      };
    }

    // Delete existing discounts with same title
    let allNodes = [];
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const afterClause = cursor ? `, after: "${cursor}"` : '';
      const searchResp = await callShopify(`query { discountNodes(first: 50${afterClause}) { nodes { id discount { ... on DiscountAutomaticApp { title } ... on DiscountAutomaticBasic { title } } } pageInfo { hasNextPage endCursor } } }`);
      if (!searchResp.ok) break;
      const nodes = searchResp.result.data?.discountNodes?.nodes || [];
      allNodes = allNodes.concat(nodes);
      const pageInfo = searchResp.result.data?.discountNodes?.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
    }
    const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const normalizedTitle = normalize(title);
    const existing = allNodes.filter(n => {
      const t = n.discount?.title;
      return t === title || normalize(t) === normalizedTitle;
    });
    for (const node of existing) {
      console.log(`[ActivateFunction] Deleting existing discount "${node.discount?.title}" (${node.id})`);
      await callShopify(`mutation discountAutomaticDelete($id: ID!) { discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field message } } }`, { id: node.id });
    }

    const createResponse = await callShopify(`
      mutation discountAutomaticAppCreate($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount { discountId title status appDiscountType { appKey functionId } }
          userErrors { field message }
        }
      }
    `, {
      automaticAppDiscount: {
        title,
        functionId: discountFunction.id,
        startsAt, endsAt, discountClasses,
        combinesWith: {
          orderDiscounts: !!discount.combines_with_order,
          productDiscounts: !!discount.combines_with_product,
          shippingDiscounts: !!discount.combines_with_shipping
        },
        metafields: [{ namespace: 'gcw', key: metafieldKey, type: 'json', value: JSON.stringify(functionConfig) }],
      }
    });

    if (!createResponse.ok) {
      return res.status(400).json({ error: 'Shopify API error', details: createResponse.error });
    }

    const createData = createResponse.result.data?.discountAutomaticAppCreate;
    if (createData?.userErrors?.length) {
      const errMsg = createData.userErrors.map(e => `${e.field ? e.field + ': ' : ''}${e.message}`).join('; ');
      return res.status(400).json({ error: errMsg, details: errMsg });
    }

    const shopifyDiscountId = createData?.automaticAppDiscount?.discountId || null;
    if (!shopifyDiscountId) {
      return res.status(400).json({ error: 'Failed to create function discount' });
    }

    discountsStore[id].shopify_discount_id = shopifyDiscountId;
    discountsStore[id].activated = true;
    discountsStore[id].function_id = discountFunction.id;

    res.json({
      success: true,
      shopify_discount_id: shopifyDiscountId,
      function_id: discountFunction.id,
      function_api_type: discountFunction.apiType,
      shop,
      data: discountsStore[id]
    });
  } catch (error) {
    reportError(error, { area: 'discount_activate_function' });
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/discount/:id/load', requireViewer, (req, res) => {
  try {
    const { id } = req.params;
    const discount = discountsStore[id];
    if (!discount) return res.status(404).json({ error: 'Discount not found' });
    res.json({ success: true, data: discount });
  } catch (error) {
    reportError(error, { area: 'discount_load' });
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/discount/:id/toggle-pause', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const discount = discountsStore[id];
    if (!discount) return res.status(404).json({ error: 'Discount not found' });
    discount.paused = !discount.paused;
    res.json({ success: true, data: discount });
  } catch (error) {
    reportError(error, { area: 'discount_toggle_pause' });
    res.status(500).json({ error: error.message });
  }
});

router.delete('/api/discount/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const discount = discountsStore[id];
    if (!discount) return res.status(404).json({ error: 'Discount not found' });

    let shopifyRemoved = false;
    if (discount.shopify_discount_id) {
      try {
        const { shop, accessToken } = await getOrExchangeToken(req);
        if (shop && accessToken) {
          const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
          const delResp = await fetchWithTimeout(graphqlUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
            body: JSON.stringify({
              query: `mutation discountDelete($id: ID!) { discountAutomaticDelete(id: $id) { deletedAutomaticDiscountId userErrors { field message } } }`,
              variables: { id: discount.shopify_discount_id }
            })
          });
          const delResult = await delResp.json();
          const userErrors = delResult.data?.discountAutomaticDelete?.userErrors || [];
          if (!userErrors.length) shopifyRemoved = true;
        }
      } catch (shopifyErr) {
        console.warn(`[Delete] Failed to remove from Shopify:`, shopifyErr.message);
      }
    }

    const deletedName = discount.name;
    delete discountsStore[id];
    console.log(`[Delete] Campaign "${deletedName}" (${id}) permanently deleted`);
    res.json({ success: true, message: 'Campaign deleted', name: deletedName, shopifyRemoved });
  } catch (error) {
    reportError(error, { area: 'discount_delete' });
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/discount/:id/archive', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const discount = discountsStore[id];
    if (!discount) return res.status(404).json({ error: 'Discount not found' });
    if (discount.archived) return res.json({ success: true, data: discount, message: 'Already archived' });
    discount.archived = true;
    discount.archivedAt = new Date().toISOString();
    console.log(`[Archive] Campaign "${discount.name}" (${id}) archived`);
    res.json({ success: true, data: discount });
  } catch (error) {
    reportError(error, { area: 'discount_archive' });
    res.status(500).json({ error: error.message });
  }
});

router.put('/api/discount/:id/unarchive', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const discount = discountsStore[id];
    if (!discount) return res.status(404).json({ error: 'Discount not found' });
    if (!discount.archived) return res.json({ success: true, data: discount, message: 'Already active' });
    discount.archived = false;
    delete discount.archivedAt;
    console.log(`[Unarchive] Campaign "${discount.name}" (${id}) restored`);
    res.json({ success: true, data: discount });
  } catch (error) {
    reportError(error, { area: 'discount_unarchive' });
    res.status(500).json({ error: error.message });
  }
});

router.get('/api/discounts', requireViewer, (req, res) => {
  try {
    const includeArchived = req.query.include_archived === 'true';
    const all = Object.values(discountsStore);
    const data = includeArchived ? all : all.filter(d => !d.archived);
    res.json({ success: true, data });
  } catch (error) {
    reportError(error, { area: 'discounts_list' });
    res.status(500).json({ error: error.message });
  }
});

router.post('/api/discount/create', requireBuilder, async (req, res) => {
  try {
    const { settings, activateNow } = req.body;
    const slug = (settings.name || 'discount')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 20);
    const newId = slug + '-' + Date.now().toString(36);
    
    discountsStore[newId] = { id: newId, ...settings, activated: false };
    console.log(`[Create] New discount: ${newId} (${settings.name})`);

    if (activateNow) {
      const shop = req.query.shop || req.body.shop || DEFAULT_SHOP;
      const { accessToken } = await getOrExchangeToken(req);
      if (accessToken) {
        const graphqlUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
        const fnResult = await autoActivateAsFunction(shop, accessToken, graphqlUrl, discountsStore[newId]);
        if (!fnResult) {
          await autoActivateAsBasic(shop, accessToken, graphqlUrl, discountsStore[newId]);
        }
      }
    }
    
    res.json({ success: true, data: discountsStore[newId] });
  } catch (error) {
    reportError(error, { area: 'discount_create' });
    res.status(500).json({ error: error.message });
  }
});

export default router;
