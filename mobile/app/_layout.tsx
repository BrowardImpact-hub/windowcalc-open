import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SQLite from 'expo-sqlite';
import { useAuthStore } from '@/store/authStore';
import { useDraftStore } from '@/store/draftStore';
import { useSyncStore } from '@/store/syncStore';
import { useTheme } from '@/hooks/useTheme';
import { DARK_THEME } from '@/constants/theme';

export default function RootLayout() {
  const { isAuthenticated, isLoading: authLoading, loadStoredSession } = useAuthStore();
  const { colors: themeColors, isLoading: themeLoading } = useTheme();
  const [dbReady, setDbReady] = useState(false);
  const initializeDraftDb = useDraftStore((state) => state.initialize);
  const initializeSyncDb = useSyncStore((state) => state.initialize);

  // Load auth session and initialize sync DB on app launch
  useEffect(() => {
    const initialize = async () => {
      try {
        // Load stored auth session
        await loadStoredSession();

        // Initialize sync database
        const db = await SQLite.openDatabaseAsync('windowcalc.db');
        await initializeDraftDb(db);
        await initializeSyncDb(db);

        setDbReady(true);
      } catch (e) {
        console.error('Initialization failed:', e);
        setDbReady(true); // Continue anyway
      }
    };

    initialize();
  }, [loadStoredSession, initializeDraftDb, initializeSyncDb]);

  // Show loading screen while initializing
  if (authLoading || themeLoading || !dbReady) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: DARK_THEME.background }}>
            <ActivityIndicator size="large" color={DARK_THEME.teal} />
          </View>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: {
              backgroundColor: themeColors.background,
            },
          }}
        >
          {isAuthenticated ? (
            <Stack.Screen name="(app)" />
          ) : (
            <Stack.Screen name="(auth)" />
          )}
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
