import { useState } from 'react';
import {
  Modal,
  FormLayout,
  TextField,
  Select,
  Banner,
} from '@shopify/polaris';
import type { CreateDiscountRequest, DiscountType, ApplicableTo } from '../types';

interface CreateDiscountModalProps {
  onClose: () => void;
  onCreate: (discount: CreateDiscountRequest) => Promise<void>;
}

export function CreateDiscountModal({ onClose, onCreate }: CreateDiscountModalProps) {
  const [formData, setFormData] = useState<CreateDiscountRequest>({
    name: '',
    type: 'percentage',
    value: '',
    applicableTo: 'all',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!formData.name || !formData.value) {
      setError('Name and value are required');
      return;
    }

    setLoading(true);
    try {
      await onCreate(formData);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const discountTypeOptions: Array<{ label: string; value: DiscountType }> = [
    { label: 'Percentage Off', value: 'percentage' },
    { label: 'Fixed Amount', value: 'fixed' },
    { label: 'Free Shipping', value: 'free-shipping' },
    { label: 'Buy X Get Y', value: 'buy-x-get-y' },
  ];

  const applicableToOptions: Array<{ label: string; value: ApplicableTo }> = [
    { label: 'All Products', value: 'all' },
    { label: 'Specific Products', value: 'products' },
    { label: 'Collections', value: 'collections' },
    { label: 'Customer Segment', value: 'customers' },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title="Create New Discount"
      primaryAction={{
        content: 'Create',
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
          <TextField
            label="Discount Name"
            value={formData.name}
            onChange={(value) => setFormData({ ...formData, name: value })}
            placeholder="e.g., Spring Sale 25%"
            autoComplete="off"
          />

          <TextField
            label="Description"
            value={formData.description || ''}
            onChange={(value) => setFormData({ ...formData, description: value })}
            placeholder="Optional description"
            multiline={3}
            autoComplete="off"
          />

          <Select
            label="Discount Type"
            options={discountTypeOptions}
            value={formData.type}
            onChange={(value) => setFormData({ ...formData, type: value as DiscountType })}
          />

          <TextField
            label="Value"
            value={formData.value}
            onChange={(value) => setFormData({ ...formData, value })}
            placeholder={formData.type === 'percentage' ? 'e.g., 25%' : 'e.g., $50'}
            autoComplete="off"
          />

          <Select
            label="Applicable To"
            options={applicableToOptions}
            value={formData.applicableTo}
            onChange={(value) => setFormData({ ...formData, applicableTo: value as ApplicableTo })}
          />

          {formData.applicableTo !== 'all' && (
            <TextField
              label="Target ID(s)"
              value={(formData.targetIds || []).join(', ')}
              onChange={(value) => setFormData({
                ...formData,
                targetIds: value.split(',').map(id => id.trim())
              })}
              placeholder="Comma-separated product/collection IDs"
              multiline={2}
              autoComplete="off"
            />
          )}

          <TextField
            label="Minimum Purchase (Optional)"
            value={formData.minPurchase?.toString() || ''}
            onChange={(value: string) => setFormData({
              ...formData,
              minPurchase: value ? Number(value) : undefined
            })}
            placeholder="Minimum order value to apply discount"
            type="number"
            autoComplete="off"
          />

          <TextField
            label="Maximum Uses (Optional)"
            value={formData.maxUses?.toString() || ''}
            onChange={(value: string) => setFormData({
              ...formData,
              maxUses: value ? Number(value) : undefined
            })}
            placeholder="Leave empty for unlimited"
            type="number"
            autoComplete="off"
          />
        </FormLayout>
      </Modal.Section>
    </Modal>
  );
}
