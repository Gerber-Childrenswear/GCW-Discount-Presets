# GCW Discount Presets — Shopify Functions App

> **App name:** GCW Discount Presets  
> **Client ID:** `0b2fb6e18c009c93349bfcd6636be0cd`  
> **API version:** `2025-07`  
> **Runtime:** Node ≥ 22 (ESM) + Rust/WASM (Shopify Functions)  
> **Hosting:** Render (auto-deploy on push to `main`)  
> **Repository:** `Gerber-Childrenswear/gcw-dev`

---

## Architecture

```
apps/gcw-discount-app/
├── extensions/
│   ├── gcw-discount-function/   # Percentage-off with tag/vendor/product filters
│   ├── gcw-tiered-discount/     # Tiered discount by subtotal or quantity
│   ├── gcw-bxgy-discount/       # Buy X Get Y at N% off
│   ├── gcw-shipping-function/   # Free shipping above threshold
│   └── checkout-message/        # Checkout UI extension (React)
├── web/
│   └── index.js                 # Express server — dashboard, API, OAuth, webhooks
├── shopify.app.toml             # App config (scopes, API version)
├── Procfile                     # Render entrypoint: cd web && npm start
└── package.json
```

### Shopify Functions (Rust → WASM)

| Function | Trigger | Metafield | WASM Size | Tests |
|---|---|---|---|---|
| `gcw-discount-function` | `cart.lines.discounts.generate.run` | `gcw/discount_config` | 184 KB | 14 |
| `gcw-tiered-discount` | `cart.lines.discounts.generate.run` | `gcw/tiered_config` | 187 KB | 14 |
| `gcw-bxgy-discount` | `cart.lines.discounts.generate.run` | `gcw/bxgy_config` | 204 KB | 13 |
| `gcw-shipping-function` | `cart.delivery-options.discounts.generate.run` | `gcw/shipping_config` | 160 KB | 10 |

All functions:
- Rust crate type `cdylib`, target `wasm32-unknown-unknown`
- `shopify_function = "2.0.3"`, `serde`, `serde_json`
- Config read from discount node metafield (JSON); falls back to sensible defaults
- Gift card exclusion: `isGiftCard` flag + product-type heuristic ("gift card" / "giftcard")
- Percentage values clamped to 0–100

### Web Server (`web/index.js`)

Single-file Express server (~7,200 lines) with embedded HTML/CSS/JS dashboard:
- **OAuth:** Shopify session token exchange via `exchangeToken()`
- **RBAC:** `requireAdmin` / `requireViewer` middleware (email-based roles)
- **48 API routes:** CRUD for all 4 function types + status/health/logs
- **Input validation:** Title ≤ 255 chars, tiers ≤ 20, quantities ≤ 1000, `Number.isFinite()` checks

---

## CI/CD Pipeline

### GitHub Actions (`.github/workflows/build-and-deploy-function.yml`)

Triggers on push to `main` when any `extensions/*/src/**`, `*.graphql`, `Cargo.*` changes.

**Single job pipeline:**
1. `cargo fmt` — auto-formats all 4 functions (commits fixes)
2. `cargo clippy --lib --target wasm32-unknown-unknown -- -D warnings`
3. `cargo test --lib` — runs 51 unit tests
4. `cargo build --release --target wasm32-unknown-unknown` — builds 4 WASM binaries
5. Auto-commits WASM + fmt fixes with `[skip ci]`

Can also be triggered manually via `workflow_dispatch`.

### Render

Auto-deploys the Express server on every push to `main`.  
Entry point: `Procfile` → `cd web && npm start`

### Shopify Deploy (Manual)

WASM binaries are committed to the repo by CI. To deploy functions to Shopify:

```bash
git pull origin main                          # Get CI-built WASM
cd apps/gcw-discount-app
shopify auth login                            # Authenticate to Partners org
npx shopify app deploy --force
```

Or use: `deploy-function.bat`

---

## Local Development

### Prerequisites

- Node.js ≥ 22
- Rust stable + `wasm32-unknown-unknown` target
- Shopify CLI (`npm install -g @shopify/cli`)

### Setup

```bash
cd apps/gcw-discount-app
cp .env.example .env                          # Fill in real credentials
npm install
cd web && npm install && cd ..
```

### Running

```bash
# Full Shopify dev mode (connects to store)
shopify app dev

# Server only (needs env vars)
cd web && npm start
```

### Running Tests (CI)

Tests run in GitHub Actions because ThreatLocker blocks `cargo` build scripts locally.
Push to `main` or use `gh workflow run "Build Shopify Functions (WASM)"`.

