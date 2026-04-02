# GCW Discount Manager - Backend API Documentation

This document describes the required API endpoints to support the Admin UI Extension for discount management.

## Base URL

Development: `http://localhost:8081/api`
Production: `https://your-app-url/api`

## Authentication

All requests require authentication via Shopify session. The Express.js app should validate requests through the Shopify middleware before routing to these endpoints.

## Endpoints

### 1. List All Discounts

**Endpoint:** `GET /discounts`

**Description:** Retrieve a list of all discounts with optional filtering

**Query Parameters:**
- `status` (optional): Filter by status (draft|scheduled|active|paused|expired)
- `limit` (optional): Number of results (default: 50, max: 100)
- `offset` (optional): Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "data": [
    {
      "id": "discount-001",
      "name": "Summer Sale",
      "description": "25% off all items",
      "type": "percentage",
      "value": 25,
      "applicableTo": "all",
      "status": "active",
      "deployedAt": "2024-01-01T10:00:00Z",
      "expiresAt": "2024-01-31T23:59:59Z",
      "usageCount": 1250,
      "maxUses": null,
      "minPurchase": 50,
      "targetIds": [],
      "metadata": {}
    }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

**Error Responses:**
- `400 Bad Request`: Invalid query parameters
- `401 Unauthorized`: Missing/invalid session
- `500 Internal Server Error`: Database error

---

### 2. Create Discount

**Endpoint:** `POST /discounts`

**Description:** Create a new discount in draft status

**Request Body:**
```json
{
  "name": "Black Friday Sale",
  "description": "30% off select items",
  "type": "percentage",
  "value": 30,
  "applicableTo": "products",
  "targetIds": ["gid://shopify/Product/123", "gid://shopify/Product/456"],
  "minPurchase": 100,
  "maxUses": 500,
  "code": "BLACKFRIDAY30",
  "metadata": {
    "campaign": "black-friday-2024",
    "region": "US"
  }
}
```

**Field Requirements:**
- `name` (required): Discount name (string, max 255 chars)
- `description` (optional): Discount description
- `type` (required, enum): 'percentage' | 'fixed' | 'free-shipping' | 'buy-x-get-y'
- `value` (required): Discount amount/percent (number, >0)
- `applicableTo` (required, enum): 'all' | 'products' | 'collections' | 'customers'
- `targetIds` (conditional): Required if applicableTo is not 'all'
- `minPurchase` (optional): Minimum cart value required (number, >=0)
- `maxUses` (optional): Max number of uses (number, null = unlimited)
- `code` (optional): Discount code for code-based discounts
- `metadata` (optional): Custom key-value data for tracking

**Response (201 Created):**
```json
{
  "id": "discount-001",
  "name": "Black Friday Sale",
  "status": "draft",
  "createdAt": "2024-01-01T10:00:00Z",
  "updatedAt": "2024-01-01T10:00:00Z"
}
```

**Error Responses:**
- `400 Bad Request`: Missing required fields
- `409 Conflict`: Discount code already exists
- `401 Unauthorized`: Missing/invalid session
- `500 Internal Server Error`: Database error

---

### 3. Get Single Discount

**Endpoint:** `GET /discounts/:id`

**Description:** Retrieve a specific discount by ID

**Parameters:**
- `id` (required): Discount ID

**Response (200 OK):**
```json
{
  "id": "discount-001",
  "name": "Summer Sale",
  "description": "25% off all items",
  "type": "percentage",
  "value": 25,
  "applicableTo": "all",
  "targetIds": [],
  "status": "active",
  "code": "SUMMER25",
  "deployedAt": "2024-01-01T10:00:00Z",
  "scheduledFor": null,
  "expiresAt": "2024-01-31T23:59:59Z",
  "usageCount": 1250,
  "maxUses": null,
  "minPurchase": 50,
  "createdAt": "2024-01-01T08:00:00Z",
  "updatedAt": "2024-01-15T14:30:00Z",
  "metadata": {}
}
```

**Error Responses:**
- `404 Not Found`: Discount not found
- `401 Unauthorized`: Missing/invalid session
- `500 Internal Server Error`: Database error

---

### 4. Update Discount

**Endpoint:** `PUT /discounts/:id`

**Description:** Update an existing discount (only possible in draft or paused status)

**Parameters:**
- `id` (required): Discount ID

**Request Body:**
```json
{
  "name": "Summer Mega Sale",
  "description": "Updated description",
  "value": 35,
  "maxUses": 1000
}
```

**Allowed Fields:**
- `name`, `description`, `type`, `value`, `applicableTo`, `targetIds`, `minPurchase`, `maxUses`, `code`, `metadata`
- Note: Cannot update `status` directly (use pause/resume/deploy endpoints)

**Response (200 OK):**
```json
{
  "id": "discount-001",
  "updatedAt": "2024-01-15T14:35:00Z"
}
```

**Error Responses:**
- `400 Bad Request`: Invalid update data
- `404 Not Found`: Discount not found
- `409 Conflict`: Cannot update discount in current status
- `401 Unauthorized`: Missing/invalid session
- `500 Internal Server Error`: Database error

---

### 5. Schedule Discount Deployment

**Endpoint:** `POST /discounts/:id/schedule`

**Description:** Schedule a discount to be deployed at a future date

**Parameters:**
- `id` (required): Discount ID

**Request Body:**
```json
{
  "scheduledFor": "2024-02-01T10:00:00Z",
  "expiresAt": "2024-02-28T23:59:59Z"
}
```

**Field Requirements:**
- `scheduledFor` (required): ISO 8601 datetime when discount should go live (must be in future)
- `expiresAt` (optional): ISO 8601 datetime when discount should expire

**Response (200 OK):**
```json
{
  "id": "discount-001",
  "status": "scheduled",
  "scheduledFor": "2024-02-01T10:00:00Z",
  "expiresAt": "2024-02-28T23:59:59Z"
}
```

**Background Process:**
- Create scheduler job to deploy discount at `scheduledFor` time
- Trigger via cron/job queue (e.g., node-schedule, Bull queue)
- Deploy discount via Shopify GraphQL API when time arrives
- Update discount status to 'active'
- Set webhook handler for Shopify notifications

**Error Responses:**
- `400 Bad Request`: Invalid datetime format or scheduledFor is in past
- `404 Not Found`: Discount not found
- `409 Conflict`: Discount already active or expired
- `401 Unauthorized`: Missing/invalid session
- `500 Internal Server Error`: Database error

---

### 6. Pause Discount

**Endpoint:** `POST /discounts/:id/pause`

**Description:** Temporarily pause an active discount

**Parameters:**
- `id` (required): Discount ID

**Request Body:** Empty body

**Response (200 OK):**
```json
{
  "id": "discount-001",
  "status": "paused",
  "pausedAt": "2024-01-15T14:40:00Z"
}
```

**Backend Behavior:**
- Update discount status to 'paused' in database
- Deactivate in Shopify via GraphQL API if necessary
- Track pause reason/timestamp for metrics

**Error Responses:**
- `404 Not Found`: Discount not found
- `409 Conflict`: Discount is not active
- `401 Unauthorized`: Missing/invalid session
- `500 Internal Server Error`: Database error

---

### 7. Resume Discount

**Endpoint:** `POST /discounts/:id/resume`

**Description:** Resume a paused discount

**Parameters:**
- `id` (required): Discount ID

**Request Body:** Empty body

**Response (200 OK):**
```json
{
  "id": "discount-001",
  "status": "active",
  "resumedAt": "2024-01-15T14:45:00Z"
}
```

**Backend Behavior:**
- Update discount status to 'active' in database
- Reactivate in Shopify via GraphQL API
- Continue existing usage counts

**Error Responses:**
- `404 Not Found`: Discount not found
- `409 Conflict`: Discount is not paused
- `401 Unauthorized`: Missing/invalid session
- `500 Internal Server Error`: Database error

---

### 8. Delete Discount

**Endpoint:** `DELETE /discounts/:id`

**Description:** Delete a discount (only in draft or paused status)

**Parameters:**
- `id` (required): Discount ID

**Request Body:** Empty body

**Response (204 No Content)**

**Backend Behavior:**
- Only allow deletion if status is 'draft' or 'paused'
- Remove from database
- Deactivate in Shopify if already deployed

**Error Responses:**
- `404 Not Found`: Discount not found
- `409 Conflict`: Discount is active or cannot be deleted
- `401 Unauthorized`: Missing/invalid session
- `500 Internal Server Error`: Database error

---

### 9. Get Performance Metrics

**Endpoint:** `GET /discounts/:id/metrics`

**Description:** Retrieve performance metrics for a specific discount

**Parameters:**
- `id` (required): Discount ID
- `period` (optional): 'day' | 'week' | 'month' | 'all' (default: 'all')

**Response (200 OK):**
```json
{
  "data": [
    {
      "discountId": "discount-001",
      "impressions": 15000,
      "clicks": 1200,
      "conversions": 450,
      "revenueImpact": 2250.00,
      "averageOrderValue": 150.00,
      "timestamp": "2024-01-15T23:59:59Z"
    },
    {
      "discountId": "discount-001",
      "impressions": 14500,
      "clicks": 1100,
      "conversions": 420,
      "revenueImpact": 2100.00,
      "averageOrderValue": 148.00,
      "timestamp": "2024-01-14T23:59:59Z"
    }
  ],
  "summary": {
    "totalImpressions": 29500,
    "totalConversions": 870,
    "conversionRate": "2.95%",
    "totalRevenueImpact": 4350.00,
    "averageOrderValue": 149.00
  }
}
```

**Data Collection Method:**
- Track via Shopify webhook events (checkout_complete, order_create)
- Record impression via storefront analytics
- Calculate metrics via analytics database
- Provides insights into discount effectiveness

**Error Responses:**
- `404 Not Found`: Discount not found
- `400 Bad Request`: Invalid period parameter
- `401 Unauthorized`: Missing/invalid session
- `500 Internal Server Error`: Database error

---

### 10. Manual Deployment

**Endpoint:** `POST /discounts/:id/deploy`

**Description:** Manually deploy a discount immediately to Shopify

**Parameters:**
- `id` (required): Discount ID

**Request Body:**
```json
{
  "expiresAt": "2024-02-15T23:59:59Z"
}
```

**Field Requirements:**
- `expiresAt` (optional): Override expiration date

**Response (200 OK):**
```json
{
  "id": "discount-001",
  "status": "active",
  "deployedAt": "2024-01-15T14:50:00Z",
  "expiresAt": "2024-02-15T23:59:59Z"
}
```

**Backend Behavior:**
- Create discount in Shopify via GraphQL API
- Update status to 'active'
- Record deployment timestamp
- Set up expiration webhook if applicable

**Error Responses:**
- `404 Not Found`: Discount not found
- `400 Bad Request`: Invalid expiration date
- `409 Conflict`: Discount already deployed or expired
- `401 Unauthorized`: Missing/invalid session
- `500 Internal Server Error`: Database/Shopify API error

---

## Error Handling

All endpoints return structured error responses:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Required field 'name' is missing",
    "details": {
      "field": "name",
      "type": "required"
    }
  }
}
```

**Standard Error Codes:**
- `VALIDATION_ERROR`: Request validation failed
- `NOT_FOUND`: Resource not found
- `CONFLICT`: Operation conflicts with current state
- `UNAUTHORIZED`: Authentication failed
- `FORBIDDEN`: Authorization failed
- `INTERNAL_ERROR`: Unexpected server error
- `SHOPIFY_API_ERROR`: Shopify GraphQL API error

---

## Implementation Checklist

- [ ] Create discount model/schema
- [ ] Implement GET /discounts endpoint with filtering
- [ ] Implement POST /discounts endpoint with validation
- [ ] Implement GET /discounts/:id endpoint
- [ ] Implement PUT /discounts/:id endpoint
- [ ] Implement POST /discounts/:id/schedule endpoint
- [ ] Implement POST /discounts/:id/pause endpoint
- [ ] Implement POST /discounts/:id/resume endpoint
- [ ] Implement DELETE /discounts/:id endpoint
- [ ] Implement GET /discounts/:id/metrics endpoint
- [ ] Implement POST /discounts/:id/deploy endpoint
- [ ] Set up Shopify GraphQL integration for discount creation
- [ ] Set up scheduler service for scheduled deployments
- [ ] Set up webhook handlers for Shopify notifications
- [ ] Set up analytics tracking for metrics collection
- [ ] Add request authentication middleware
- [ ] Add error handling and Sentry integration
- [ ] Add database persistence layer
- [ ] Add rate limiting
- [ ] Add comprehensive logging

---

## Related

- [Admin UI Extension Documentation](./README.md)
- [Frontend API Client](./src/api/discountApi.ts)
- [Type Definitions](./src/types.ts)
