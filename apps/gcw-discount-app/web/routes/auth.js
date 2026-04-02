import { Router } from 'express';
import crypto from 'crypto';
import { appUrl } from '../config.js';
import { shopSessions, persistSessions, setRuntimeAccessToken } from '../session-store.js';
import { verifyHmac } from '../security.js';
import { reportError } from '../error-logger.js';

const router = Router();

// Step 1: Begin OAuth
router.get('/api/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('Missing ?shop parameter');

  if (!/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop)) {
    return res.status(400).send('Invalid shop parameter');
  }

  const nonce = crypto.randomUUID();
  shopSessions[`nonce_${shop}`] = nonce;
  persistSessions();

  const redirectUri = `${appUrl}/api/auth/callback`;
  const scopes = 'write_discounts,read_discounts';
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${nonce}`;

  console.log(`[OAuth] Redirecting ${shop} to Shopify authorization`);
  res.redirect(authUrl);
});

// Step 2: OAuth callback
router.get('/api/auth/callback', async (req, res) => {
  try {
    const { code, shop, state } = req.query;
    console.log(`[OAuth Callback] Received: shop=${shop}, code=${code ? 'present' : 'missing'}, state=${state}, query keys=[${Object.keys(req.query).join(',')}]`);

    if (!code || !shop) {
      return res.status(400).send('Missing code or shop in callback');
    }

    if (!/^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$/.test(shop)) {
      return res.status(400).send('Invalid shop parameter');
    }

    const hmacValid = verifyHmac(req.query);
    if (!hmacValid) {
      console.error('[OAuth] HMAC validation failed for', shop);
      return res.status(403).send('HMAC validation failed. This request may have been tampered with.');
    }

    const expectedNonce = shopSessions[`nonce_${shop}`];
    if (!expectedNonce) {
      console.error(`[OAuth] No stored nonce for ${shop} — rejecting (server may have restarted)`);
      return res.status(403).send('Session expired (server restarted). Please <a href="/api/auth?shop=' + encodeURIComponent(shop) + '">retry the install</a>.');
    }
    if (state !== expectedNonce) {
      console.error(`[OAuth] Nonce mismatch for ${shop}: expected=${expectedNonce}, got=${state}`);
      return res.status(403).send('Session state mismatch (CSRF protection). Please retry the install.');
    }
    console.log(`[OAuth] Nonce verified for ${shop}`);
    delete shopSessions[`nonce_${shop}`];
    persistSessions();

    const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error('[OAuth] Token exchange failed:', tokenData);
      return res.status(500).send('Failed to obtain access token from Shopify');
    }

    shopSessions[shop] = {
      accessToken: tokenData.access_token,
      scope: tokenData.scope,
      shop,
      installedAt: new Date().toISOString(),
    };
    persistSessions();

    console.log(`[OAuth] Access token obtained for ${shop} (scope: ${tokenData.scope})`);
    console.log(`[OAuth] ^^^ Save to Render env vars to persist across restarts:`);
    console.log(`[OAuth]     For dev store:  SHOPIFY_ACCESS_TOKEN=${tokenData.access_token}`);
    console.log(`[OAuth]     For prod store: SHOPIFY_PROD_ACCESS_TOKEN=${tokenData.access_token}`);
    console.log(`[OAuth]                     SHOPIFY_PROD_SHOP_DOMAIN=${shop}`);

    setRuntimeAccessToken(tokenData.access_token);

    res.redirect(`/?shop=${shop}`);
  } catch (error) {
    console.error('[OAuth] Callback error:', error);
    reportError(error, { area: 'oauth_callback' });
    res.status(500).send('OAuth callback error: ' + error.message);
  }
});

export default router;
