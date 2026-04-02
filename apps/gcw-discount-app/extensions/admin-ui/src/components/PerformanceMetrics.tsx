import { useEffect, useState } from 'react';
import {
  Card,
  Spinner,
  DataTable,
  Banner,
} from '@shopify/polaris';
import type { Discount, PerformanceMetric } from '../types';
import { DiscountAPI } from '../api/discountApi';

interface PerformanceMetricsProps {
  discounts: Discount[];
}

export function PerformanceMetrics({ discounts }: PerformanceMetricsProps) {
  const [metrics, setMetrics] = useState<PerformanceMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const discountAPI = new DiscountAPI();

  useEffect(() => {
    loadMetrics();
  }, [discounts]);

  const loadMetrics = async () => {
    setLoading(true);
    try {
      // Load metrics for active and recently deployed discounts
      const activeDiscounts = discounts.filter(d => 
        d.status === 'active' || d.status === 'paused'
      );

      const allMetrics: PerformanceMetric[] = [];
      for (const discount of activeDiscounts) {
        try {
          const discountMetrics = await discountAPI.getPerformanceMetrics(discount.id);
          allMetrics.push(...discountMetrics);
        } catch (err) {
          // Continue loading other metrics if one fails
          console.error(`Failed to load metrics for ${discount.id}`);
        }
      }

      setMetrics(allMetrics);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <Spinner accessibilityLabel="Loading metrics" />;

  // Calculate summary metrics
  const totalImpressions = metrics.reduce((sum, m) => sum + m.impressions, 0);
  const totalConversions = metrics.reduce((sum, m) => sum + m.conversions, 0);
  const conversionRate = totalImpressions > 0 ? ((totalConversions / totalImpressions) * 100).toFixed(2) : '0';
  const totalRevenueImpact = metrics.reduce((sum, m) => sum + m.revenueImpact, 0);
  const avgOrderValue = metrics.length > 0 ? (metrics.reduce((sum, m) => sum + m.averageOrderValue, 0) / metrics.length).toFixed(2) : '0';

  // Table data
  const rows = metrics.map(metric => {
    const discount = discounts.find(d => d.id === metric.discountId);
    const ctr = metric.impressions > 0 ? ((metric.clicks / metric.impressions) * 100).toFixed(2) : '0';
    const convRate = metric.clicks > 0 ? ((metric.conversions / metric.clicks) * 100).toFixed(2) : '0';

    return [
      discount?.name || metric.discountId,
      metric.impressions.toLocaleString(),
      metric.clicks.toLocaleString(),
      `${ctr}%`,
      metric.conversions.toLocaleString(),
      `${convRate}%`,
      `$${metric.revenueImpact.toFixed(2)}`,
      `$${metric.averageOrderValue.toFixed(2)}`,
      new Date(metric.timestamp).toLocaleString(),
    ];
  });

  return (
    <>
      {error && <Banner tone="critical">{error}</Banner>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <Card>
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ color: '#666', fontSize: '12px', margin: '0 0 8px 0', textTransform: 'uppercase' }}>
              Total Impressions
            </p>
            <p style={{ fontSize: '32px', fontWeight: 'bold', margin: 0 }}>
              {totalImpressions.toLocaleString()}
            </p>
          </div>
        </Card>

        <Card>
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ color: '#666', fontSize: '12px', margin: '0 0 8px 0', textTransform: 'uppercase' }}>
              Conversion Rate
            </p>
            <p style={{ fontSize: '32px', fontWeight: 'bold', margin: 0 }}>
              {conversionRate}%
            </p>
          </div>
        </Card>

        <Card>
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ color: '#666', fontSize: '12px', margin: '0 0 8px 0', textTransform: 'uppercase' }}>
              Total Revenue Impact
            </p>
            <p style={{ fontSize: '32px', fontWeight: 'bold', margin: 0, color: '#4caf50' }}>
              ${totalRevenueImpact.toFixed(2)}
            </p>
          </div>
        </Card>

        <Card>
          <div style={{ padding: '24px', textAlign: 'center' }}>
            <p style={{ color: '#666', fontSize: '12px', margin: '0 0 8px 0', textTransform: 'uppercase' }}>
              Avg Order Value
            </p>
            <p style={{ fontSize: '32px', fontWeight: 'bold', margin: 0 }}>
              ${avgOrderValue}
            </p>
          </div>
        </Card>
      </div>

      <Card>
        <DataTable
          columnContentTypes={['text', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'numeric', 'text']}
          headings={['Discount', 'Impressions', 'Clicks', 'CTR', 'Conversions', 'Conv. Rate', 'Revenue', 'AOV', 'Last Updated']}
          rows={rows}
        />
      </Card>
    </>
  );
}
