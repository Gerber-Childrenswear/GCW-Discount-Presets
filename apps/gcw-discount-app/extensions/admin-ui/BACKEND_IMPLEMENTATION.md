# GCW Discount Manager - Backend Implementation Guide

Complete guide for implementing the backend services, database schema, scheduler, and Shopify integration for the Admin UI Extension.

## Architecture Overview

```
Express App (web/index.js)
├── Authentication Middleware (Shopify session)
├── Discount Routes (/api/discounts/*)
│   ├── CRUD Handlers
│   ├── Scheduler Integration
│   └── Shopify GraphQL Client
├── Scheduler Service
│   ├── Job Queue (Bull/node-schedule)
│   ├── Deployment Handler
│   └── Expiration Handler
├── Database
│   ├── Discount Model
│   ├── Metrics Collection
│   └── Job Store
├── Shopify Integration
│   ├── GraphQL Queries
│   ├── Discount API
│   └── Webhook Handlers
└── Error Tracking (Sentry)
```

## 1. Database Schema

### Discount Table

```sql
CREATE TABLE discounts (
  id VARCHAR(255) PRIMARY KEY,
  shop_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  type VARCHAR(50) NOT NULL,  -- 'percentage', 'fixed', 'free-shipping', 'buy-x-get-y'
  value DECIMAL(10, 2) NOT NULL,
  applicable_to VARCHAR(50) NOT NULL,  -- 'all', 'products', 'collections', 'customers'
  target_ids JSON,  -- Array of Shopify GIDs
  discount_code VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'draft',  -- 'draft', 'scheduled', 'active', 'paused', 'expired'
  min_purchase DECIMAL(10, 2),
  max_uses INT,
  usage_count INT DEFAULT 0,
  metadata JSON,
  shopify_discount_id VARCHAR(255),  -- Shopify's internal ID after deployment
  scheduled_for TIMESTAMP,
  deployed_at TIMESTAMP,
  expires_at TIMESTAMP,
  paused_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by VARCHAR(255),
  updated_by VARCHAR(255),
  INDEX shop_idx (shop_id),
  INDEX status_idx (status),
  INDEX scheduled_idx (scheduled_for)
);
```

### Metrics Table

```sql
CREATE TABLE discount_metrics (
  id INT AUTO_INCREMENT PRIMARY KEY,
  discount_id VARCHAR(255) NOT NULL,
  shop_id VARCHAR(255) NOT NULL,
  impressions INT DEFAULT 0,
  clicks INT DEFAULT 0,
  conversions INT DEFAULT 0,
  revenue_impact DECIMAL(10, 2) DEFAULT 0,
  average_order_value DECIMAL(10, 2),
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (discount_id) REFERENCES discounts(id),
  INDEX discount_idx (discount_id),
  INDEX shop_idx (shop_id),
  INDEX date_idx (recorded_at)
);
```

### Scheduler Jobs Table

```sql
CREATE TABLE scheduler_jobs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  discount_id VARCHAR(255) NOT NULL,
  job_type VARCHAR(50),  -- 'deploy', 'expire'
  scheduled_for TIMESTAMP NOT NULL,
  job_id VARCHAR(255),  -- Job queue ID
  status VARCHAR(50) DEFAULT 'pending',  -- 'pending', 'processing', 'completed', 'failed'
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  executed_at TIMESTAMP,
  FOREIGN KEY (discount_id) REFERENCES discounts(id),
  INDEX discount_idx (discount_id),
  INDEX scheduled_idx (scheduled_for)
);
```

## 2. Environment Variables

Add to `.env`:

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/gcw_discounts
# or MySQL:
# DATABASE_URL=mysql://user:password@localhost:3306/gcw_discounts

# Scheduler
SCHEDULER_TYPE=bull  # 'bull', 'node-schedule', 'agenda'
REDIS_URL=redis://localhost:6379  # Required for Bull

# Shopify
SHOPIFY_API_KEY=your-api-key
SHOPIFY_API_SECRET=your-api-secret
SHOPIFY_API_VERSION=2024-01

# Sentry
SENTRY_DSN=https://your-sentry-dsn

