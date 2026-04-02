# Custom App Setup for gcw-dev Store

## Steps:

1. Go to: https://gcw-dev.myshopify.com/admin/settings/apps/development
2. Click **"Create an app"**
3. Name it: "GCW Discount Manager"
4. Set scopes:
   - `read_discounts`
   - `write_discounts`
   - `read_products`
   - `write_products`
5. Click **"Install app"**
6. Copy the **Admin API access token**

## Update your .env file:

```
SHOPIFY_API_KEY=<from custom app>
SHOPIFY_API_SECRET=<from custom app>  
SHOPIFY_ACCESS_TOKEN=<admin api token>
SHOP=gcw-dev.myshopify.com
PORT=3000
```

## Update shopify.app.gcw-discount-functions.toml:

Change `client_id` to the API key from your custom app.

## Start your server:

```powershell
cd C:\Users\NCassidy\Downloads\gerberchildrenswear-ncassidy-staging-main\apps\gcw-discount-app
node server-simple.js
```

This bypasses the Partners organization entirely and runs directly on your store.
