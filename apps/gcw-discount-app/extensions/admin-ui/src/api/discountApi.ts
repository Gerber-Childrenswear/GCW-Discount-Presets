import type {
  Discount,
  CreateDiscountRequest,
  ScheduleDiscountRequest,
  PerformanceMetric,
} from '../types';

const API_BASE_URL = '/api';

async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.statusText}`);
  }

  return response.json();
}

export class DiscountAPI {
  async listDiscounts(): Promise<Discount[]> {
    try {
      return await fetchJSON<Discount[]>('/discounts');
    } catch (error) {
      throw new Error('Failed to load discounts');
    }
  }

  async getDiscount(id: string): Promise<Discount> {
    try {
      return await fetchJSON<Discount>(`/discounts/${id}`);
    } catch (error) {
      throw new Error('Failed to load discount');
    }
  }

  async createDiscount(data: CreateDiscountRequest): Promise<Discount> {
    try {
      return await fetchJSON<Discount>('/discounts', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    } catch (error) {
      throw new Error('Failed to create discount');
    }
  }

  async updateDiscount(id: string, data: Partial<CreateDiscountRequest>): Promise<Discount> {
    try {
      return await fetchJSON<Discount>(`/discounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      });
    } catch (error) {
      throw new Error('Failed to update discount');
    }
  }

  async scheduleDiscount(id: string, data: ScheduleDiscountRequest): Promise<Discount> {
    try {
      return await fetchJSON<Discount>(`/discounts/${id}/schedule`, {
        method: 'POST',
        body: JSON.stringify(data),
      });
    } catch (error) {
      throw new Error('Failed to schedule discount');
    }
  }

  async pauseDiscount(id: string): Promise<Discount> {
    try {
      return await fetchJSON<Discount>(`/discounts/${id}/pause`, {
        method: 'POST',
      });
    } catch (error) {
      throw new Error('Failed to pause discount');
    }
  }

  async resumeDiscount(id: string): Promise<Discount> {
    try {
      return await fetchJSON<Discount>(`/discounts/${id}/resume`, {
        method: 'POST',
      });
    } catch (error) {
      throw new Error('Failed to resume discount');
    }
  }

  async deleteDiscount(id: string): Promise<void> {
    try {
      await fetch(`${API_BASE_URL}/discounts/${id}`, {
        method: 'DELETE',
      });
    } catch (error) {
      throw new Error('Failed to delete discount');
    }
  }

  async getPerformanceMetrics(id: string): Promise<PerformanceMetric[]> {
    try {
      return await fetchJSON<PerformanceMetric[]>(`/discounts/${id}/metrics`);
    } catch (error) {
      throw new Error('Failed to load performance metrics');
    }
  }

  async deployDiscount(id: string): Promise<Discount> {
    try {
      return await fetchJSON<Discount>(`/discounts/${id}/deploy`, {
        method: 'POST',
      });
    } catch (error) {
      throw new Error('Failed to deploy discount');
    }
  }
}
