export function makeGqlClient(graphqlUrl, accessToken) {
  return async (query, variables = {}) => {
    const response = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
      body: JSON.stringify({ query, variables }),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch {
      return { ok: false, error: `Non-JSON (HTTP ${response.status})` };
    }
    if (result.errors) return { ok: false, error: result.errors[0]?.message || 'GraphQL error', result };
    return { ok: true, result };
  };
}
