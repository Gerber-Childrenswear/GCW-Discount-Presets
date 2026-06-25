import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

export const PORT = process.env.PORT || 8081;
export const SHOPIFY_API_VERSION = '2025-07';
export const SHOPIFY_SCOPES =
  process.env.SHOPIFY_APP_SCOPES ||
  'read_discounts,write_discounts,read_orders,read_products';

export const appUrl = process.env.SHOPIFY_APP_URL || `http://localhost:${PORT}`;
export const hostName = appUrl.replace(/^https?:\/\//, '');
export const hostScheme = appUrl.startsWith('https') ? 'https' : 'http';

if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
  throw new Error('SHOPIFY_API_KEY and SHOPIFY_API_SECRET environment variables are required');
}

console.log('[Shopify App Config]', {
  appUrl,
  hostName,
  hostScheme,
  apiKey: process.env.SHOPIFY_API_KEY.substring(0, 8) + '...',
  apiSecret: '[redacted]',
  scopes: SHOPIFY_SCOPES,
  callbackUrl: `${hostScheme}://${hostName}/api/auth/callback`,
});

export const DEFAULT_SHOP = process.env.SHOPIFY_SHOP_DOMAIN || 'gcw-dev.myshopify.com';
