import { post, get, patch } from './client';
import { API_ENDPOINTS } from '@/constants/api';
import {
  AuthSession,
  DeviceInfo,
  MobileBundle,
  SyncEvent,
  Quote,
  QuotePriceBoundsResponse,
  Opening,
} from '@/types';

export const api = {
  auth: {
    createSession: (
      email: string,
      password: string,
      deviceInfo: DeviceInfo
    ): Promise<AuthSession> => {
      return post<AuthSession>(API_ENDPOINTS.AUTH.CREATE_SESSION, {
        email,
        password,
        device_id: deviceInfo.device_id,
        device_name: deviceInfo.device_name,
        platform: deviceInfo.platform,
      });
    },
  },

  mobile: {
    getBundle: (repId: string): Promise<MobileBundle> => {
      return get<MobileBundle>(API_ENDPOINTS.MOBILE.BUNDLE(repId));
    },

    syncEvents: (
      deviceId: string,
      events: SyncEvent[]
    ): Promise<{
      processed: number;
      skipped: number;
      errors: Array<{ client_event_id: string; error: string }>;
      server_time?: string;
    }> => {
      return post(API_ENDPOINTS.MOBILE.SYNC_EVENTS, {
        device_id: deviceId,
        events,
      }, { timeoutMs: 5000 });
    },
  },

  quotes: {
    get: (id: string): Promise<Quote> => {
      return get<Quote>(API_ENDPOINTS.QUOTES.GET(id));
    },

    getPriceBounds: (id: string): Promise<QuotePriceBoundsResponse> => {
      return get<QuotePriceBoundsResponse>(API_ENDPOINTS.QUOTES.PRICE_BOUNDS(id));
    },

    bulkAdjust: (
      id: string,
      pct: number
    ): Promise<{ total_price: number; openings: Opening[] }> => {
      return post(API_ENDPOINTS.QUOTES.BULK_ADJUST(id), {
        adjustment_pct: pct,
      });
    },

    generateNarrative: (id: string): Promise<{ narrative: string }> => {
      return post<{ narrative: string }>(
        API_ENDPOINTS.QUOTES.GENERATE_NARRATIVE(id),
        {}
      );
    },
  },

  openings: {
    create: (data: Partial<Opening>): Promise<Opening> => {
      return post<Opening>(API_ENDPOINTS.OPENINGS.CREATE, data as Record<string, unknown>);
    },

    patchPrice: (id: string, sellPrice: number): Promise<Opening> => {
      return patch<Opening>(API_ENDPOINTS.OPENINGS.PATCH(id), {
        sell_price: sellPrice,
      });
    },
  },
};