To run tests if cargo is unblocked locally:
```bash
cd extensions/gcw-discount-function && cargo test --lib
cd extensions/gcw-tiered-discount && cargo test --lib
cd extensions/gcw-bxgy-discount && cargo test --lib
cd extensions/gcw-shipping-function && cargo test --lib
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SHOPIFY_API_KEY` | Yes | App client ID |
| `SHOPIFY_API_SECRET` | Yes | App client secret |
| `HOST` | Yes | Public URL (e.g., `https://gcw-dev.onrender.com`) |
| `PORT` | No | Server port (default: `8081`) |
| `SCOPES` | Yes | OAuth scopes |
| `ADMIN_EMAILS` | No | Comma-separated admin email addresses |

See `.env.example` for the full template.

---

## Configuration (Metafield JSON)

### gcw-discount-function (`gcw/discount_config`)
```json
{
  "percentage": 25,
  "exclude_gift_cards": true,
  "included_tags": ["sale", "discount"],
  "exclude_tags": ["clearance"],
  "included_vendors": ["Gerber"],
  "exclude_vendors": [],
  "exclude_product_ids": [],
  "message": "25% Off Applied!"
}
```

### gcw-tiered-discount (`gcw/tiered_config`)
```json
{
  "mode": "subtotal",
  "tiers": [
    { "min_value": 50, "percentage": 10 },
    { "min_value": 100, "percentage": 15, "message": "Big savings!" },
    { "min_value": 150, "percentage": 20 }
  ],
  "exclude_gift_cards": true,
  "message": "Tiered discount applied!"
}
```
`mode` can be `"subtotal"` (dollars) or `"quantity"` (item count).

### gcw-bxgy-discount (`gcw/bxgy_config`)
```json
{
  "buy_quantity": 2,
  "get_quantity": 1,
  "get_percentage": 100,
  "qualifying_tags": ["bxgy"],
  "discount_cheapest": true,
  "exclude_gift_cards": true,
  "message": "Buy 2 Get 1 Free!"
}
```
`discount_cheapest: true` discounts the cheapest item; `false` discounts the most expensive.

### gcw-shipping-function (`gcw/shipping_config`)
```json
{
  "threshold": 50,
  "message": "Free shipping on orders over $50!"
}
```
Threshold is clamped to $10–$100.

---

## Security Notes

### Completed (this audit)
- [x] SSH private keys removed from repo + added to `.gitignore`
- [x] Real API secret removed from `.env.example` (replaced with placeholder)
- [x] Access token no longer logged to stdout in `exchangeToken()`
- [x] Auth middleware added to all list endpoints
- [x] OAuth scopes narrowed to `read_discounts,write_discounts`
- [x] Input validation on all write endpoints

### ⚠️ Action Required (before production)
- **Rotate the Shopify API secret** — the old one was committed to git history
- **Rotate the SSH keys** — Ed25519 keys for `ncassidy233@gerberchildrenswear` were in repo history
- **Review Render environment variables** — ensure they use the rotated secret
- **Consider `git filter-branch` or BFG** to scrub secrets from git history

---

## Test Coverage (51 tests)

| Function | Tests | Key Scenarios |
|---|---|---|
| gcw-discount-function | 14 | Empty cart, basic discount, gift card exclusion (flag + heuristic), tag/vendor filters, zero %, missing metafield, % clamped, excluded product ID, CSV legacy tags |
| gcw-tiered-discount | 14 | Empty cart/tiers, below/at/above tier boundaries, quantity mode (single + multi-line), gift card exclusion, defaults, zero/clamped %, custom message |
| gcw-bxgy-discount | 13 | Empty cart, insufficient items, exact match, multiple sets, qualifying tags, cheapest vs expensive targeting, gift card exclusion, defaults, partial/zero % |
| gcw-shipping-function | 10 | Empty groups, below/at/above threshold, defaults, custom message, threshold clamped low/high, multiple delivery groups |

---

## Audit Changelog (2025)

| Commit | Description |
|---|---|
| `79cbc7f` | Security: remove SSH keys, sanitize `.env.example`, stop logging tokens |
| `5b041ae` | Cleanup: remove dead code (`gcw-most-expensive-discount/`, `server-simple.js`, patch files) |
| `13f4a9e` | Fix: `.gitignore` un-ignore rules for tiered + BXGY WASM |
| `9fdd5e7` | Harden: API version `2025-07`, input validation, auth on list endpoints |
| `108df6e` | Fix: replace expired Cloudflare tunnel URL with Render production URL |
| `f73723f`–`0168d1e` | Tests: 51 unit tests for all 4 functions + CI quality gate |
| `7010fee` | CI: auto-formatted Rust code + rebuilt WASM binaries |
