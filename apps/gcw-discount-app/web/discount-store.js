import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, '..', '.discount-registry.json');

// In-memory discount data store (legacy — campaign presets removed;
// all discounts are now deployed via the Function Builder / Shipping Function tabs
// and stored in Shopify). Kept for backwards compatibility with auto-activate logic.
export const discountsStore = {};

// ─── Discount GID Registry ──────────────────────────────────────────────────
// Persists Shopify discount GIDs so list-all can fetch them by ID (fast)
// instead of scanning all 5000+ discount nodes (slow, unreliable).

let registry = { discounts: [] };

function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
      if (!Array.isArray(registry.discounts)) registry.discounts = [];
      console.log(`[Registry] Loaded ${registry.discounts.length} discount GID(s)`);
    }
  } catch (err) {
    console.error('[Registry] Failed to load:', err.message);
    registry = { discounts: [] };
  }
}

function saveRegistry() {
  try {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
  } catch (err) {
    console.error('[Registry] Failed to save:', err.message);
  }
}

loadRegistry();

export function registerDiscount(gid, shop, source) {
  if (!gid) return;
  if (registry.discounts.some(d => d.gid === gid)) return;
  registry.discounts.push({ gid, shop, source, createdAt: new Date().toISOString() });
  saveRegistry();
  console.log(`[Registry] Registered ${source} discount: ${gid}`);
}

export function unregisterDiscount(gid) {
  const before = registry.discounts.length;
  registry.discounts = registry.discounts.filter(d => d.gid !== gid);
  if (registry.discounts.length < before) {
    saveRegistry();
    console.log(`[Registry] Unregistered discount: ${gid}`);
  }
}

export function getRegisteredGids(shop) {
  if (!shop) return registry.discounts.map(d => d.gid);
  return registry.discounts.filter(d => d.shop === shop).map(d => d.gid);
}
