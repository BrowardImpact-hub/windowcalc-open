import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Pressable,
  SafeAreaView,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { SPACING, BORDER_RADIUS } from '@/constants/theme';
import { useAuthStore } from '@/store/authStore';
import { useBundleStore } from '@/store/bundleStore';
import { useDraftStore } from '@/store/draftStore';
import { useSyncStore } from '@/store/syncStore';
import { useTheme } from '@/hooks/useTheme';
import { QuoteCard } from '@/components/QuoteCard';
import { SyncIndicator } from '@/components/SyncIndicator';
import { SunlightToggle } from '@/components/SunlightToggle';

interface RepQuoteWorkspaceProps {
  title?: string;
  subtitle?: string;
}

export function RepQuoteWorkspace({
  title,
  subtitle,
}: RepQuoteWorkspaceProps) {
  const router = useRouter();
  const { colors, isFieldMode, toggle } = useTheme();
  const [refreshing, setRefreshing] = useState(false);

  const { user } = useAuthStore();
  const {
    bundle,
    isLoading: isBundleLoading,
    pricingWarning,
    refreshIfStale,
    fetchBundle,
    loadFromCache,
  } = useBundleStore();
  const draftQuotes = useDraftStore((state) => state.quotes);
  const cacheBundleQuotes = useDraftStore((state) => state.cacheBundleQuotes);
  const { isOnline, isSyncing, pendingCount, failedCount, lastSyncTime } = useSyncStore();

  useEffect(() => {
    loadFromCache();
  }, [loadFromCache]);

  useEffect(() => {
    if (bundle?.quotes?.length) {
      cacheBundleQuotes(bundle.quotes).catch((error) => {
        console.warn('Failed to cache quote bundle locally:', error);
      });
    }
  }, [bundle, cacheBundleQuotes]);

  useFocusEffect(
    React.useCallback(() => {
      if (!user) {
        return;
      }

      refreshIfStale(user.id).catch((error) => {
        console.warn('Failed to refresh bundle:', error);
      });
    }, [user, refreshIfStale])
  );

  const handleRefresh = async () => {
    if (!user) return;

    setRefreshing(true);
    try {
      await fetchBundle(user.id);
    } catch (error) {
      console.warn('Refresh failed:', error);
    } finally {
      setRefreshing(false);
    }
  };

  const quotes = useMemo(
    () =>
      [...draftQuotes].sort((a, b) => {
        const aStamp = new Date(a.updated_at || a.created_at || 0).getTime();
        const bStamp = new Date(b.updated_at || b.created_at || 0).getTime();
        return bStamp - aStamp;
      }),
    [draftQuotes]
  );

  if (!quotes.length && isBundleLoading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color={colors.teal} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.greeting, { color: colors.textPrimary }]}>
            {title || user?.name || 'Field Rep'}
          </Text>
          <Text style={[styles.subtext, { color: colors.textMuted }]}>
            {subtitle || `${user?.role || 'rep'} | ${user?.tier || 'standard'}`}
          </Text>
        </View>
        <SunlightToggle
          isFieldMode={isFieldMode}
          onToggle={toggle}
          colors={colors}
        />
      </View>

      <View
        style={[
          styles.syncCard,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
          },
        ]}
      >
        <SyncIndicator
          isOnline={isOnline}
          isSyncing={isSyncing}
          pendingCount={pendingCount}
          failedCount={failedCount}
          lastSyncTime={lastSyncTime}
          colors={colors}
        />
      </View>

      {pricingWarning ? (
        <View
          style={[
            styles.warningCard,
            {
              backgroundColor: `${colors.red}10`,
              borderColor: colors.red,
            },
          ]}
        >
          <Text style={[styles.warningTitle, { color: colors.red }]}>Pricing update needed</Text>
          <Text style={[styles.warningText, { color: colors.textMuted }]}>{pricingWarning}</Text>
        </View>
      ) : null}

      {!quotes.length ? (
        <View style={styles.centerContent}>
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>
            No active quotes on this device yet
          </Text>
          <Pressable
            onPress={() => router.push('/(app)/new-quote')}
            style={({ pressed }) => [
              styles.createButton,
              {
                backgroundColor: colors.teal,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text style={styles.createButtonText}>Create a Quote</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={quotes}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <QuoteCard
              quote={item}
              onPress={() => router.push(`/(app)/quote/${item.id}`)}
              colors={colors}
              governance={{
                margin_floor: bundle?.governance.margin_floor || 0,
                yellow_threshold: bundle?.governance.yellow_threshold || 0,
              }}
            />
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.teal}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: SPACING.LG,
    gap: SPACING.MD,
  },
  greeting: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: SPACING.SM,
  },
  subtext: {
    fontSize: 14,
  },
  syncCard: {
    marginHorizontal: SPACING.LG,
    marginBottom: SPACING.LG,
    padding: SPACING.MD,
    borderRadius: BORDER_RADIUS.MD,
    borderWidth: 1,
  },
  warningCard: {
    marginHorizontal: SPACING.LG,
    marginBottom: SPACING.LG,
    padding: SPACING.MD,
    borderRadius: BORDER_RADIUS.MD,
    borderWidth: 1,
    gap: SPACING.XS,
  },
  warningTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  warningText: {
    fontSize: 12,
    lineHeight: 18,
  },
  listContent: {
    paddingHorizontal: SPACING.LG,
    paddingBottom: SPACING.XXL,
    gap: SPACING.MD,
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: SPACING.LG,
    paddingHorizontal: SPACING.LG,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
  },
  createButton: {
    paddingHorizontal: SPACING.LG,
    paddingVertical: SPACING.MD,
    borderRadius: BORDER_RADIUS.MD,
  },
  createButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
