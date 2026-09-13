import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '@/api/endpoints';
import { MobileBundle, Quote } from '@/types';
import { BUNDLE_CACHE_TTL_MS } from '@/constants/api';
import { OFFLINE_PRICING_ENGINE_VERSION } from '@/pricing/engine';

interface BundleStore {
  bundle: MobileBundle | null;
  lastFetchedAt: number | null;
  isLoading: boolean;
  error: string | null;
  pricingCompatible: boolean;
  pricingWarning: string | null;

  isStale: () => boolean;
  fetchBundle: (repId: string) => Promise<void>;
  refreshIfStale: (repId: string) => Promise<void>;
  getQuote: (id: string) => Quote | undefined;
  updateQuoteLocally: (quote: Partial<Quote> & { id: string }) => void;
  loadFromCache: () => Promise<void>;
}

const BUNDLE_CACHE_KEY = 'wc_bundle_cache';
const BUNDLE_TIMESTAMP_KEY = 'wc_bundle_timestamp';
const PRICING_VERSION_RECHECK_MS = 5 * 60 * 1000;

function hasRequiredPricingPayload(bundle: MobileBundle | null): boolean {
  return Boolean(
    bundle?.pricing_engine_version &&
      bundle.product_price_points !== undefined &&
      bundle.consumables !== undefined &&
      bundle.discount_tiers !== undefined
  );
}

function buildPricingWarning(bundle: MobileBundle | null): string | null {
  if (!bundle?.pricing_engine_version) {
    return 'Offline pricing pack is incomplete. Pull a fresh sync before quoting.';
  }

  if (bundle.pricing_engine_version !== OFFLINE_PRICING_ENGINE_VERSION) {
    return `Offline pricing engine ${OFFLINE_PRICING_ENGINE_VERSION} does not match bundle ${bundle.pricing_engine_version}. Refresh this device or update the app before quoting offline.`;
  }

  return null;
}

export const useBundleStore = create<BundleStore>((set, get) => ({
  bundle: null,
  lastFetchedAt: null,
  isLoading: false,
  error: null,
  pricingCompatible: false,
  pricingWarning: null,

  isStale: () => {
    const lastFetched = get().lastFetchedAt;
    const bundle = get().bundle;
    if (!lastFetched) return true;
    if (!hasRequiredPricingPayload(bundle)) return true;
    if (buildPricingWarning(bundle) && Date.now() - lastFetched > PRICING_VERSION_RECHECK_MS) {
      return true;
    }
    return Date.now() - lastFetched > BUNDLE_CACHE_TTL_MS;
  },

  loadFromCache: async () => {
    try {
      const cached = await AsyncStorage.getItem(BUNDLE_CACHE_KEY);
      const timestamp = await AsyncStorage.getItem(BUNDLE_TIMESTAMP_KEY);

      if (cached && timestamp) {
        const bundle: MobileBundle = JSON.parse(cached);
        const lastFetchedAt = parseInt(timestamp, 10);
        const pricingWarning = buildPricingWarning(bundle);

        set({
          bundle,
          lastFetchedAt,
          error: pricingWarning,
          pricingCompatible: !pricingWarning && hasRequiredPricingPayload(bundle),
          pricingWarning,
        });
      }
    } catch (error) {
      console.warn('Failed to load bundle from cache:', error);
    }
  },

  fetchBundle: async (repId: string) => {
    set({ isLoading: true, error: null });
    try {
      const bundle = await api.mobile.getBundle(repId);
      const pricingWarning = buildPricingWarning(bundle);

      const now = Date.now();
      await AsyncStorage.multiSet([
        [BUNDLE_CACHE_KEY, JSON.stringify(bundle)],
        [BUNDLE_TIMESTAMP_KEY, String(now)],
      ]);

      set({
        bundle,
        lastFetchedAt: now,
        isLoading: false,
        error: pricingWarning,
        pricingCompatible: !pricingWarning && hasRequiredPricingPayload(bundle),
        pricingWarning,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch bundle';
      set({
        isLoading: false,
        error: message,
      });
      throw error;
    }
  },

  refreshIfStale: async (repId: string) => {
    if (get().isStale()) {
      await get().fetchBundle(repId);
    }
  },

  getQuote: (id: string) => {
    const bundle = get().bundle;
    if (!bundle) return undefined;
    return bundle.quotes.find((q) => q.id === id);
  },

  updateQuoteLocally: (quote: Partial<Quote> & { id: string }) => {
    const bundle = get().bundle;
    if (!bundle) return;

    const updatedQuotes = bundle.quotes.map((q) =>
      q.id === quote.id ? { ...q, ...quote } : q
    );

    const updatedBundle: MobileBundle = {
      ...bundle,
      quotes: updatedQuotes,
    };

    // Update in-memory
    set({ bundle: updatedBundle });

    // Update cache
    AsyncStorage.setItem(BUNDLE_CACHE_KEY, JSON.stringify(updatedBundle)).catch(
      (e) => console.warn('Failed to update bundle cache:', e)
    );
  },
}));