# Feature Flags
ENABLE_SCHEDULER=true
ENABLE_AUTO_EXPIRATION=true
```

## 3. Implementation Steps

### Step 3.1: Add Dependencies

```bash
cd web
npm install bull redis knex pg  # Or mysql/mysql2 for MySQL
npm install node-schedule  # Alternative to Bull
npm install @shopify/shopify-app-express @shopify/shopify-api
```

### Step 3.2: Create Database Connection

**File: `web/db/connection.js`**

```javascript
const knex = require('knex');

const connection = knex({
  client: 'pg',  // or 'mysql'
  connection: process.env.DATABASE_URL,
  pool: { min: 2, max: 10 }
});

module.exports = connection;
```

### Step 3.3: Create Discount Model

**File: `web/models/Discount.js`**

```javascript
const db = require('../db/connection');

class Discount {
  static async list(shopId, filters = {}) {
    let query = db('discounts').where({ shop_id: shopId });
    
    if (filters.status) {
      query = query.where({ status: filters.status });
    }
    
    if (filters.limit) {
      query = query.limit(filters.limit).offset(filters.offset || 0);
    }
    
    return query.select('*').orderBy('created_at', 'desc');
  }

  static async create(shopId, data) {
    const discountId = `discount-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    await db('discounts').insert({
      id: discountId,
      shop_id: shopId,
      status: 'draft',
      ...data,
      created_at: new Date(),
      updated_at: new Date()
    });
    
    return this.getById(discountId);
  }

  static async getById(id) {
    return db('discounts').where({ id }).first();
  }

  static async update(id, data) {
    return db('discounts')
      .where({ id })
      .update({
        ...data,
        updated_at: new Date()
      });
  }

  static async delete(id) {
    return db('discounts').where({ id }).delete();
  }

  static async updateStatus(id, status) {
    const update = {
      status,
      updated_at: new Date()
    };
    
    if (status === 'active') {
      update.deployed_at = new Date();
    } else if (status === 'paused') {
      update.paused_at = new Date();
    }
    
    return db('discounts').where({ id }).update(update);
  }
}

module.exports = Discount;
```

### Step 3.4: Create Routes

**File: `web/routes/discounts.js`**

```javascript
const express = require('express');
const router = express.Router();
const Discount = require('../models/Discount');
const Scheduler = require('../services/Scheduler');
const ShopifyAPI = require('../services/ShopifyAPI');

// GET /api/discounts
router.get('/', async (req, res) => {
  try {
    const shopId = req.session.shop;
    const { status, limit = 50, offset = 0 } = req.query;
    
    const discounts = await Discount.list(shopId, {
      status,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
    
    res.json({ data: discounts });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/discounts
router.post('/', async (req, res) => {
  try {
    const shopId = req.session.shop;
    const discount = await Discount.create(shopId, req.body);
    res.status(201).json(discount);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/discounts/:id
router.get('/:id', async (req, res) => {
  try {
    const discount = await Discount.getById(req.params.id);
    if (!discount) return res.status(404).json({ error: 'Not found' });
    res.json(discount);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/discounts/:id
router.put('/:id', async (req, res) => {
  try {
    await Discount.update(req.params.id, req.body);
    const discount = await Discount.getById(req.params.id);
    res.json(discount);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/discounts/:id/schedule
router.post('/:id/schedule', async (req, res) => {
  try {
    const { scheduledFor, expiresAt } = req.body;
    const discount = await Discount.getById(req.params.id);
    
    // Update discount with schedule info
    await Discount.update(req.params.id, {
      status: 'scheduled',
      scheduled_for: new Date(scheduledFor),
      expires_at: expiresAt ? new Date(expiresAt) : null
    });
    
    // Create scheduler job
    await Scheduler.scheduleDeployment(req.params.id, new Date(scheduledFor));
    
    res.json({ success: true, message: 'Discount scheduled' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/discounts/:id/pause
router.post('/:id/pause', async (req, res) => {
  try {
    await Discount.updateStatus(req.params.id, 'paused');
    const discount = await Discount.getById(req.params.id);
    res.json(discount);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /api/discounts/:id/resume
router.post('/:id/resume', async (req, res) => {
  try {
    await Discount.updateStatus(req.params.id, 'active');
    const discount = await Discount.getById(req.params.id);
    res.json(discount);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// DELETE /api/discounts/:id
router.delete('/:id', async (req, res) => {
  try {
    await Discount.delete(req.params.id);
    res.status(204).send();
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// GET /api/discounts/:id/metrics
router.get('/:id/metrics', async (req, res) => {
  try {
    const db = require('../db/connection');
    const metrics = await db('discount_metrics')
      .where({ discount_id: req.params.id })
      .select('*')
      .orderBy('recorded_at', 'desc')
      .limit(30);
    
    res.json({ data: metrics });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/discounts/:id/deploy
router.post('/:id/deploy', async (req, res) => {
  try {
    const shopId = req.session.shop;
    const discount = await Discount.getById(req.params.id);
    
    // Deploy to Shopify
    const shopifyAPI = new ShopifyAPI(shopId);
    const result = await shopifyAPI.createDiscount(discount);
    
    // Update discount status
    await Discount.update(req.params.id, {
      status: 'active',
      shopify_discount_id: result.id,
      deployed_at: new Date(),
      expires_at: req.body.expiresAt ? new Date(req.body.expiresAt) : null
    });
    
    const updated = await Discount.getById(req.params.id);
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
```

### Step 3.5: Create Scheduler Service

**File: `web/services/Scheduler.js`**

```javascript
const Bull = require('bull');
const db = require('../db/connection');
const Discount = require('../models/Discount');
const ShopifyAPI = require('./ShopifyAPI');

// Create job queue
const deploymentQueue = new Bull('discount-deployments', process.env.REDIS_URL);
const expirationQueue = new Bull('discount-expirations', process.env.REDIS_URL);

class Scheduler {
  static async scheduleDeployment(discountId, deployAt) {
    const delay = deployAt.getTime() - Date.now();
    
    const job = await deploymentQueue.add(
      { discountId },
      {
        delay: Math.max(0, delay),
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        }
      }
    );
    
    // Record in database
    await db('scheduler_jobs').insert({
      discount_id: discountId,
      job_type: 'deploy',
      scheduled_for: deployAt,
      job_id: job.id,
      status: 'pending'
    });
    
    return job;
  }

  static async scheduleExpiration(discountId, expiresAt) {
    const delay = expiresAt.getTime() - Date.now();
    
    const job = await expirationQueue.add(
      { discountId },
      {
        delay: Math.max(0, delay),
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 2000
        }
      }
    );
    
    await db('scheduler_jobs').insert({
      discount_id: discountId,
      job_type: 'expire',
      scheduled_for: expiresAt,
      job_id: job.id,
      status: 'pending'
    });
    
    return job;
  }

  static async startWorkers() {
    // Deployment job handler
    deploymentQueue.process(async (job) => {
      const { discountId } = job.data;
      
      try {
        const discount = await Discount.getById(discountId);
        const shopifyAPI = new ShopifyAPI(discount.shop_id);
        
        // Deploy to Shopify
        const result = await shopifyAPI.createDiscount(discount);
        
        // Update discount
        await Discount.update(discountId, {
          status: 'active',
          shopify_discount_id: result.id,
          deployed_at: new Date()
        });
        
        // Update job record
        await db('scheduler_jobs')
          .where({ job_id: job.id })
          .update({
            status: 'completed',
            executed_at: new Date()
          });
        
        console.log(`[Scheduler] Deployed discount ${discountId}`);
      } catch (error) {
        console.error(`[Scheduler] Deployment failed for ${discountId}:`, error);
        await db('scheduler_jobs')
          .where({ job_id: job.id })
          .update({
            status: 'failed',
            error_message: error.message
          });
        throw error;
      }
    });

    // Expiration job handler
    expirationQueue.process(async (job) => {
      const { discountId } = job.data;
      
      try {
        await Discount.update(discountId, { status: 'expired' });
        
        await db('scheduler_jobs')
          .where({ job_id: job.id })
          .update({
            status: 'completed',
            executed_at: new Date()
          });
        
        console.log(`[Scheduler] Expired discount ${discountId}`);
      } catch (error) {
        console.error(`[Scheduler] Expiration failed for ${discountId}:`, error);
        throw error;
      }
    });
  }
}

module.exports = Scheduler;
```

### Step 3.6: Create Shopify Integration

**File: `web/services/ShopifyAPI.js`**

```javascript
const shopify = require('@shopify/shopify-api');

class ShopifyAPI {
  constructor(shopId) {
    this.shopId = shopId;
    this.client = new shopify.clients.GraphQL({ session: { shop: shopId } });
  }

  async createDiscount(discount) {
    const mutation = `
      mutation CreateDiscount($input: DiscountCodeAppInput!) {
        discountCodeAppCreate(input: $input) {
          appDiscount {
            discount {
              id
              title
              status
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const input = {
      title: discount.name,
      combinesWith: {
        orderDiscounts: false,
        productDiscounts: false
      },
      startsAt: new Date().toISOString(),
      endsAt: discount.expires_at?.toISOString() || null,
      appliesOncePerCustomer: !!discount.max_uses,
      usageLimit: discount.max_uses || null,
      codes: discount.discount_code ? [discount.discount_code] : null
    };

    // Configure discount based on type
    if (discount.type === 'percentage') {
      input.customerGets = {
        items: { all: true },
        value: {
          percentage: discount.value / 100
        }
      };
    } else if (discount.type === 'fixed') {
      input.customerGets = {
        items: { all: true },
        value: {
          fixedAmount: discount.value
        }
      };
    }

    const response = await this.client.query({
      data: { query: mutation, variables: { input } }
    });

    if (response.body.errors) {
      throw new Error(response.body.errors[0].message);
    }

    return response.body.data.discountCodeAppCreate.appDiscount.discount;
  }

  async deleteDiscount(shopifyDiscountId) {
    const mutation = `
      mutation DeleteDiscount($id: ID!) {
        discountDelete(id: $id) {
          deletedDiscountId
          userErrors {
            field
            message
          }
        }
      }
    `;

    const response = await this.client.query({
      data: {
        query: mutation,
        variables: { id: shopifyDiscountId }
      }
    });

    if (response.body.errors) {
      throw new Error(response.body.errors[0].message);
    }

    return true;
  }
}

module.exports = ShopifyAPI;
```

### Step 3.7: Initialize in Main App

**File: `web/index.js` (Add to existing file)**

```javascript
// ... existing imports ...
const discountRoutes = require('./routes/discounts');
const Scheduler = require('./services/Scheduler');

// ... existing middleware ...

// Discount routes
app.use('/api/discounts', discountRoutes);

// Start scheduler if enabled
if (process.env.ENABLE_SCHEDULER === 'true') {
  Scheduler.startWorkers().catch(err => {
    console.error('[Scheduler] Failed to start:', err);
    Sentry.captureException(err);
  });
}

// ... rest of app ...
```

## 4. Webhook Handlers

**File: `web/webhooks/metrics.js`**

```javascript
const db = require('../db/connection');

async function handleOrderCreate(req, res) {
  const { line_items, order_number } = req.body;
  
  // Infer which discount was applied (if any)
  // This would require tracking discount application in storefront
  
  // Record metrics
  const discountId = req.body.discount_codes?.[0]?.code; // simplified
  
  if (discountId) {
    await db('discount_metrics').insert({
      discount_id: discountId,
      shop_id: req.body.shop_id,
      conversions: 1,
      revenue_impact: req.body.total_price,
      average_order_value: req.body.total_price,
      recorded_at: new Date()
    });
  }
  
  res.status(200).send();
}

module.exports = { handleOrderCreate };
```

## 5. Implementation Checklist

- [ ] Create database schema (migrations)
- [ ] Add environment variables
- [ ] Install npm dependencies
- [ ] Create Discount model
- [ ] Create discount routes (/api/discounts/*)
- [ ] Create Scheduler service
- [ ] Create ShopifyAPI integration
- [ ] Initialize scheduler workers
- [ ] Set up webhook handlers for metrics
- [ ] Test local development with mock Shopify API
- [ ] Add comprehensive error handling
- [ ] Add request logging
- [ ] Add rate limiting
- [ ] Deploy to staging
- [ ] Load test with performance metrics
- [ ] Deploy to production

## 6. Testing

```bash
# Test local API endpoints
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

# Test scheduling
curl -X POST http://localhost:8081/api/discounts/discount-001/schedule \
  -H "Content-Type: application/json" \
  -d '{
    "scheduledFor": "2024-02-01T10:00:00Z",
    "expiresAt": "2024-02-28T23:59:59Z"
  }'
```

## Related Documentation

- [API Reference](./API.md)
- [Admin UI Documentation](./README.md)
- [Discount Function](../../functions/gcw_discount_function/)
