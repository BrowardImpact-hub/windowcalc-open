import React from 'react';
import { HubWorkspace } from '@/components/HubWorkspace';
import { RepQuoteWorkspace } from '@/components/RepQuoteWorkspace';
import { useAuthStore } from '@/store/authStore';
import { useBundleStore } from '@/store/bundleStore';
import { useDeviceProfile } from '@/hooks/useDeviceProfile';
import { canUseHubWorkspace } from '@/utils/workspace';

export default function HomeScreen() {
  const { user } = useAuthStore();
  const { isTablet } = useDeviceProfile();
  const featureFlags = useBundleStore((state) => state.bundle?.feature_flags);

  if (isTablet && canUseHubWorkspace(user?.role, featureFlags)) {
    return <HubWorkspace />;
  }

  return <RepQuoteWorkspace />;
}
