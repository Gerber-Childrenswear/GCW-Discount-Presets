import { useState } from 'react';
import {
  Modal,
  FormLayout,
  TextField,
  Card,
  Banner,
  Checkbox,
} from '@shopify/polaris';
import type { Discount, ScheduleDiscountRequest } from '../types';

// Helper functions to replace date-fns
const toISOString = (date: Date) => date.toISOString();
const addDays = (date: Date, days: number) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

interface ScheduleDiscountModalProps {
  discount: Discount;
  onClose: () => void;
  onSchedule: (schedule: ScheduleDiscountRequest) => Promise<void>;
}

export function ScheduleDiscountModal({
  discount,
  onClose,
  onSchedule,
}: ScheduleDiscountModalProps) {
  const now = new Date();
  const nextDay = addDays(now, 1);
  const defaultExpire = addDays(nextDay, 30);

  const [formData, setFormData] = useState<ScheduleDiscountRequest>({
    scheduledFor: toISOString(nextDay),
    expiresAt: toISOString(defaultExpire),
  });

  const [hasExpiration, setHasExpiration] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!formData.scheduledFor) {
      setError('Please select a deployment time');
      return;
    }

    if (new Date(formData.scheduledFor) <= now) {
      setError('Deployment time must be in the future');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        scheduledFor: formData.scheduledFor,
        ...(hasExpiration && { expiresAt: formData.expiresAt }),
      };
      await onSchedule(payload);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Schedule Discount Deployment"
      primaryAction={{
        content: 'Schedule',
        onAction: handleSubmit,
        loading,
      }}
      secondaryActions={[
        {
          content: 'Cancel',
          onAction: onClose,
        },
      ]}
    >
      <Modal.Section>
        {error && <Banner tone="critical">{error}</Banner>}

        <FormLayout>
          <Card>
            <div style={{ padding: '16px' }}>
              <p style={{ marginBottom: '16px', fontWeight: 'bold' }}>
                Discount: {discount.name}
              </p>
              <p style={{ marginBottom: '16px', color: '#666' }}>
                Value: {discount.value} | Applicable to: {discount.applicableTo}
              </p>
            </div>
          </Card>

          <TextField
            label="Deploy At (Date & Time)"
            type="datetime-local"
            value={formData.scheduledFor.slice(0, 16)}
            onChange={(value) => {
              const date = new Date(value);
              setFormData({
                ...formData,
                scheduledFor: toISOString(date),
              });
            }}
            helpText="When should this discount go live?"
            autoComplete="off"
          />

          <Checkbox
            label="Set Expiration Date"
            checked={hasExpiration}
            onChange={setHasExpiration}
          />

          {hasExpiration && (
            <TextField
              label="Expires At (Date & Time)"
              type="datetime-local"
              value={formData.expiresAt?.slice(0, 16) || ''}
              onChange={(value) => {
                const date = new Date(value);
                setFormData({
                  ...formData,
                  expiresAt: toISOString(date),
                });
              }}
              helpText="When should this discount end?"
              autoComplete="off"
            />
          )}

          <Card>
            <div style={{ padding: '16px', backgroundColor: '#f5f5f5', borderRadius: '4px' }}>
              <p style={{ fontWeight: 'bold', marginBottom: '8px' }}>Preview:</p>
              <p>• Deploys: {new Date(formData.scheduledFor).toLocaleString()}</p>
              {hasExpiration && (
                <p>• Expires: {new Date(formData.expiresAt || '').toLocaleString()}</p>
              )}
              <p style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
                Sentry will track deployment status and any errors
              </p>
            </div>
          </Card>
        </FormLayout>
      </Modal.Section>
    </Modal>
  );
}
