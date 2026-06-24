const NAMESPACE = '$app:gcw';
const KEY = 'shipping_progress';
const TYPE = 'json';
const CHECKOUT_SCHEDULE_TIME_ZONE = 'America/New_York';

function finiteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getTimeZoneOffsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );

  return (
    Date.UTC(
      values.year,
      values.month - 1,
      values.day,
      values.hour,
      values.minute,
      values.second,
    ) - date.getTime()
  );
}

function getEasternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHECKOUT_SCHEDULE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
}

function parseEasternWallTime(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) return null;

  const [, year, month, day, hour, minute, second = '00'] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
  const wallTimeAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const roundTrip = new Date(wallTimeAsUtc);

  if (
    roundTrip.getUTCFullYear() !== parts.year ||
    roundTrip.getUTCMonth() !== parts.month - 1 ||
    roundTrip.getUTCDate() !== parts.day ||
    roundTrip.getUTCHours() !== parts.hour ||
    roundTrip.getUTCMinutes() !== parts.minute ||
    roundTrip.getUTCSeconds() !== parts.second
  ) {
    return null;
  }

  const firstOffset = getTimeZoneOffsetMs(
    CHECKOUT_SCHEDULE_TIME_ZONE,
    new Date(wallTimeAsUtc),
  );
  const candidate = new Date(wallTimeAsUtc - firstOffset);
  const finalOffset = getTimeZoneOffsetMs(CHECKOUT_SCHEDULE_TIME_ZONE, candidate);
  const resolved = new Date(wallTimeAsUtc - finalOffset);
  const resolvedParts = getEasternParts(resolved);

  if (
    resolvedParts.year !== String(parts.year).padStart(4, '0') ||
    resolvedParts.month !== String(parts.month).padStart(2, '0') ||
    resolvedParts.day !== String(parts.day).padStart(2, '0') ||
    resolvedParts.hour !== String(parts.hour).padStart(2, '0') ||
    resolvedParts.minute !== String(parts.minute).padStart(2, '0')
  ) {
    return null;
  }

  return resolved.toISOString();
}

