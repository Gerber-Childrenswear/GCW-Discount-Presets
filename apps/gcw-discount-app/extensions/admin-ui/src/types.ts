export type DiscountType = 'percentage' | 'fixed' | 'free-shipping' | 'buy-x-get-y';
export type DiscountStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'expired';
export type ApplicableTo = 'all' | 'products' | 'collections' | 'customers';

export interface Discount {
  id: string;
  name: string;
  description?: string;
  type: DiscountType;
  value: string; // e.g., "25%" or "$50"
  applicableTo: ApplicableTo;
  targetIds?: string[]; // Product/Collection IDs if applicable
  customerSegment?: string;
  minPurchase?: number;
  maxUses?: number;
  usageCount?: number;
  status: DiscountStatus;
  scheduledFor?: string; // ISO date
  deployedAt?: string; // ISO date
  expiresAt?: string; // ISO date
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, any>;
}

export interface CreateDiscountRequest {
  name: string;
  description?: string;
  type: DiscountType;
  value: string;
  applicableTo: ApplicableTo;
  targetIds?: string[];
  customerSegment?: string;
  minPurchase?: number;
  maxUses?: number;
}

export interface ScheduleDiscountRequest {
  scheduledFor: string; // ISO date
  expiresAt?: string;
}

export interface PerformanceMetric {
  discountId: string;
  impressions: number;
  clicks: number;
  conversions: number;
  revenueImpact: number;
  averageOrderValue: number;
  timestamp: string;
}

export interface DiscountStats {
  active: number;
  scheduled: number;
  paused: number;
  totalValue: number;
  averageUsage: number;
}
