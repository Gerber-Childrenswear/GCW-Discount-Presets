import { Router } from 'express';
import crypto from 'crypto';
import { appUrl, SHOPIFY_SCOPES } from '../config.js';
import { shopSessions, persistSessions, setRuntimeAccessToken } from '../session-store.js';
import { verifyHmac, redactForLogs } from '../security.js';
import { reportError } from '../error-logger.js';
import { setAuthCookie, isAuthenticated } from '../rbac.js';

const router = Router();

async function persistAccessTokenToRender(shop, accessToken) {
  const apiKey = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !serviceId || !accessToken) return false;

  const prodShop = process.env.SHOPIFY_PROD_SHOP_DOMAIN;
  const envVars = prodShop && shop === prodShop
    ? [
        { key: 'SHOPIFY_PROD_ACCESS_TOKEN', value: accessToken },
        { key: 'SHOPIFY_PROD_SHOP_DOMAIN', value: shop },
      ]
    : [{ key: 'SHOPIFY_ACCESS_TOKEN', value: accessToken }];

  try {
    const response = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(envVars),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error('[OAuth] Render env sync failed:', response.status, redactForLogs(text).slice(0, 200));
      return false;
    }
    console.log(`[OAuth] Access token synced to Render for ${shop} (value not logged)`);
    return true;
  } catch (error) {
    console.error('[OAuth] Render env sync error:', error.message);
    return false;
  }
}

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
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${process.env.SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${nonce}`;

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
    // Delete nonce BEFORE token exchange to prevent replay attacks during the exchange window
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
      console.error('[OAuth] Token exchange failed:', redactForLogs(tokenData));
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
    const syncedToRender = await persistAccessTokenToRender(shop, tokenData.access_token);
    if (!syncedToRender) {
      console.log(
        `[OAuth] Token stored in server session only. Set SHOPIFY_PROD_ACCESS_TOKEN in Render dashboard to persist across restarts (never paste tokens into logs or chat).`,
      );
    }

    setRuntimeAccessToken(tokenData.access_token);

    res.redirect(`/?shop=${shop}`);
  } catch (error) {
    console.error('[OAuth] Callback error:', error);
    reportError(error, { area: 'oauth_callback' });
    res.status(500).send('OAuth callback error: ' + error.message);
  }
});

router.get('/api/auth/github', (req, res) => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId || !process.env.SESSION_ENCRYPTION_KEY) {
    return res.status(503).send('GitHub authentication is not configured.');
  }
  const state = crypto.randomUUID();
  shopSessions.githubOAuthState = state;
  persistSessions();
  const redirectUri = `${appUrl}/api/auth/github/callback`;
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`);
});

router.get('/api/auth/github/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== shopSessions.githubOAuthState) {
    return res.status(403).send('Invalid GitHub authentication request.');
  }
  delete shopSessions.githubOAuthState;
  persistSessions();
  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
        client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error('GitHub token exchange failed');
    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: 'Bearer ' + tokenData.access_token,
        Accept: 'application/vnd.github+json',
      },
    });
    const user = await userResponse.json();
    if (!userResponse.ok || user.login !== 'ncassidy233') {
      return res.status(403).send('This GitHub account is not authorized.');
    }
    setAuthCookie(res, user.login);
    return res.redirect('/');
  } catch (error) {
    reportError(error, { area: 'github_oauth_callback' });
    return res.status(502).send('GitHub authentication failed.');
  }
});

// Check auth status
router.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

// Logout
router.post('/api/auth/logout', (req, res) => {
  res.clearCookie('gcw_auth', { httpOnly: true, secure: true, sameSite: 'none', path: '/' });
  res.json({ success: true });
});

export default router;
