import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  SafeAreaView,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { SPACING, BORDER_RADIUS } from '@/constants/theme';
import { useAuthStore } from '@/store/authStore';
import { useBundleStore } from '@/store/bundleStore';
import { useDraftStore } from '@/store/draftStore';
import { useSyncStore } from '@/store/syncStore';
import { useTheme } from '@/hooks/useTheme';
import { useDeviceProfile } from '@/hooks/useDeviceProfile';
import { QuoteCard } from '@/components/QuoteCard';
import { fmtMoney } from '@/utils/format';

function HubMetric({
  label,
  value,
  hint,
  colors,
}: {
  label: string;
  value: string;
  hint: string;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  return (
    <View
      style={[
        styles.metricCard,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
        },
      ]}
    >
      <Text style={[styles.metricLabel, { color: colors.textMuted }]}>{label}</Text>
      <Text style={[styles.metricValue, { color: colors.textPrimary }]}>{value}</Text>
      <Text style={[styles.metricHint, { color: colors.textMuted }]}>{hint}</Text>
    </View>
  );
}

export function HubWorkspace() {
  const router = useRouter();
  const { user } = useAuthStore();
  const [refreshing, setRefreshing] = useState(false);
  const {
    bundle,
    isLoading: isBundleLoading,
    loadFromCache,
    refreshIfStale,
    fetchBundle,
  } = useBundleStore();
  const draftQuotes = useDraftStore((state) => state.quotes);
  const { pendingCount, failedCount, isOnline, lastSyncTime } = useSyncStore();
  const { colors } = useTheme();
  const { supportsTwoPane, isLargeTablet } = useDeviceProfile();

  useEffect(() => {
    loadFromCache();
  }, [loadFromCache]);

  useFocusEffect(
    React.useCallback(() => {
      if (!user) {
        return;
      }

      refreshIfStale(user.id).catch((error) => {
        console.warn('Failed to refresh hub bundle:', error);
      });
    }, [user, refreshIfStale])
  );

  const hubQuotes = useMemo(() => {
    const merged = new Map<string, (typeof draftQuotes)[number]>();

    for (const quote of bundle?.quotes || []) {
      merged.set(quote.id, quote);
    }
    for (const quote of draftQuotes) {
      merged.set(quote.id, {
        ...merged.get(quote.id),
        ...quote,
      });
    }

    return [...merged.values()].sort((a, b) => {
      const aStamp = new Date(a.updated_at || a.created_at || 0).getTime();
      const bStamp = new Date(b.updated_at || b.created_at || 0).getTime();
      return bStamp - aStamp;
    });
  }, [bundle?.quotes, draftQuotes]);

  const activeQuotes = hubQuotes.filter((quote) => quote.status !== 'completed').length;
  const pendingApprovals = hubQuotes.filter((quote) => quote.status === 'pending_approval').length;
  const offlineDrafts = draftQuotes.filter((quote) => quote.sync_state !== 'synced').length;
  const pipelineValue = hubQuotes.reduce((sum, quote) => sum + Number(quote.total_price || 0), 0);
  const recentQuotes = hubQuotes.slice(0, 4);
  const hubScope = bundle?.quote_scope === 'tenant' ? 'tenant' : 'rep';

  const handleRefresh = async () => {
    if (!user) {
      return;
    }

    setRefreshing(true);
    try {
      await fetchBundle(user.id);
    } catch (error) {
      console.warn('Hub refresh failed:', error);
    } finally {
      setRefreshing(false);
    }
  };

  if (!hubQuotes.length && isBundleLoading) {
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
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.teal}
          />
        }
      >
        <View
          style={[
            styles.heroRow,
            supportsTwoPane ? styles.heroRowWide : null,
          ]}
        >
          <View style={[styles.heroCopy, supportsTwoPane ? styles.heroCopyWide : null]}>
            <Text style={[styles.heroEyebrow, { color: colors.teal }]}>Hub Workspace</Text>
            <Text style={[styles.heroTitle, { color: colors.textPrimary }]}>
              {user?.name || 'Leadership'} control center
            </Text>
            <Text style={[styles.heroText, { color: colors.textMuted }]}>
              Tablet mode is now set up as the manager and owner shell. It keeps field activity, approvals,
              and sync health in one place while we build the deeper two-pane hub screens next.
            </Text>
          </View>

          <View
            style={[
              styles.statusPanel,
              supportsTwoPane ? styles.statusPanelWide : null,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <Text style={[styles.statusTitle, { color: colors.textPrimary }]}>Field status</Text>
            <Text style={[styles.statusLine, { color: isOnline ? colors.green : colors.amber }]}>
              {isOnline ? 'Fleet online-ready' : 'Offline mode active'}
            </Text>
            <Text style={[styles.statusSubline, { color: colors.textMuted }]}>
              {pendingCount} pending sync event{pendingCount === 1 ? '' : 's'}
            </Text>
            {failedCount > 0 ? (
              <Text style={[styles.statusSubline, { color: colors.red }]}>
                {failedCount} item{failedCount === 1 ? '' : 's'} need manager review
              </Text>
            ) : null}
            <Text style={[styles.statusSubline, { color: colors.textMuted }]}>
              Last sync: {lastSyncTime ? lastSyncTime : 'not yet'}
            </Text>
            <Text style={[styles.statusFootnote, { color: colors.textMuted }]}>
              {supportsTwoPane
                ? 'This tablet is wide enough for the coming split-view hub layout.'
                : 'This tablet shell will stay stacked until we add the larger split-view layout.'}
            </Text>
          </View>
        </View>

        <View style={styles.metricsGrid}>
          <HubMetric
            label="Active Quotes"
            value={String(activeQuotes)}
            hint={hubScope === 'tenant' ? 'Open work across the current tenant bundle' : 'Open work across this rep bundle'}
            colors={colors}
          />
          <HubMetric
            label="Pending Approval"
            value={String(pendingApprovals)}
            hint="Needs manager or owner attention"
            colors={colors}
          />
          <HubMetric
            label="Pending Sync"
            value={String(offlineDrafts)}
            hint="Locally changed quotes still waiting"
            colors={colors}
          />
          <HubMetric
            label="Pipeline Value"
            value={fmtMoney(pipelineValue)}
            hint={hubScope === 'tenant' ? 'Tenant-visible active quote volume' : 'Rep-visible active quote volume'}
            colors={colors}
          />
        </View>

        <View
          style={[
            styles.twoColumnRow,
            supportsTwoPane ? styles.twoColumnRowWide : null,
          ]}
        >
          <View
            style={[
              styles.sectionCard,
              supportsTwoPane ? styles.sectionCardWide : null,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Quick actions</Text>
            <View style={styles.quickActionGrid}>
              <Pressable
                onPress={() => router.push('/(app)/quotes')}
                style={({ pressed }) => [
                  styles.quickAction,
                  {
                    backgroundColor: colors.elevated,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text style={[styles.quickActionTitle, { color: colors.textPrimary }]}>Review Quotes</Text>
                <Text style={[styles.quickActionText, { color: colors.textMuted }]}>
                  Open the field quote list with draft and sync status.
                </Text>
              </Pressable>
              <Pressable
                onPress={() => router.push('/(app)/new-quote')}
                style={({ pressed }) => [
                  styles.quickAction,
                  {
                    backgroundColor: colors.elevated,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text style={[styles.quickActionTitle, { color: colors.textPrimary }]}>Start Quote</Text>
                <Text style={[styles.quickActionText, { color: colors.textMuted }]}>
                  Create a fresh field quote draft from the tablet shell.
                </Text>
              </Pressable>
              <Pressable
                onPress={() => router.push('/(app)/profile')}
                style={({ pressed }) => [
                  styles.quickAction,
                  {
                    backgroundColor: colors.elevated,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text style={[styles.quickActionTitle, { color: colors.textPrimary }]}>Sync Center</Text>
                <Text style={[styles.quickActionText, { color: colors.textMuted }]}>
                  Check connection state and force-sync from the profile screen.
                </Text>
              </Pressable>
            </View>
          </View>

          <View
            style={[
              styles.sectionCard,
              supportsTwoPane ? styles.sectionCardWide : null,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Hub roadmap now unlocked</Text>
            <View style={styles.roadmapList}>
              <Text style={[styles.roadmapItem, { color: colors.textMuted }]}>
                1. Split-view approvals and live chat for tablet managers.
              </Text>
              <Text style={[styles.roadmapItem, { color: colors.textMuted }]}>
                2. Tablet pipeline board and report drill-downs.
              </Text>
              <Text style={[styles.roadmapItem, { color: colors.textMuted }]}>
                3. Rep activity feed with route packs and offline exceptions.
              </Text>
              <Text style={[styles.roadmapItem, { color: colors.textMuted }]}>
                4. Domain, Twilio, and store release hardening after device SDK setup.
              </Text>
            </View>
            <View
              style={[
                styles.noteBox,
                {
                  backgroundColor: isLargeTablet ? `${colors.teal}12` : `${colors.amber}14`,
                  borderColor: isLargeTablet ? `${colors.teal}40` : `${colors.amber}40`,
                },
              ]}
            >
              <Text
                style={[
                  styles.noteText,
                  {
                    color: isLargeTablet ? colors.teal : colors.amber,
                  },
                ]}
              >
                {isLargeTablet
                  ? 'This device profile is strong enough for the promoted tablet hub experience.'
                  : 'This profile still works, but the premium hub layout will feel best on larger tablets.'}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.recentSection}>
          <View style={styles.recentHeader}>
            <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Recent quote activity</Text>
            <Pressable onPress={() => router.push('/(app)/quotes')}>
              <Text style={[styles.linkText, { color: colors.teal }]}>Open full list</Text>
            </Pressable>
          </View>

          {recentQuotes.length ? (
            recentQuotes.map((quote) => (
              <QuoteCard
                key={quote.id}
                quote={quote}
                onPress={() => router.push(`/(app)/quote/${quote.id}`)}
                colors={colors}
                governance={{
                  margin_floor: bundle?.governance.margin_floor || 0,
                  yellow_threshold: bundle?.governance.yellow_threshold || 0,
                }}
              />
            ))
          ) : (
            <View
              style={[
                styles.emptyState,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                },
              ]}
            >
              <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
                {hubScope === 'tenant' ? 'No tenant quote activity yet' : 'No rep quote activity yet'}
              </Text>
              <Text style={[styles.emptyText, { color: colors.textMuted }]}>
                {hubScope === 'tenant'
                  ? 'Pull the bundle online so this tablet can load the current tenant pipeline.'
                  : 'Pull the bundle online or create the first quote from this device to seed the hub workspace.'}
              </Text>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: SPACING.LG,
    gap: SPACING.LG,
    paddingBottom: SPACING.XXL,
  },
  heroRow: {
    gap: SPACING.LG,
  },
  heroRowWide: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  heroCopy: {
    gap: SPACING.SM,
  },
  heroCopyWide: {
    flex: 1.25,
  },
  heroEyebrow: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: '700',
  },
  heroText: {
    fontSize: 15,
    lineHeight: 22,
    maxWidth: 760,
  },
  statusPanel: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.LG,
    gap: SPACING.SM,
  },
  statusPanelWide: {
    flex: 0.85,
  },
  statusTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  statusLine: {
    fontSize: 14,
    fontWeight: '700',
  },
  statusSubline: {
    fontSize: 13,
  },
  statusFootnote: {
    fontSize: 12,
    lineHeight: 18,
    marginTop: SPACING.SM,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.MD,
  },
  metricCard: {
    minWidth: 160,
    flexGrow: 1,
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.MD,
    gap: SPACING.SM,
  },
  metricLabel: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  metricValue: {
    fontSize: 26,
    fontWeight: '700',
  },
  metricHint: {
    fontSize: 12,
    lineHeight: 18,
  },
  twoColumnRow: {
    gap: SPACING.MD,
  },
  twoColumnRowWide: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  sectionCard: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.LG,
    gap: SPACING.MD,
  },
  sectionCardWide: {
    flex: 1,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  quickActionGrid: {
    gap: SPACING.MD,
  },
  quickAction: {
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
    gap: SPACING.SM,
  },
  quickActionTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  quickActionText: {
    fontSize: 13,
    lineHeight: 18,
  },
  roadmapList: {
    gap: SPACING.SM,
  },
  roadmapItem: {
    fontSize: 13,
    lineHeight: 18,
  },
  noteBox: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
  },
  noteText: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
  },
  recentSection: {
    gap: SPACING.MD,
  },
  recentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  linkText: {
    fontSize: 13,
    fontWeight: '700',
  },
  centerContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.LG,
  },
  emptyState: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.LG,
    gap: SPACING.SM,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  emptyText: {
    fontSize: 13,
    lineHeight: 18,
  },
});
