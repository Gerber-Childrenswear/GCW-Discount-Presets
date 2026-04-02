# Production Deployment Guide

## Deploy to Railway.app (Recommended)

### Step 1: Create Railway Account
1. Go to [railway.app](https://railway.app)
2. Sign up (use GitHub for fastest setup)
3. Create a new project

### Step 2: Deploy from GitHub
1. In Railway, click "New Project" → "Deploy from GitHub"
2. Select your `gerberchildrenswear` repository
3. Railway will auto-detect the Procfile and deploy

**OR** Deploy via Railway CLI:
```powershell
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Link project
cd C:\Users\NCassidy\Downloads\gerberchildrenswear-ncassidy-staging-main\apps\gcw-discount-app
railway link

# Deploy
railway up
```

### Step 3: Set Environment Variables in Railway
In the Railway dashboard:
1. Go to your project
2. Click "Variables"
3. Add these from your `.env` file:
   - `SHOPIFY_API_KEY=YOUR_API_KEY_HERE`
   - `SHOPIFY_API_SECRET=YOUR_API_SECRET_HERE`
   - `SHOPIFY_ACCESS_TOKEN=YOUR_ACCESS_TOKEN_HERE`
   - `SHOPIFY_APP_SCOPES=write_discounts,read_discounts,write_functions,read_functions`
   - `PORT=8081` (Railway will override this, but set it for clarity)
   - `LOG_LEVEL=info`

### Step 4: Get Your Production URL
1. Railway will assign a domain like: `gcw-discount-prod-production.up.railway.app`
2. Copy this URL

### Step 5: Update Shopify App
1. In `shopify.theme.toml`, update:
```toml
scopes = "write_discounts,read_discounts,write_functions,read_functions"
```

2. In the Shopify admin for gcw-dev, update the app URL to your Railway domain

3. (Optional) Update the `.env` file:
```
SHOPIFY_APP_URL=https://your-railway-domain.up.railway.app
```

### Step 6: Deploy to Shopify
```powershell
cd apps\gcw-discount-app
shopify app deploy --force
```

## That's It!
Your discount manager will now run permanently on Railway's servers. No more localhost needed.

### Troubleshooting
- Check logs in Railway dashboard: "Deployments" → Select deployment → View logs
- If env vars missing: Railway → Variables tab
- If build fails: Check `package.json` scripts exist
