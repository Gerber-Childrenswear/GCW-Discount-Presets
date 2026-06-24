const GQL_TIMEOUT_MS = 15000; // 15 second timeout for GraphQL calls

export function makeGqlClient(graphqlUrl, accessToken) {
  return async (query, variables = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GQL_TIMEOUT_MS);
    try {
      const response = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch {
        return { ok: false, error: `Non-JSON (HTTP ${response.status})` };
      }
      if (result.errors) {
        const msg = typeof result.errors === 'string'
          ? result.errors
          : (result.errors[0]?.message || result.errors[0]?.extensions?.code || JSON.stringify(result.errors[0]) || 'Shopify API error');
        console.error('[GQL] Shopify returned errors:', JSON.stringify(result.errors).substring(0, 500));
        return { ok: false, error: msg, result };
      }
      return { ok: true, result };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return { ok: false, error: `Shopify GraphQL timeout after ${GQL_TIMEOUT_MS / 1000}s` };
      }
      return { ok: false, error: err.message || 'Network error' };
    }
  };
}
