import {
  Banner,
  BlockStack,
  Progress,
  Text,
  reactExtension,
  useAppMetafields,
  useDiscountAllocations,
  useDiscountCodes,
  useSubtotalAmount,
} from '@shopify/ui-extensions-react/checkout';

const METAFIELD_NAMESPACE = 'gcw';
const METAFIELD_KEY = 'shipping_progress';
const MAX_CONFIG_BYTES = 4096;
const MAX_MESSAGE_LENGTH = 160;

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  threshold: 50,
  comparison: 'gt',
  source: null,
  promoCode: '',
  showProgressBar: true,
  showCodeInstruction: true,
  startsAt: null,
  endsAt: null,
  remainingMessage: 'Spend {{amount}} more to reach free shipping!',
  successMessage: 'You are eligible for free shipping.',
  codePromptMessage: 'Use code {{code}} at checkout',
  codeAppliedMessage: 'Code {{code}} is applied',
});

export default reactExtension('purchase.checkout.block.render', () => <App />);

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeDateString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return null;
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function normalizeMessage(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > MAX_MESSAGE_LENGTH) return fallback;
  return clean;
}

function normalizeConfig(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.length > MAX_CONFIG_BYTES) {
    return DEFAULT_CONFIG;
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return DEFAULT_CONFIG;
    }

    const threshold = Math.min(
      1000,
      Math.max(1, toFiniteNumber(parsed?.threshold, DEFAULT_CONFIG.threshold)),
    );
    const startsAt = normalizeDateString(parsed?.startsAt);
    const endsAt = normalizeDateString(parsed?.endsAt);

    return {
      enabled: parsed?.enabled === true,
      threshold,
      comparison: parsed?.comparison === 'gte' ? 'gte' : 'gt',
      source: typeof parsed?.source === 'string' ? parsed.source : null,
      promoCode: normalizeMessage(parsed?.promoCode, ''),
      showProgressBar: parsed?.showProgressBar !== false,
      showCodeInstruction: parsed?.showCodeInstruction !== false,
      startsAt,
      endsAt,
      remainingMessage: normalizeMessage(
        parsed?.remainingMessage,
        DEFAULT_CONFIG.remainingMessage,
      ),
      successMessage: normalizeMessage(
        parsed?.successMessage,
        DEFAULT_CONFIG.successMessage,
      ),
      codePromptMessage: normalizeMessage(
        parsed?.codePromptMessage,
        DEFAULT_CONFIG.codePromptMessage,
      ),
      codeAppliedMessage: normalizeMessage(
        parsed?.codeAppliedMessage,
        DEFAULT_CONFIG.codeAppliedMessage,
      ),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function isWithinSchedule(config, now = Date.now()) {
  if (config?.enabled !== true) return false;

  const startsAt = config.startsAt ? Date.parse(config.startsAt) : null;
  const endsAt = config.endsAt ? Date.parse(config.endsAt) : null;

  if (startsAt !== null && (!Number.isFinite(startsAt) || now < startsAt)) {
    return false;
  }

  if (endsAt !== null && (!Number.isFinite(endsAt) || now >= endsAt)) {
    return false;
  }

  if (startsAt !== null && endsAt !== null && startsAt >= endsAt) {
    return false;
  }

  return true;
}

function cents(amount) {
  return Math.max(0, Math.round(toFiniteNumber(amount, 0) * 100));
}

function thresholdCents(threshold) {
  return Math.max(0, Math.round(toFiniteNumber(threshold, 0) * 100));
}

function formatMoney(amount, currencyCode) {
  const safeAmount = Math.max(0, toFiniteNumber(amount, 0));
  const safeCurrency = typeof currencyCode === 'string' && /^[A-Z]{3}$/.test(currencyCode)
    ? currencyCode
    : 'USD';

  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: safeCurrency,
    }).format(safeAmount);
  } catch {
    return `$${safeAmount.toFixed(2)}`;
  }
}

function renderTemplate(template, replacements, fallback = DEFAULT_CONFIG.remainingMessage) {
  let rendered = normalizeMessage(template, fallback);
  for (const [token, value] of Object.entries(replacements || {})) {
    rendered = rendered.split(token).join(String(value));
  }
  return rendered;
}

