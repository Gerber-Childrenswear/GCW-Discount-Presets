# GCW Discount Manager - Deployment Guide

Complete guide for building, testing, and deploying the Admin UI Extension to Shopify development and production environments.

## Overview

The Admin UI Extension is deployed as part of the `gcw-discount-app` Shopify app. Deployment involves:
1. Building the React extension
2. Deploying via Shopify CLI
3. Configuring production environment
4. Monitoring with Sentry

## Prerequisites

- Node.js 18+ installed
- Shopify CLI 3.0+ installed
- Access to the Shopify Partner account
- Valid Shopify app credentials
- Valid Sentry account (for error tracking)

## Build Process

### Local Development

```bash
cd apps/gcw-discount-app/extensions/admin-ui

# Install dependencies
npm install

# Start development server
npm run dev

# Open http://localhost:3000 to view
```

### Production Build

```bash
# Build for production (minified, optimized)
npm run build

# Preview the production build locally
npm run preview

# Type checking
npm run type-check

# Linting
npm run lint
```

### Build Artifacts

After running `npm run build`, the following files are generated in the `dist/` directory:

- `dist/index.html` - HTML entry point
- `dist/*.js` - JavaScript bundles (minified)
- `dist/*.css` - Compiled styles (minified)
- `dist/sourcemaps/*` - Source maps for debugging (if enabled)

## Deployment to Shopify

### Step 1: Verify Shopify Configuration

Check that the `shopify.ui.extension.toml` file is correctly configured:

```toml
type = "admin_ui"
api_version = "2024-10"
handle = "gcw-discount-admin"

[build]
path = "dist"
command = "npm run build"

[dev]
command = "npm run dev"
port = 3000
```

Verify the build command correctly builds your extension to the `dist` directory.

### Step 2: Deploy via Shopify CLI

```bash
# From repository root
cd ..  # Back to gcw-discount-app directory

# Deploy to development store
shopify app deploy

# For production/staging, set the target:
# shopify app deploy --location=production
```

The CLI will:
1. Prompt you to select/authenticate with a development store
2. Build the extension(s)
3. Upload the bundle to Shopify
4. Provide a URL to preview the extension

You'll receive output like:
```
✓ Built 1 extension
✓ Uploaded extensions to Shopify:
  - gcw-discount-admin: https://admin.shopify.com/store/handle/admin/extensions/gcw-discount-admin

✓ App updated successfully!
```

### Step 3: Verify in Shopify Admin

1. Go to your development store's Shopify admin
2. Navigate to **Apps and sales channels** → **Your apps** → **GCW Discount App**
3. Look for the **Discount Manager** admin link
4. Click to open the Admin UI Extension

The extension should load and display the discount list interface.

## Environment Configuration

### Development Environment (.env.development)

```bash
VITE_API_BASE_URL=http://localhost:8081/api
VITE_SENTRY_DSN=
NODE_ENV=development
```

### Staging Environment (.env.staging)

```bash
VITE_API_BASE_URL=https://staging-api.example.com/api
VITE_SENTRY_DSN=https://your-staging-sentry-dsn@sentry.io/project
NODE_ENV=staging
```

### Production Environment (.env.production)

```bash
VITE_API_BASE_URL=https://api.example.com/api
VITE_SENTRY_DSN=https://your-production-sentry-dsn@sentry.io/project
NODE_ENV=production
```

### Setting Environment Variables in Shopify

For production deployments, set environment variables in the Shopify app settings:

```bash
# After deploying to Shopify, configure env vars via Shopify CLI:
shopify app env set --environment production VITE_SENTRY_DSN "https://..."
shopify app env set --environment production VITE_API_BASE_URL "https://..."
```

Or via the Shopify Partner dashboard:
1. Go to Partner dashboard → **Apps and channels** → Your app
2. Select the deployment
3. Click **Settings** → **Environment variables**
4. Add/update variables

## Testing Before Deployment

### Unit Testing

```bash
npm run test

# With coverage
npm run test:coverage
```

### Build Validation

```bash
# Verify no build errors
npm run build

# Check bundle size
npm run build -- --analyze

# Type checking
npm run type-check
```

### Local Testing

```bash
# Start the development server
npm run dev

# In another terminal, start the backend API
cd ../../web
npm run dev

# Test in browser at http://localhost:3000
# - Create a discount
# - Schedule deployment
# - Preview discount
# - Check metrics tab
```

### API Integration Testing

```bash
# Test API endpoints directly
curl -X GET http://localhost:8081/api/discounts

# Test discount creation
curl -X POST http://localhost:8081/api/discounts \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Discount",
    "type": "percentage",
    "value": 10,
    "applicableTo": "all"
  }'
```

### Shopify Development Store Testing

1. Install the app on your development store
2. Navigate to the Discount Manager extension
3. Test full workflow:
   - ✅ List existing discounts
   - ✅ Create new discount
   - ✅ Edit discount details
   - ✅ Preview discount
   - ✅ Schedule future deployment
   - ✅ View performance metrics
   - ✅ Pause/resume discounts
   - ✅ Delete discounts

## Production Deployment Checklist

### Pre-Deployment

- [ ] Code review and approval completed
- [ ] All tests passing (`npm run test`)
- [ ] No TypeScript errors (`npm run type-check`)
- [ ] No linting issues (`npm run lint`)
- [ ] Build successful (`npm run build`)
- [ ] Bundle size under limits (< 2MB recommended)
- [ ] Manual QA completed in development store
- [ ] API endpoints fully implemented in backend
- [ ] Database migrations completed
- [ ] Sentry project created and DSN obtained
- [ ] Environment variables configured
- [ ] Webhooks configured in Shopify
- [ ] Scheduler service running (if auto-deployment enabled)

