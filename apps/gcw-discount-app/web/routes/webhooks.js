import { Router } from 'express';
import crypto from 'crypto';

const router = Router();

/** Verify Shopify webhook HMAC. Returns true if valid, sends 401 and returns false otherwise. */
function verifyWebhookHmac(req, res) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !process.env.SHOPIFY_API_SECRET) {
    console.warn('[Webhook] Missing HMAC or API secret — rejecting');
    res.status(401).send('Unauthorized');
    return false;
  }
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const computed = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET)
    .update(rawBody).digest('base64');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmac))) {
      console.warn('[Webhook] HMAC mismatch — rejecting');
      res.status(401).send('Unauthorized');
      return false;
    }
  } catch {
    console.warn('[Webhook] HMAC verification failed — rejecting');
    res.status(401).send('Unauthorized');
    return false;
  }
  return true;
}

router.post('/api/webhooks', (req, res) => {
  if (!verifyWebhookHmac(req, res)) return;
  const topic = req.headers['x-shopify-topic'];
  console.log(`[Webhook] Verified: ${topic}`);
  res.status(200).send('OK');
});

// Handle orders/create and orders/updated webhooks registered in shopify.app.toml
router.post('/api/webhooks/orders', (req, res) => {
  if (!verifyWebhookHmac(req, res)) return;
  const topic = req.headers['x-shopify-topic'];
  const orderId = req.body?.id || req.body?.admin_graphql_api_id || 'unknown';
  console.log(`[Webhook][Orders] ${topic} — order ${orderId}`);
  // Acknowledge immediately so Shopify doesn't retry
  res.status(200).send('OK');
});

export default router;