function hasPromoCode(discountCodes, promoCode) {
  const target = String(promoCode || '').trim().toLowerCase();
  if (!target) return false;
  return (Array.isArray(discountCodes) ? discountCodes : []).some((entry) => {
    const code = String(entry?.code || '').trim().toLowerCase();
    return code === target;
  });
}

function uniqueDiscountAllocations(allocations) {
  const seen = new Set();
  const unique = [];

  for (const allocation of Array.isArray(allocations) ? allocations : []) {
    const key = String(allocation?.title || allocation?.code || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(allocation);
  }

  return unique.slice(0, 5);
}

function App() {
  const subtotal = useSubtotalAmount();
  const allocations = useDiscountAllocations();
  const discountCodes = useDiscountCodes();
  const metafields = useAppMetafields({
    type: 'shop',
    namespace: METAFIELD_NAMESPACE,
    key: METAFIELD_KEY,
  });

  const rawConfig = metafields?.[0]?.metafield?.value;
  const config = normalizeConfig(rawConfig);

  const subtotalAmount = Math.max(0, toFiniteNumber(subtotal?.amount, 0));
  const currencyCode = subtotal?.currencyCode || 'USD';

  const subtotalInCents = cents(subtotalAmount);
  const shouldShowProgress = isWithinSchedule(config) && subtotalInCents > 0;
  const thresholdInCents = thresholdCents(config.threshold);
  const goalInCents =
    config.comparison === 'gte' ? thresholdInCents : thresholdInCents + 1;

  const unlocked =
    config.comparison === 'gte'
      ? subtotalInCents >= thresholdInCents
      : subtotalInCents > thresholdInCents;

  const remainingInCents = unlocked
    ? 0
    : Math.max(goalInCents - subtotalInCents, 0);
  const remaining = remainingInCents / 100;
  const promoApplied = hasPromoCode(discountCodes, config.promoCode);
  const progress = goalInCents > 0
    ? Math.max(0, Math.min(subtotalInCents / goalInCents, 1))
    : 0;
  const progressPercent = Math.round(progress * 100);
  const uniqueAllocations = uniqueDiscountAllocations(allocations);

  return (
    <BlockStack spacing="tight">
      {shouldShowProgress ? (
        <BlockStack spacing="tight">
          <Text emphasis="bold" appearance={unlocked ? 'success' : 'accent'}>
            {unlocked
              ? renderTemplate(config.successMessage, {
                  '{{amount}}': formatMoney(remaining, currencyCode),
                  '{{code}}': config.promoCode,
                }, DEFAULT_CONFIG.successMessage)
              : renderTemplate(config.remainingMessage, {
                  '{{amount}}': formatMoney(remaining, currencyCode),
                  '{{code}}': config.promoCode,
                }, DEFAULT_CONFIG.remainingMessage)}
          </Text>

          {config.showCodeInstruction && config.promoCode ? (
            <Text size="small" appearance={promoApplied ? 'success' : 'subdued'}>
              {promoApplied
                ? renderTemplate(config.codeAppliedMessage, {
                    '{{amount}}': formatMoney(remaining, currencyCode),
                    '{{code}}': config.promoCode,
                  }, DEFAULT_CONFIG.codeAppliedMessage)
                : renderTemplate(config.codePromptMessage, {
                    '{{amount}}': formatMoney(remaining, currencyCode),
                    '{{code}}': config.promoCode,
                  }, DEFAULT_CONFIG.codePromptMessage)}
            </Text>
          ) : null}

          {config.showProgressBar ? (
            <Progress
              value={progress}
              max={1}
              accessibilityLabel={
                unlocked
                  ? 'Free shipping unlocked'
                  : `${progressPercent} percent toward free shipping`
              }
            />
          ) : null}
        </BlockStack>
      ) : null}

      {uniqueAllocations.map((allocation, index) => (
        <Banner
          key={`${allocation.title || allocation.code}-${index}`}
          status="success"
          title={allocation.title || 'Discount applied'}
        >
          {allocation.code ? <Text>Code: {allocation.code}</Text> : null}
        </Banner>
      ))}
    </BlockStack>
  );
}
