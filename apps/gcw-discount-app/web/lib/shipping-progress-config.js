const NAMESPACE = '$app:gcw';
const LEGACY_NAMESPACE = 'gcw';
const KEY = 'shipping_progress';
const TYPE = 'json';
const CHECKOUT_SCHEDULE_TIME_ZONE = 'America/New_York';

export const STOCKUP35_CHECKOUT_PROGRESS = Object.freeze({
  enabled: true,
  threshold: 35,
  comparison: 'gte',
  source: 'manual',
  promoCode: 'STOCKUP35',
  showProgressBar: true,
  showCodeInstruction: true,
  startsAt: null,
  endsAt: null,
  remainingMessage: 'Spend {{amount}} more to reach free shipping!',
  successMessage: 'You are eligible for free shipping, use code STOCKUP35 in checkout.',
  codePromptMessage: 'Use code {{code}} at checkout',
  codeAppliedMessage: 'Code {{code}} is applied',
  discountId: 'manual-checkout-shipping-progress',
});

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
  return /access.denied|insufficient.scope|write_metafields/i.test(warning);
}

export function shippingProgressAuthErrorMessage(warning = '') {
  if (/invalid api key|access token/i.test(warning)) {
    return 'Shopify rejected the stored access token. Open the app from Shopify admin to refresh it, or update SHOPIFY_PROD_ACCESS_TOKEN on Render after re-installing the app.';
  }
  if (shippingProgressErrorNeedsReauth(warning)) {
    return 'App needs permission to write metafields. Re-authorize the app then try again.';
  }
  return warning || 'Save failed.';
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
        appMetafield: metafield(namespace: "${NAMESPACE}", key: "${KEY}") {
          value
        }
        legacyMetafield: metafield(namespace: "${LEGACY_NAMESPACE}", key: "${KEY}") {
          value
        }
      }
    }`);

    const shopId = response?.result?.data?.shop?.id;
    const appRaw = response?.result?.data?.shop?.appMetafield?.value;
    const legacyRaw = response?.result?.data?.shop?.legacyMetafield?.value;
    if (!response?.ok || !shopId) {
      return {
        ok: false,
        warning:
          response?.error ||
          'Could not load checkout progress configuration.',
      };
    }

    const parseConfig = (rawValue) => {
      if (!rawValue) return null;
      try {
        const parsed = JSON.parse(rawValue);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed
          : null;
      } catch {
        return null;
      }
    };

    const appConfig = parseConfig(appRaw);
    const legacyConfig = parseConfig(legacyRaw);

    return {
      ok: true,
      shopId,
      config: appConfig || legacyConfig,
      appConfig,
      legacyConfig,
      usingLegacy: !appConfig && !!legacyConfig,
    };
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

async function clearLegacyShippingProgressMetafield(callShopify, shopId) {
  const response = await callShopify(
    `mutation ClearLegacyShippingProgress($metafields: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(identifiers: $metafields) {
        deletedMetafields { key namespace }
        userErrors { field message }
      }
    }`,
    {
      metafields: [
        {
          ownerId: shopId,
          namespace: LEGACY_NAMESPACE,
          key: KEY,
        },
      ],
    },
  );

  const userErrors = response?.result?.data?.metafieldsDelete?.userErrors || [];
  if (!response?.ok || userErrors.length > 0) {
    return {
      ok: false,
      warning:
        userErrors[0]?.message ||
        response?.error ||
        'Legacy checkout progress metafield cleanup failed.',
    };
  }

  return { ok: true };
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

  await clearLegacyShippingProgressMetafield(callShopify, shopId);

  return { ok: true, config: configObject };
}

export async function repairStockup35ShippingProgressMetafield(callShopify) {
  try {
    const current = await getShippingProgressMetafield(callShopify);
    if (!current.ok) return current;

    const config = buildShippingProgressConfig({
      id: STOCKUP35_CHECKOUT_PROGRESS.discountId,
      source: 'manual',
      value: STOCKUP35_CHECKOUT_PROGRESS.threshold,
      comparison: STOCKUP35_CHECKOUT_PROGRESS.comparison,
      promo_code: STOCKUP35_CHECKOUT_PROGRESS.promoCode,
      show_checkout_progress: true,
      checkout_progress_show_meter: true,
      checkout_progress_show_code_instruction: true,
      checkout_progress_remaining_message: STOCKUP35_CHECKOUT_PROGRESS.remainingMessage,
      checkout_progress_success_message: STOCKUP35_CHECKOUT_PROGRESS.successMessage,
      checkout_progress_code_prompt_message: STOCKUP35_CHECKOUT_PROGRESS.codePromptMessage,
      checkout_progress_code_applied_message: STOCKUP35_CHECKOUT_PROGRESS.codeAppliedMessage,
    });

    const result = await setShippingProgressMetafield(
      callShopify,
      current.shopId,
      config,
    );
    if (!result.ok) return result;

    return {
      ok: true,
      config,
      repairedFrom: {
        appThreshold: current.appConfig?.threshold ?? null,
        legacyThreshold: current.legacyConfig?.threshold ?? null,
        usingLegacy: current.usingLegacy === true,
      },
    };
  } catch (error) {
    return {
      ok: false,
      warning:
        error instanceof Error
          ? error.message
          : 'Unknown checkout progress repair error.',
    };
  }
}

export async function syncShippingProgressMetafield(callShopify, discount) {
  try {
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
