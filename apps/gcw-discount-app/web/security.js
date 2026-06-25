import crypto from 'crypto';

/** Strip access tokens from objects/strings before logging. */
export function redactForLogs(value) {
  if (value == null) return value;
  if (typeof value === 'string') {
    return value
      .replace(/\bshp(at|pa|ca|ss)_[A-Za-z0-9]+\b/g, 'shp$1_[REDACTED]')
      .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"');
  }
  if (Array.isArray(value)) return value.map(redactForLogs);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'access_token' || k === 'accessToken') {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactForLogs(v);
      }
    }
    return out;
  }
  return value;
}

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
