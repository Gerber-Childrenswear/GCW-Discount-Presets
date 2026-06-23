import assert from 'node:assert/strict';
import { buildShippingProgressConfig } from '../apps/gcw-discount-app/web/lib/shipping-progress.js';

const summer = buildShippingProgressConfig({
  id: 'gid://shopify/DiscountAutomaticNode/1',
  value: 50,
  show_checkout_progress: true,
  checkout_progress_starts_at: '2026-07-01T09:00',
  checkout_progress_ends_at: '2026-07-04T23:00',
});

assert.equal(summer.enabled, true);
assert.equal(summer.threshold, 50);
assert.equal(summer.comparison, 'gt');
assert.equal(summer.startsAt, '2026-07-01T13:00:00.000Z');
assert.equal(summer.endsAt, '2026-07-05T03:00:00.000Z');

const winter = buildShippingProgressConfig({
  threshold: 75,
  show_checkout_progress: true,
  starts_at: '2026-12-01T09:00',
});

assert.equal(winter.threshold, 75);
assert.equal(winter.startsAt, '2026-12-01T14:00:00.000Z');

const disabled = buildShippingProgressConfig({
  value: 25,
  show_checkout_progress: false,
});

assert.equal(disabled.enabled, false);
assert.equal(disabled.threshold, 25);

const invalidDst = buildShippingProgressConfig({
  value: 50,
  show_checkout_progress: true,
  checkout_progress_starts_at: '2026-03-08T02:30',
});

assert.equal(invalidDst.startsAt, null);

console.log('shipping progress config tests passed');
