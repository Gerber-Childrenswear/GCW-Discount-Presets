# GCW Discount App - Architecture

## Technology Stack

### Backend (Discount Function)
- **Language**: Rust 1.93.1
- **Target**: WebAssembly (WASM)
- **Framework**: Shopify Functions API 2.0.3
- **GraphQL**: Bluejay (GraphQL parsing and validation)
- **Serialization**: MessagePack (rmp-serde)
- **Build Tool**: Cargo

**Key Dependencies** (51 total):
- `shopify_function` - Core Shopify Functions SDK
- `shopify_function_macro` - Procedural macros for function definition
- `serde_json` - JSON serialization (for input/output)
- `logos` - Lexical analysis (GraphQL parsing)

### Frontend (Admin UI)
- **Language**: TypeScript/JSX (React)
- **UI Framework**: Shopify Polaris (when implemented)
- **Build Tool**: Shopify CLI with Webpack
- **Runtime**: Node.js 22.0.0+

### Orchestration
- **App Framework**: Shopify CLI 3.88+
- **Package Manager**: npm
- **Version Control**: Git + GitHub
- **Deployment**: Shopify Apps deployment system

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Shopify Admin                            │
│                  (Admin Dashboard)                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
           ┌───────────┼───────────┐
           │           │           │
      [API Routes]  [Webhooks]  [Function]
           │           │           │
    ┌──────────────────┐    ┌──────────────────┐
    │   Admin UI       │    │ WASM Function    │
    │  (React/TS)      │    │ (Rust/WASM)      │
    │                  │    │                  │
    │ • Configuration  │    │ • Discount Logic │
    │ • Settings Form  │    │ • Exclusions     │
    │ • Rules Display  │    │ • Code Validation│
    └──────────────────┘    │ • Privacy Checks │
                            └──────────────────┘
           │                       │
           └───────────┬───────────┘
                       │
        ┌──────────────────────────┐
        │   Shopify Backend        │
        │                          │
        │ • Cart/Checkout API      │
        │ • Product API            │
        │ • Discount API           │
        │ • Order API              │
        │ • Privacy API            │
        └──────────────────────────┘
```

## Data Flow

### 1. Discount Function Execution

```
Customer Adds Item to Cart
         │
         ▼
Shopify Evaluates Active Functions
         │
         ▼
WASM Function Invoked with Cart Data
    ├─ Extract Cart Lines
    ├─ Extract Discount Codes
    ├─ Validate Codes (SMS/freeshipping/perks)
    ├─ Filter Excluded Products
    ├─ Check Privacy Consent (via Shopify API)
    └─ Calculate Discount
         │
         ▼
Return Discount Result (25% off)
         │
         ▼
Shopify Applies Discount to Checkout
         │
         ▼
Customer Sees Updated Total
```

### 2. Admin Configuration (Future)

```
Admin Opens GCW Discount App
         │
         ▼
Admin UI Component Loads (React)
         │
    ├─ Fetch Current Settings
    ├─ Display Configuration Form
    ├─ Show Active Rules
    └─ Show Excluded Items
         │
Admin Makes Changes:
    ├─ Update Discount %
    ├─ Add/Remove Exclusions
    └─ Modify Allowed Codes
         │
         ▼
Submit to Backend API Route
         │
         ▼
Persist Settings to Shopify Metafields
         │
         ▼
Function Reads Settings on Next Invocation
```

## File Organization

### 1. Discount Function (`functions/discount-function/`)

```
lib.rs (120 lines)
├── Constants
│   ├── DISCOUNT_PERCENT = 25.0
│   ├── MESSAGE = "Extra 25% Off Applied!"
│   └── EXCLUDED_TAGS = [...]
│
├── Main Function
│   └── run() -> FunctionRunResult
│       ├── Validate Discount Codes
│       ├── Filter Products
│       └── Apply Discount
│
└── Helper Functions
    ├── is_allowed_discount_code()
    ├── is_excluded_product()
    └── Unit Tests (3 tests)
```

### 2. Admin UI (`extensions/admin-ui/`)

```
index.tsx (to be created)
├── AdminDashboard Component
│   ├── Discount % Input
│   ├── Excluded Items List
│   ├── Allowed Codes Display
│   └── Save Button
│
└── Components/
    ├── ExclusionRuleList
    ├── CodeValidator
    └── SettingsPersister
