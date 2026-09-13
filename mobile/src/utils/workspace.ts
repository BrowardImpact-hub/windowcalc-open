import { FeatureFlags } from '@/types';

export function canUseHubWorkspace(
  role?: string | null,
  featureFlags?: FeatureFlags | null
): boolean {
  if (featureFlags?.hub_enabled === false) {
    return false;
  }

  const normalized = String(role || '').toLowerCase();
  return normalized === 'sysop' || normalized === 'owner' || normalized === 'manager';
}
