import React from 'react';

export interface CheckoutProgressValues {
  show_checkout_progress?: boolean;
  checkout_progress_starts_at?: string;
  checkout_progress_ends_at?: string;
  checkout_progress_remaining_message?: string;
  checkout_progress_success_message?: string;
}

interface Props {
  value: CheckoutProgressValues;
  threshold: number;
  onChange: (
    field: keyof CheckoutProgressValues,
    value: boolean | string,
  ) => void;
}

function toDatetimeLocalValue(value?: string) {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';

  const date = new Date(timestamp);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string) {
  if (!value) return '';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString();
}

/**
 * Renders the free-shipping checkout-progress controls.
 *
 * Visibility contract: this component must only be mounted by the caller
 * when `formData.type === 'free_shipping'` (see INTEGRATION.md).
 */
export function CheckoutFreeShippingProgressFields({
  value,
  threshold,
  onChange,
}: Props) {
  const enabled = value.show_checkout_progress === true;
  const safeThreshold = Number.isFinite(Number(threshold))
    ? Number(threshold)
    : 50;

  const startsAt = toDatetimeLocalValue(value.checkout_progress_starts_at);
  const endsAt = toDatetimeLocalValue(value.checkout_progress_ends_at);
  const scheduleInvalid = Boolean(startsAt && endsAt && startsAt >= endsAt);

  return (
    <div
      style={{
        gridColumn: '1 / -1',
        border: '1px solid #d1d5db',
        borderRadius: '8px',
        padding: '16px',
        background: '#f9fafb',
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          cursor: 'pointer',
          color: '#003968',
          fontSize: '14px',
          fontWeight: 700,
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) =>
            onChange('show_checkout_progress', event.target.checked)
          }
        />
        Show free-shipping progress in checkout
      </label>

      <p
        style={{
          margin: '8px 0 0 26px',
          color: '#6b7280',
          fontSize: '12px',
        }}
      >
        Automatically uses this Function threshold: ${safeThreshold.toFixed(2)}
      </p>

      {enabled ? (
        <div style={{ marginTop: '14px' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '12px',
            }}
          >
            <label style={{ fontSize: '12px', fontWeight: 600 }}>
              Starts showing
              <input
                type="datetime-local"
                value={startsAt}
                onChange={(event) =>
                  onChange(
                    'checkout_progress_starts_at',
                    fromDatetimeLocalValue(event.target.value),
                  )
                }
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: '4px',
                  padding: '8px',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                }}
              />
            </label>

            <label style={{ fontSize: '12px', fontWeight: 600 }}>
              Stops showing
              <input
                type="datetime-local"
                value={endsAt}
                onChange={(event) =>
                  onChange(
                    'checkout_progress_ends_at',
                    fromDatetimeLocalValue(event.target.value),
                  )
                }
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: '4px',
                  padding: '8px',
                  border: scheduleInvalid ? '1px solid #b91c1c' : '1px solid #d1d5db',
                  borderRadius: '4px',
                }}
              />
            </label>
          </div>

          <div
            aria-label="Hyper theme free-shipping progress preview"
            style={{
              marginTop: '14px',
              color: '#002744',
              fontSize: '13px',
              fontWeight: 700,
            }}
          >
            Preview: You're $12.34 away from FREE SHIPPING
            <div
              style={{
                height: '0.7rem',
                borderRadius: '3rem',
                background: 'rgba(0, 39, 68, 0.075)',
                overflow: 'hidden',
                marginTop: '8px',
              }}
            >
              <div
                style={{
                  width: '65%',
                  height: '100%',
                  borderRadius: '3rem',
                  background: '#002744',
                  transition: 'width 0.6s cubic-bezier(0.7, 0, 0.3, 1) 0.1s',
                }}
              />
            </div>
            <p style={{ margin: '6px 0 0', color: '#6b7280', fontSize: '11px', fontWeight: 400 }}>
              Matched from Hyper: color #002744, 0.7rem height, 3rem radius, subtle track, same animation timing. Checkout itself uses Shopify-safe progress primitives.
            </p>
          </div>

          {scheduleInvalid ? (
            <p style={{ margin: '8px 0 0', color: '#b91c1c', fontSize: '12px' }}>
              Stop time must be after start time. Checkout will fail closed outside a valid schedule.
            </p>
          ) : (
            <p style={{ margin: '8px 0 0', color: '#6b7280', fontSize: '12px' }}>
              Leave either field blank for no start or no end. Times are saved as UTC and checked live in checkout.
            </p>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '12px',
              marginTop: '14px',
            }}
          >
            <label style={{ fontSize: '12px', fontWeight: 600 }}>
              Remaining message
              <input
                type="text"
                maxLength={160}
                value={
                  value.checkout_progress_remaining_message ||
                  "You're {{amount}} away from FREE SHIPPING"
                }
                onChange={(event) =>
                  onChange(
                    'checkout_progress_remaining_message',
                    event.target.value,
                  )
                }
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: '4px',
                  padding: '8px',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                }}
              />
            </label>

            <label style={{ fontSize: '12px', fontWeight: 600 }}>
              Success message
              <input
                type="text"
                maxLength={160}
                value={
                  value.checkout_progress_success_message ||
                  "You've unlocked FREE SHIPPING!"
                }
                onChange={(event) =>
                  onChange(
                    'checkout_progress_success_message',
                    event.target.value,
                  )
                }
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: '4px',
                  padding: '8px',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                }}
              />
            </label>
          </div>
        </div>
      ) : null}
    </div>
  );
}
