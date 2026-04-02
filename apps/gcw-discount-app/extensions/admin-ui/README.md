# GCW Discount Manager - Admin UI Extension

A Shopify Admin UI Extension for managing discounts, scheduling deployments, and monitoring performance metrics. This replaces the external Cloudflare-hosted control panel with a native integration inside the Shopify admin.

## Features

- **Create Discounts**: Create new discount codes with flexible configuration (percentage, fixed, free shipping, buy-x-get-y)
- **Schedule Deployments**: Schedule discounts to go live at specific times with automatic expiration
- **Manage Discounts**: View, edit, pause, resume, and delete existing discounts
- **Performance Metrics**: Track impressions, clicks, conversions, and revenue impact
- **Error Tracking**: Integrated Sentry error tracking for all API calls
- **Type Safety**: Full TypeScript support for reliable development

## Project Structure

```
extensions/admin-ui/
├── src/
│   ├── index.tsx                 # React entry point with Sentry initialization
│   ├── App.tsx                   # Main application component
│   ├── types.ts                  # TypeScript interfaces and types
│   ├── api/
│   │   └── discountApi.ts        # Axios HTTP client with Sentry integration
│   └── components/
│       ├── CreateDiscountModal.tsx      # Create new discount form
│       ├── ScheduleDiscountModal.tsx    # Schedule deployment dialog
│       ├── PreviewDiscountModal.tsx     # Visual discount preview
│       └── PerformanceMetrics.tsx       # Metrics dashboard
├── index.html                    # HTML entry point
├── vite.config.ts               # Vite configuration
├── tsconfig.json                # TypeScript configuration
├── package.json                 # Dependencies and scripts
├── .env.example                 # Environment variable template
└── shopify.ui.extension.toml    # Shopify extension manifest

Backend Routes (required in web/index.js):
├── GET /api/discounts                          # List all discounts
├── POST /api/discounts                         # Create new discount
├── GET /api/discounts/:id                      # Get single discount
├── PUT /api/discounts/:id                      # Edit discount
├── POST /api/discounts/:id/schedule            # Schedule deployment
├── POST /api/discounts/:id/pause               # Pause discount
├── POST /api/discounts/:id/resume              # Resume discount
├── DELETE /api/discounts/:id                   # Delete discount
├── GET /api/discounts/:id/metrics              # Get performance metrics
└── POST /api/discounts/:id/deploy              # Manual deployment
```

## Setup

### 1. Install Dependencies

```bash
cd extensions/admin-ui
npm install
```

### 2. Configure Environment Variables

```bash
# Copy the example env file
cp .env.example .env

# Edit .env with your values
# VITE_API_BASE_URL=http://localhost:8081/api  (local development)
# VITE_SENTRY_DSN=<your-sentry-dsn>             (production error tracking)
```

### 3. Start Development Server

```bash
npm run dev
```

The extension will be available at `http://localhost:3000`.

### 4. Build for Production

```bash
npm run build
npm run preview  # Preview the production build
```

## Component Hierarchy

```
App
├── DataTable (discount list)
├── Tabs (All / Scheduled / Active / Metrics)
├── CreateDiscountModal
│   └── Form Fields (name, type, value, etc.)
├── ScheduleDiscountModal
│   └── Date/Time Pickers
├── PreviewDiscountModal
│   └── Visual Discount Details
└── PerformanceMetrics
    ├── Summary Cards (impressions, conversion rate, revenue, AOV)
    └── DataTable (detailed metrics per discount)
```

## API Integration

The app communicates with the backend via the `DiscountAPI` class:

```typescript
const api = new DiscountAPI();

// List discounts
const discounts = await api.listDiscounts();

// Create discount
const newDiscount = await api.createDiscount({
  name: 'Summer Sale',
  type: 'percentage',
  value: 25,
  applicableTo: 'all'
});

// Schedule deployment
await api.scheduleDiscount(discountId, {
  scheduledFor: new Date('2024-01-01T10:00:00Z'),
  expiresAt: new Date('2024-01-31T23:59:59Z')
});

// Get performance metrics
const metrics = await api.getPerformanceMetrics(discountId);
```

All API calls include automatic Sentry error tracking with contextual information.

## Error Handling

- **HTTP Errors**: Caught by Sentry interceptor in `discountApi.ts`
- **Form Validation**: Required field validation in modal components
- **Date Validation**: Ensures scheduled deployment is in the future
- **User Feedback**: Error messages displayed in Banner component

## Discount Types

| Type | Description | Example |
|------|-------------|---------|
| `percentage` | Percentage discount | 25% off |
| `fixed` | Fixed dollar amount | $10 off |
| `free-shipping` | Free shipping | Ships free on order |
| `buy-x-get-y` | Buy X get Y | Buy 2 get 1 free |

## Discount Status Flow

```
draft → scheduled → active → (paused/resumed) → expired
```

- **draft**: Discount created but not deployed
- **scheduled**: Deployment scheduled for future date
- **active**: Discount is currently active/live
- **paused**: Active discount temporarily paused
- **expired**: Discount has passed expiration date

## Sentry Integration

Error tracking is automatically configured via the Sentry initialization in `index.tsx`:

```typescript
// Automatically captures:
- All API errors (method, URL, HTTP status)
- Unhandled exceptions
- React component errors
- Performance metrics (10% sample rate in prod)
```

Set `VITE_SENTRY_DSN` environment variable to enable.

## Backend Requirements

This extension requires corresponding API endpoints in `web/index.js`. See the [Backend API Documentation](../../web/API.md) for implementation details.

Key requirements:
- Shopify GraphQL queries for discount creation/modification
- Database persistence (Shopify metafields or external DB)
- Scheduler service for time-based deployments
- Webhook handlers for Shopify notifications

## Development Tips

### Hot Module Reloading
The dev server supports HMR out of the box. Changes to components will reflect immediately without full refresh.

### TypeScript Checking
```bash
npm run type-check
```

### Linting
```bash
npm run lint
```

### Formatting
```bash
npm run pretty
```

## Production Deployment

1. Build the extension: `npm run build`
2. Deploy via Shopify CLI: `shopify app deploy`
3. Configure webhook handlers for scheduled deployments
4. Set `VITE_SENTRY_DSN` in production environment

## Troubleshooting

**Extension not loading in Shopify admin**
- Verify `shopify.ui.extension.toml` has correct handle and admin_api_access scopes
- Check that backend API is running and accessible
- Review Sentry for error details

**API calls failing**
- Verify `VITE_API_BASE_URL` is correct
- Check backend routes match expected endpoints
- Review Sentry traces for HTTP error details

**Date/time issues**
- Ensure backend handles timezone-aware dates
- Client uses ISO 8601 format (date-fns)
- Server should store as UTC

## Related Documentation

- [Shopify Admin UI Extensions](https://shopify.dev/docs/apps/admin/ui-extensions)
- [Discount Function API](../../functions/gcw_discount_function/)
- [Backend API Routes](../../web/)
- [Type Definitions](./src/types.ts)
