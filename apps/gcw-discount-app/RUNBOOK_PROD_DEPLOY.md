# GCW Prod Deploy Runbook (Other Desktop)

Use this when ThreatLocker blocks Rust build on your current machine.

## Repo + branch
- Repo: `Gerber-Childrenswear/GCW-Discount-Presets`
- Remote in this repo: `discount-prod`
- Branch: `main`
- Must include commits:
  - `6fe1fd0` (token exchange fix)
  - `457cc3b` (tag exclusion update)

## File to run
- `apps/gcw-discount-app/scripts/deploy-prod-from-other-desktop.cmd`

## Commands
```bat
cd /d C:\Users\NCassidy\Downloads\GCW-Discount-Presets
git fetch discount-prod main
git checkout main
git pull discount-prod main

apps\gcw-discount-app\scripts\deploy-prod-from-other-desktop.cmd
```

## Render env keys that must be present
- `SHOPIFY_API_KEY` (must match current Shopify app client ID)
- `SHOPIFY_API_SECRET` (must match current Shopify app client secret)
- `SHOPIFY_APP_URL=https://gcw-dev.onrender.com`
- `SHOPIFY_SHOP_DOMAIN=gerberchildrenswear.myshopify.com`
- `SHOPIFY_PROD_SHOP_DOMAIN=gerberchildrenswear.myshopify.com`
- `SHOPIFY_ACCESS_TOKEN` (working prod token)
- `SHOPIFY_PROD_ACCESS_TOKEN` (same working prod token)
- `SESSION_ENCRYPTION_KEY`
- `GCW_ADMIN_EMAILS`
- `NODE_ENV=production`

## Verify after deploy
1. Open app: `https://admin.shopify.com/store/gerberchildrenswear/apps/gcw-discount-presets`
2. In Function Builder, excluded tags: `no discount,no discount:strict`.
3. Run simulation and confirm excluded products are excluded.
4. Deploy function discount.
