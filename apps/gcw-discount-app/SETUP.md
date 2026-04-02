# GCW Discount App - Setup Guide

## System Requirements

- Node.js 22.0.0 or higher
- Rust 1.93.1 or higher (with WASM target)
- Shopify CLI 3.88.0 or higher
- Git

### For Windows Users

⚠️ **Important**: If building on Windows, you need to resolve the Rust compiler access issue first. See [WINDOWS_COMPILER_FIX.md](../../functions/gcw_discount_function/WINDOWS_COMPILER_FIX.md) for details.

## Installation

1. **Clone the repository** (if needed)
   ```bash
   git clone https://github.com/Gerber-Childrenswear/gcw-dev.git
   cd gcw-dev/apps/gcw-discount-app
   ```

2. **Install Node dependencies**
   ```bash
   npm install
   ```

3. **Ensure Rust is set up for WASM**
   ```bash
   rustup target add wasm32-unknown-unknown
   ```

4. **Verify dependencies are resolved**
   ```bash
   cd functions/discount-function
   cargo check
   cd ../..
   ```

## Development

### Start Development Server

```bash
npm run dev
```

This will:
- Start a local Shopify CLI dev server
- Watch for code changes
- Hot-reload the discount function and admin UI
- Expose the function to your Shopify development store

### Build for Production

```bash
npm run build
```

This will:
- Compile the Rust discount function to WASM
- Build the admin UI extension
- Create optimized artifacts in the `dist/` directory

### Run Tests

```bash
npm run test
```

This runs:
- Rust unit tests for the discount function logic
- JavaScript tests for admin UI components

## File Structure

```
gcw-discount-app/
├── functions/
│   └── discount-function/           # Rust WASM discount function
│       ├── src/
│       │   └── lib.rs               # Main discount logic
│       ├── Cargo.toml               # Rust dependencies
│       ├── Cargo.lock               # Locked dependency versions
│       ├── input.graphql            # GraphQL query schema
│       ├── schema.graphql           # GraphQL schema definition
│       └── shopify.function.toml    # Function configuration
│
├── extensions/
│   └── admin-ui/                    # Admin configuration dashboard
│       ├── src/
│       │   ├── index.tsx            # Main component
│       │   └── components/          # React components
│       ├── package.json             # Admin UI dependencies
│       └── shopify.ui.extension.toml # Extension configuration
│
├── shopify.app.toml                 # App configuration and scopes
├── package.json                     # App root dependencies
├── README.md                        # User documentation
└── SETUP.md                         # This file
```

## Configuration

### App Scopes

The app requires the following scopes in `shopify.app.toml`:

- `write_products` - Update product tags and metadata
- `read_orders` - View order details for validation
- `write_orders` - Update order attributes
- `write_discounts` - Create and manage discount functions

### Discount Function Settings

Edit [functions/discount-function/src/lib.rs](functions/discount-function/src/lib.rs) to customize:

- **DISCOUNT_PERCENT**: Discount percentage (currently 25%)
- **MESSAGE**: Discount message shown to customers
- **EXCLUDED_TAGS**: Product tags that exclude items from discount
- **Allowed Codes**: Discount codes that trigger the function

## Deployment

### Deploy to Staging

```bash
shopify app deploy --reset
```

### Deploy to Production

```bash
shopify app deploy --force
```

## Troubleshooting

### Cargo build fails with "access denied"

See [WINDOWS_COMPILER_FIX.md](../../functions/gcw_discount_function/WINDOWS_COMPILER_FIX.md) for Windows-specific solutions.

### Node dependencies installation fails

Try clearing npm cache:

```bash
npm cache clean --force
npm install
```

### Function not compiling

Ensure WASM target is installed:

```bash
rustup target add wasm32-unknown-unknown
```

## Testing Locally

1. Start the dev server: `npm run dev`
2. Log in to your Shopify dev store
3. Add test products with discount codes (SMS, freeshipping, perks)
4. Create a test cart and apply the discount code
5. Verify the 25% discount is applied (excluding configured items)

## Privacy & Compliance

This function integrates with Shopify's Customer Privacy API and respects:
- Customer consent preferences (marketing/analytics)
- Global Privacy Control (GPC) headers
- US Privacy opt-out signals

## Contributing

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make changes and test locally
3. Push to GitHub: `git push origin feature/my-feature`
4. Create a Pull Request with test results
5. Deploy from main branch after review

## Support

For issues or questions:
- Check the existing [GitHub Issues](https://github.com/Gerber-Childrenswear/gcw-dev/issues)
- Reference the [Shopify Functions Documentation](https://shopify.dev/docs/apps/checkout/functions)
- Review the [Privacy Framework Docs](../../assets/pandectes-settings.json)

