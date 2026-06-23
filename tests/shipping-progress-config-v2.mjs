import assert from 'node:assert/strict';
import { buildShippingProgressConfig } from '../apps/gcw-discount-app/web/lib/shipping-progress-config.js';

const manual = buildShippingProgressConfig({
  id: 'manual-checkout-shipping-progress',
  source: 'manual',
  value: 35,
  comparison: 'gte',
  promo_code: 'FREESHIP35',
  show_checkout_progress: true,
  checkout_progress_show_meter: false,
  checkout_progress_show_code_instruction: true,
  checkout_progress_starts_at: '2026-06-24T00:00',
  checkout_progress_ends_at: '2026-06-27T03:00',
  checkout_progress_code_prompt_message: 'Enter {{code}} to unlock free shipping',
  checkout_progress_code_applied_message: '{{code}} is active',
});

assert.equal(manual.enabled, true);
assert.equal(manual.source, 'manual');
assert.equal(manual.threshold, 35);
assert.equal(manual.comparison, 'gte');
assert.equal(manual.promoCode, 'FREESHIP35');
assert.equal(manual.showProgressBar, false);
assert.equal(manual.showCodeInstruction, true);
assert.equal(manual.startsAt, '2026-06-24T04:00:00.000Z');
assert.equal(manual.endsAt, '2026-06-27T07:00:00.000Z');
assert.equal(
  manual.remainingMessage,
  'Spend {{amount}} more to reach free shipping!',
);
assert.equal(manual.codePromptMessage, 'Enter {{code}} to unlock free shipping');
assert.equal(manual.codeAppliedMessage, '{{code}} is active');

const functionManaged = buildShippingProgressConfig({
  source: 'function',
  value: 50,
  show_checkout_progress: true,
});

assert.equal(functionManaged.source, 'function');
assert.equal(functionManaged.threshold, 50);

const invalidDst = buildShippingProgressConfig({
  source: 'manual',
  value: 35,
  show_checkout_progress: true,
  checkout_progress_starts_at: '2026-03-08T02:30',
});

assert.equal(invalidDst.startsAt, null);

const invalidCode = buildShippingProgressConfig({
  source: 'manual',
  value: 35,
  promo_code: '<script>',
  show_checkout_progress: true,
});

assert.equal(invalidCode.promoCode, '');
assert.equal(invalidCode.comparison, 'gt');

console.log('shipping progress config v2 tests passed');