```

## Key Concepts

### 1. Discount Function Lifecycle

```
┌─ UNDEPLOYED
│  └─ NPM install, Cargo check
│     └─ READY FOR DEPLOYMENT
│        └─ NPM run build
│           └─ WASM Compiled
│              └─ Shopify CLI deploy
│                 └─ DEPLOYED ON SHOPIFY
│                    └─ Running on Every Cart Evaluation
```

### 2. Permission & Scopes

Required OAuth2 Scopes:
```
write_products       - Manage product tags (exclusions)
read_orders          - View order details
write_orders         - Update order metadata
write_discounts      - Manage discount functions & rules
```

### 3. WASM Compilation

```
lib.rs (Rust source)
   │
   ├─ rustc + WASM target
   │
   ▼
discount_function.wasm (200KB)
   │
   └─ Deployed to Shopify
```

### 4. Dependency Resolution

```
Cargo.toml
   │
   ├─ shopify_function 2.0.3
   ├─ Build dependencies (51 total)
   │
   ▼
Cargo.lock (locked versions)
   │
   ├─ Ensures reproducible builds
   ├─ Synced across team
   │
   ▼
cargo build --release
```

## Performance Characteristics

| Metric | Value | Note |
|--------|-------|------|
| WASM Bundle Size | ~200KB | Optimized release build |
| Per-Evaluation Time | <10ms | Typical execution |
| Memory Overhead | <5MB | Per function instance |
| Response Time | <50ms | Full checkout recalc |
| Concurrent Requests | Unlimited | Serverless scaling |
| Privacy Check Overhead | <1ms | Async consent check |

## Security

### 1. Function Isolation
- WASM runs in isolated sandbox
- Cannot access filesystem
- Cannot make outbound network calls
- Only reads from provided input

### 2. Data Protection
- Cart data is immutable within function
- No sensitive data stored
- Privacy checks prevent tracking violations
- Consent signals respected

### 3. Code Review
- All function updates require code review
- Deployed via GitHub + Shopify CLI
- Version controlled in git
- Audit trail on Shopify admin

## Deployment Pipeline

```
Feature Branch
   │
   └─ git push origin feature/xyz
      └─ Code Review on GitHub
         └─ Approve & Merge to main
            └─ npm run build
               └─ cargo build (WASM)
                  └─ npm run deploy
                     └─ shopify app deploy
                        └─ Live on Production
```

## Integration Points

### Shopify APIs Used
1. **Discount Functions API** - Core function execution
2. **Customer Privacy API** - Consent checking
3. **Product API** - Tag-based exclusions
4. **Order API** - Order processing hooks
5. **Metafields API** - Persistent settings (admin UI)

### External Privacy Frameworks
- **Shopify Privacy API** - First-party consent
- **Pandectes** - Privacy category mapping (C0003)
- **Global Privacy Control (GPC)** - Browser signal
- **US Privacy** - __uspapi opt-out detection

## Monitoring & Debugging

### Available Logs
```bash
# Real-time dev logs
shopify app dev --verbose

# Build logs
npm run build 2>&1 | tee build.log

# Function test logs
cargo test --lib -- --nocapture
```

### Debugging Functions

The discount function is deterministic and can be tested locally:

```rust
#[cfg(test)]
mod tests {
    // Test cases cover:
    // ✓ Allowed discount codes
    // ✓ Gift card exclusions
    // ✓ Product tag exclusions
}
```

## Future Enhancements

1. **Admin UI Configuration**
   - Dynamic discount percentages
   - Add/remove exclusion rules
   - Code allowlist management

2. **Analytics Dashboard**
   - Discount usage metrics
   - Revenue impact tracking
   - Popular excluded items

3. **Multi-Currency Support**
   - Calculate discounts in local currency
   - Display localized messages

4. **A/B Testing**
   - Test different discount percentages
   - Compare conversion rates
   - Statistically significant rollouts

## References

- [Shopify Functions Docs](https://shopify.dev/docs/apps/checkout/functions)
- [Shopify Privacy API](https://shopify.dev/docs/api/admin-rest/2024-10/resources/customer_privacy)
- [Rust Book](https://doc.rust-lang.org/book/)
- [WebAssembly Spec](https://webassembly.org/)

