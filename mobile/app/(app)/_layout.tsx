import React, { useEffect } from 'react';
import { Text } from 'react-native';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/hooks/useTheme';
import { useAuthStore } from '@/store/authStore';
import { useBundleStore } from '@/store/bundleStore';
import { useDeviceProfile } from '@/hooks/useDeviceProfile';
import { canUseHubWorkspace } from '@/utils/workspace';

function TabGlyph({ label, color }: { label: string; color: string }) {
  return <Text style={{ fontSize: 18, color, fontWeight: '700' }}>{label}</Text>;
}

export default function AppLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { user } = useAuthStore();
  const featureFlags = useBundleStore((state) => state.bundle?.feature_flags);
  const loadFromCache = useBundleStore((state) => state.loadFromCache);
  const { isTablet } = useDeviceProfile();

  useEffect(() => {
    loadFromCache().catch((error) => {
      console.warn('Failed to load mobile bundle cache for layout:', error);
    });
  }, [loadFromCache]);

  const showHubTabs = isTablet && canUseHubWorkspace(user?.role, featureFlags);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.teal,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          paddingBottom: insets.bottom,
          paddingTop: 8,
          height: 68 + insets.bottom,
        },
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '600',
          marginBottom: 4,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: showHubTabs ? 'Hub' : 'Quotes',
          tabBarLabel: showHubTabs ? 'Hub' : 'Quotes',
          tabBarIcon: ({ color }) => (
            <TabGlyph label={showHubTabs ? 'H' : 'Q'} color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="quotes"
        options={{
          href: showHubTabs ? undefined : null,
          title: 'Quotes',
          tabBarLabel: 'Quotes',
          tabBarIcon: ({ color }) => (
            <TabGlyph label="Q" color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="new-quote"
        options={{
          title: 'New Quote',
          tabBarLabel: 'New',
          tabBarIcon: ({ color }) => (
            <TabGlyph label="+" color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarLabel: 'Profile',
          tabBarIcon: ({ color }) => (
            <TabGlyph label="P" color={color} />
          ),
        }}
      />

      <Tabs.Screen
        name="add-opening/[quoteId]"
        options={{
          href: null,
        }}
      />

      <Tabs.Screen
        name="quote/[id]"
        options={{
          href: null,
        }}
      />
    </Tabs>
  );
}
