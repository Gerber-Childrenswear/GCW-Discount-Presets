import crypto from 'crypto';

export function verifyHmac(query) {
  try {
    const { hmac, signature, ...params } = query;
    if (!hmac) { console.error('[HMAC] No hmac parameter in query'); return false; }
    const sortedKeys = Object.keys(params).sort();
    const message = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
    const generated = crypto.createHmac('sha256', process.env.SHOPIFY_API_SECRET)
      .update(message).digest('hex');
    if (generated.length !== hmac.length) {
      console.error('[HMAC] Length mismatch');
      return false;
    }
    const match = crypto.timingSafeEqual(Buffer.from(generated), Buffer.from(hmac));
    if (!match) console.warn('[HMAC] Verification failed');
    return match;
  } catch (err) {
    console.error('[HMAC] Verification error:', err.message);
    return false;
  }
}
