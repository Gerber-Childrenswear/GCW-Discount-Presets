# AGENTS.md

## Cursor Cloud specific instructions

This repo holds the **GCW Discount Presets** Shopify app: an Express admin/API
server (`apps/gcw-discount-app/web/`) plus four Rust→WASM Shopify Functions
(`apps/gcw-discount-app/extensions/gcw-*`). See
`apps/gcw-discount-app/README.md`, `SETUP.md`, and `QUICKSTART.md` for product
and architecture details.

### Express server

- Run: `cd apps/gcw-discount-app/web && node index.js` (or `npm run dev` for
  nodemon). Listens on `PORT` (default `8081`).
- It **requires** `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` or it throws at
  startup (see `web/config.js`). For local boot these can be dummy values; create
  `apps/gcw-discount-app/.env` (gitignored) from `apps/gcw-discount-app/.env.example`.
- Auth is **password-based**, not OAuth-gated for API calls: send header
  `x-gcw-password: <GCW_APP_PASSWORD>` (default `Sugi2.0` when the env var is
  unset). `GET /` redirects to Shopify OAuth, but `GET /health` and
  authenticated APIs like `GET /api/diagnostics` work without a real store.
- Endpoints that fetch live store data (e.g. `POST /api/discount-simulator/simulate`,
  product/discount listing) need a real Shopify access token and will return
  401/empty without OAuth credentials.

### Rust / WASM Shopify Functions

- Requires Rust **≥ 1.85** (a transitive dep needs the `edition2024` Cargo
  feature). Use the latest stable toolchain plus the `wasm32-unknown-unknown`
  target.
- Tests (run on the host target): in each `extensions/gcw-*` dir run
  `cargo test --lib` (the app `package.json` `test` script only runs the first
  function).
- Production build: `cargo build --release --target wasm32-unknown-unknown`.
- Note: `target/` (including the release `.wasm`) is committed to the repo by CI.
  Rebuilding locally will show those artifacts as modified — do not commit those
  artifact changes.

### Node tests

- `node tests/shipping-progress-config.mjs` and
  `node tests/shipping-progress-config-v2.mjs` exercise the shipping-progress
  config logic with no external dependencies.

### Out of scope locally

- `shopify app dev` / `shopify app deploy` require Shopify Partners auth and a
  connected dev store.