function normalizeScheduleDate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 40) return null;

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(trimmed)) {
    return parseEasternWallTime(trimmed);
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function normalizeMessage(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const clean = value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean && clean.length <= 160 ? clean : fallback;
}

function normalizeBoolean(value, fallback) {
  if (value === true || value === false) return value;
  return fallback;
}

function normalizePromoCode(value) {
  if (typeof value !== 'string') return '';
  const clean = value
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .toUpperCase();
  return /^[A-Z0-9_-]{1,64}$/.test(clean) ? clean : '';
}

export function shippingProgressErrorNeedsReauth(warning = '') {
  return /access.denied|insufficient.scope|invalid api key|access token/i.test(
    warning,
  );
}

export function buildShippingProgressConfig(discount = {}) {
  const threshold = Math.min(
    1000,
    Math.max(1, finiteNumber(discount.value ?? discount.threshold, 35)),
  );
  const source = typeof discount.source === 'string' && discount.source.length <= 32
    ? discount.source
    : 'function';
  const promoCode = normalizePromoCode(discount.promo_code);

  return {
    enabled: discount.show_checkout_progress === true,
    threshold,
    comparison: discount.comparison === 'gte' ? 'gte' : 'gt',
    source,
    promoCode,
    showProgressBar: normalizeBoolean(discount.checkout_progress_show_meter, true),
    showCodeInstruction: normalizeBoolean(discount.checkout_progress_show_code_instruction, true),
    startsAt: normalizeScheduleDate(
      discount.checkout_progress_starts_at || discount.starts_at || discount.start_date,
    ),
    endsAt: normalizeScheduleDate(
      discount.checkout_progress_ends_at || discount.ends_at || discount.end_date,
    ),
    remainingMessage:
      normalizeMessage(
        discount.checkout_progress_remaining_message,
        'Spend {{amount}} more to reach free shipping!',
      ),
    successMessage: normalizeMessage(
      discount.checkout_progress_success_message,
      'You are eligible for free shipping.',
    ),
    codePromptMessage: normalizeMessage(
      discount.checkout_progress_code_prompt_message,
      'Use code {{code}} at checkout',
    ),
    codeAppliedMessage: normalizeMessage(
      discount.checkout_progress_code_applied_message,
      'Code {{code}} is applied',
    ),
    discountId:
      typeof discount.id === 'string' && discount.id.length <= 128
        ? discount.id
        : null,
    syncedAt: new Date().toISOString(),
  };
}

export async function getShippingProgressMetafield(callShopify) {
  try {
    const response = await callShopify(`query CheckoutShippingProgress {
      shop {
        id
        metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
          value
        }
      }
    }`);

    const shopId = response?.result?.data?.shop?.id;
    const rawValue = response?.result?.data?.shop?.metafield?.value;
    if (!response?.ok || !shopId) {
      return {
        ok: false,
        warning:
          response?.error ||
          'Could not load checkout progress configuration.',
      };
    }

    let config = null;
    if (rawValue) {
      try { config = JSON.parse(rawValue); } catch { config = null; }
    }

    return { ok: true, shopId, config };
  } catch (error) {
    return {
      ok: false,
      warning:
        error instanceof Error
          ? error.message
          : 'Unknown checkout progress load error.',
    };
  }
}

async function setShippingProgressMetafield(callShopify, shopId, configObject) {
  const response = await callShopify(
    `mutation SyncShippingProgress($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id namespace key type }
        userErrors { field message code }
      }
    }`,
    {
      metafields: [
        {
          ownerId: shopId,
          namespace: NAMESPACE,
          key: KEY,
          type: TYPE,
          value: JSON.stringify(configObject),
        },
      ],
    },
  );

  const userErrors = response?.result?.data?.metafieldsSet?.userErrors || [];

  if (!response?.ok || userErrors.length > 0) {
    return {
      ok: false,
      warning:
        userErrors[0]?.message ||
        response?.error ||
        'Shop metafield synchronization failed.',
    };
  }

  return { ok: true, config: configObject };
}

export async function syncShippingProgressMetafield(callShopify, discount) {
  try {
    const incomingSource =
      typeof discount.source === 'string' ? discount.source : 'function';

    // The checkout progress bar is owned exclusively by the standalone Checkout
    // Bar UI (source: 'manual'). Discount/function deploys must never write the
    // shop metafield or they clobber the manual $35 config with shipping defaults.
    if (incomingSource !== 'manual') {
      return { ok: true, skipped: true, reason: 'standalone-checkout-bar-only' };
    }

    const current = await getShippingProgressMetafield(callShopify);
    if (!current.ok) return current;

    const config = buildShippingProgressConfig(discount);
    return await setShippingProgressMetafield(
      callShopify,
      current.shopId,
      config,
    );
  } catch (error) {
    return {
      ok: false,
      warning:
        error instanceof Error
          ? error.message
          : 'Unknown checkout progress synchronization error.',
    };
  }
}

export async function clearShippingProgressMetafield(callShopify, options = {}) {
  try {
    const current = await getShippingProgressMetafield(callShopify);
    if (!current.ok) return current;

    if (
      options.onlySource &&
      current.config?.enabled === true &&
      current.config?.source &&
      current.config.source !== options.onlySource
    ) {
      return { ok: true, skipped: true, config: current.config };
    }

    const clearedConfig = buildShippingProgressConfig({
      show_checkout_progress: false,
      source: options.source || current.config?.source || 'manual',
    });

    return await setShippingProgressMetafield(
      callShopify,
      current.shopId,
      clearedConfig,
    );
  } catch (error) {
    return {
      ok: false,
      warning:
        error instanceof Error
          ? error.message
          : 'Unknown checkout progress rollback error.',
    };
  }
}
