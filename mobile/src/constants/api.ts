export const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE_URL || 'https://windowcalc.example.com';

export const BUNDLE_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export const MOBILE_SYNC_BATCH_SIZE = 50;

export const API_ENDPOINTS = {
  AUTH: {
    CREATE_SESSION: '/api/mobile/sessions',
  },
  MOBILE: {
    BUNDLE: (repId: string) => `/api/mobile/bundle/${repId}`,
    SYNC_EVENTS: '/api/mobile/sync/events',
  },
  QUOTES: {
    GET: (id: string) => `/api/quotes/${id}`,
    PRICE_BOUNDS: (id: string) => `/api/quotes/${id}/price-bounds`,
    BULK_ADJUST: (id: string) => `/api/quotes/${id}/bulk-adjust`,
    GENERATE_NARRATIVE: (id: string) => `/api/quotes/${id}/generate-narrative`,
  },
  OPENINGS: {
    CREATE: '/api/openings',
    PATCH: (id: string) => `/api/openings/${id}`,
  },
};

export const RETRY_CONFIG = {
  MAX_ATTEMPTS: 3,
  INITIAL_DELAY_MS: 1000,
  MAX_DELAY_MS: 10000,
};