### Deployment Steps

1. **Update Version**
   ```bash
   npm version patch  # or minor/major as needed
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. **Build Production Bundle**
   ```bash
   npm run build
   npm run type-check  # Final verification
   ```

3. **Deploy to Shopify**
   ```bash
   shopify app deploy --location=production
   ```

4. **Verify Deployment**
   - Check Shopify Partner dashboard for successful deployment
   - Navigate to live store's admin
   - Verify Discount Manager is accessible
   - Test core functionality

5. **Monitor Post-Deployment**
   - Check Sentry for error spikes
   - Review backend API logs
   - Monitor performance metrics
   - Watch for user feedback

### Post-Deployment

- [ ] Verify extension loads in production admin
- [ ] Test API calls from production extension
- [ ] Monitor Sentry for errors
- [ ] Monitor backend logs for issues
- [ ] Confirm scheduled discounts deploying correctly
- [ ] Monitor performance metrics collection
- [ ] Have rollback plan ready if issues occur

## Monitoring & Debugging

### Browser DevTools

1. Open the extension in your development store
2. Open browser DevTools (F12)
3. Check:
   - **Console tab**: Any JavaScript errors
   - **Network tab**: API request/response details
   - **Application tab**: IndexedDB, localStorage, cookies

### Sentry Monitoring

1. Go to [sentry.io](https://sentry.io)
2. Navigate to your project
3. Monitor:
   - **Issues**: New errors and their frequency
   - **Performance**: Page load times, API latency
   - **Releases**: Deploy history and errors per release

Example Sentry query:
```
environment:production 
is:unresolved
```

### Backend Logs

```bash
# View recent backend logs
npm logs --tail=100

# Filter for discount-related logs
npm logs --grep="discount"

# Check scheduler logs
npm logs --grep="scheduler"
```

### API Health Checks

```bash
# Monitor API uptime
curl -f http://localhost:8081/api/discounts || alert "API down"

# Check backend connectivity
curl -I https://api.example.com/api/discounts
```

## Rollback Procedure

If critical issues are discovered after deployment:

1. **Identify the issue**
   - Check Sentry for error details
   - Review recent API changes
   - Check backend logs

2. **Rollback deployment**
   ```bash
   # Revert to previous version
   shopify app deploy --location=production --checkout-at <previous-tag>
   ```

3. **Fix the issue**
   - Identify root cause
   - Create fix and test locally
   - Get code review approval

4. **Re-deploy**
   ```bash
   # After fixes are complete
   shopify app deploy --location=production
   ```

## Performance Optimization

### Bundle Size Analysis

```bash
npm run build -- --analyze
```

Focus on:
- Large dependencies (replace with lighter alternatives if possible)
- Unused code (tree-shaking configured in Vite)
- Duplicate modules

### Code Splitting

Vite automatically code-splits:
- Modal components (loaded on demand)
- Heavy dependencies

### Caching

The extension is served with caching headers:
- Static assets: 1 month cache (with content hash)
- API requests: No cache (stale-while-revalidate)

## Scaling Considerations

As usage grows:

1. **Database Performance**
   - Index frequently queried columns
   - Archive old metrics
   - Consider read replicas for metrics queries

2. **API Rate Limiting**
   - Implement rate limiting on backend
   - Throttle client requests in extension
   - Queue bulk operations

3. **Scheduler Performance**
   - Use Bull queue for distributed job processing
   - Monitor job latency
   - Scale workers horizontally

4. **Metrics Collection**
   - Batch metrics writes
   - Use time-series database (InfluxDB, Prometheus)
   - Aggregate historical data

## Troubleshooting

### Extension Not Loading

**Symptom:** 404 error or blank page when visiting Discount Manager

**Solution:**
1. Verify `shopify.ui.extension.toml` has correct handle
2. Check `dist/` directory exists and contains `index.html`
3. Review Shopify Partner dashboard for deployment errors
4. Clear browser cache and reload

### API Errors

**Symptom:** "Failed to load discounts" message

**Solution:**
1. Verify backend API is running: `curl http://localhost:8081/api/discounts`
2. Check `VITE_API_BASE_URL` environment variable
3. Review Sentry for error details
4. Check CORS configuration on backend

### Scheduling Not Working

**Symptom:** Discounts not deploying at scheduled time

**Solution:**
1. Verify scheduler service is running
2. Check Redis connection (if using Bull)
3. Review `scheduler_jobs` table for failed jobs
4. Check Sentry for scheduler errors

### Performance Issues

**Symptom:** Slow to load discounts or metrics

**Solution:**
1. Check API response times in Network tab
2. Review database query performance
3. Add database indexes if needed
4. Use pagination for large discount lists

## Support & Documentation

- [Shopify Admin UI Extensions Docs](https://shopify.dev/docs/apps/admin/ui-extensions)
- [Shopify CLI Documentation](https://shopify.dev/docs/apps/tools/cli)
- [Sentry Documentation](https://docs.sentry.io)
- [Vite Documentation](https://vitejs.dev)
- [React Documentation](https://react.dev)

## Related Files

- [Extension Configuration](./shopify.ui.extension.toml)
- [Build Configuration](./vite.config.ts)
- [TypeScript Configuration](./tsconfig.json)
- [Backend API Documentation](./API.md)
- [Backend Implementation Guide](./BACKEND_IMPLEMENTATION.md)
- [Project README](./README.md)
