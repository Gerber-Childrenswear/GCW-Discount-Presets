import {
  Modal,
  Card,
  Badge,
} from '@shopify/polaris';
import type { Discount } from '../types';

interface PreviewDiscountModalProps {
  discount: Discount;
  onClose: () => void;
}

export function PreviewDiscountModal({
  discount,
  onClose,
}: PreviewDiscountModalProps) {
  const statusConfig: Record<string, { tone: 'info' | 'attention' | 'success' | 'new' | 'critical'; icon: string }> = {
    draft: { tone: 'info', icon: '📝' },
    scheduled: { tone: 'attention', icon: '📅' },
    active: { tone: 'success', icon: '✅' },
    paused: { tone: 'new', icon: '⏸️' },
    expired: { tone: 'critical', icon: '❌' },
  };

  const config = statusConfig[discount.status] || { tone: 'info', icon: '❓' };

  return (
    <Modal
      open
      onClose={onClose}
      title="Discount Preview"
      primaryAction={{
        content: 'Close',
        onAction: onClose,
      }}
    >
      <Modal.Section>
        <div>
          <Card>
            <div style={{ padding: '24px' }}>
              <div style={{ marginBottom: '24px' }}>
                <h2 style={{ fontSize: '28px', margin: '0 0 8px 0' }}>
                  {discount.name}
                </h2>
                <Badge tone={config.tone}>{`${config.icon} ${discount.status}`}</Badge>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                <div>
                  <p style={{ color: '#666', fontSize: '12px', textTransform: 'uppercase', margin: '0 0 4px 0' }}>
                    Discount Value
                  </p>
                  <p style={{ fontSize: '24px', fontWeight: 'bold', margin: 0 }}>
                    {discount.value}
                  </p>
                </div>

                <div>
                  <p style={{ color: '#666', fontSize: '12px', textTransform: 'uppercase', margin: '0 0 4px 0' }}>
                    Type
                  </p>
                  <p style={{ fontSize: '16px', fontWeight: 'bold', margin: 0, textTransform: 'capitalize' }}>
                    {discount.type.replace('-', ' ')}
                  </p>
                </div>

                <div>
                  <p style={{ color: '#666', fontSize: '12px', textTransform: 'uppercase', margin: '0 0 4px 0' }}>
                    Applicable To
                  </p>
                  <p style={{ fontSize: '16px', fontWeight: 'bold', margin: 0, textTransform: 'capitalize' }}>
                    {discount.applicableTo.replace('-', ' ')}
                  </p>
                </div>

                {discount.minPurchase && (
                  <div>
                    <p style={{ color: '#666', fontSize: '12px', textTransform: 'uppercase', margin: '0 0 4px 0' }}>
                      Minimum Purchase
                    </p>
                    <p style={{ fontSize: '16px', fontWeight: 'bold', margin: 0 }}>
                      ${discount.minPurchase.toFixed(2)}
                    </p>
                  </div>
                )}

                {discount.maxUses && (
                  <div>
                    <p style={{ color: '#666', fontSize: '12px', textTransform: 'uppercase', margin: '0 0 4px 0' }}>
                      Max Uses
                    </p>
                    <p style={{ fontSize: '16px', fontWeight: 'bold', margin: 0 }}>
                      {discount.maxUses}
                    </p>
                  </div>
                )}

                {discount.usageCount !== undefined && (
                  <div>
                    <p style={{ color: '#666', fontSize: '12px', textTransform: 'uppercase', margin: '0 0 4px 0' }}>
                      Current Usage
                    </p>
                    <p style={{ fontSize: '16px', fontWeight: 'bold', margin: 0 }}>
                      {discount.usageCount}
                      {discount.maxUses ? ` / ${discount.maxUses}` : ''}
                    </p>
                  </div>
                )}
              </div>

              {discount.description && (
                <div style={{ marginTop: '24px', paddingTop: '24px', borderTop: '1px solid #e5e5e5' }}>
                  <p style={{ color: '#666', fontSize: '12px', textTransform: 'uppercase', margin: '0 0 8px 0' }}>
                    Description
                  </p>
                  <p style={{ margin: 0, lineHeight: 1.5 }}>
                    {discount.description}
                  </p>
                </div>
              )}

              {(discount.scheduledFor || discount.deployedAt || discount.expiresAt) && (
                <div style={{ marginTop: '24px', paddingTop: '24px', borderTop: '1px solid #e5e5e5' }}>
                  <p style={{ color: '#666', fontSize: '12px', textTransform: 'uppercase', margin: '0 0 8px 0' }}>
                    Timeline
                  </p>
                  {discount.scheduledFor && (
                    <p style={{ margin: '4px 0', fontSize: '14px' }}>
                      📅 Scheduled: {new Date(discount.scheduledFor).toLocaleString()}
                    </p>
                  )}
                  {discount.deployedAt && (
                    <p style={{ margin: '4px 0', fontSize: '14px' }}>
                      ✅ Deployed: {new Date(discount.deployedAt).toLocaleString()}
                    </p>
                  )}
                  {discount.expiresAt && (
                    <p style={{ margin: '4px 0', fontSize: '14px' }}>
                      ⏳ Expires: {new Date(discount.expiresAt).toLocaleString()}
                    </p>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      </Modal.Section>
    </Modal>
  );
}
