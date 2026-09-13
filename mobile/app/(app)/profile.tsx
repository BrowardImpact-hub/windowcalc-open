import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  SafeAreaView,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SPACING, BORDER_RADIUS } from '@/constants/theme';
import { useAuthStore } from '@/store/authStore';
import { useSyncStore } from '@/store/syncStore';
import { useTheme } from '@/hooks/useTheme';
import { SunlightToggle } from '@/components/SunlightToggle';
import { getInitials, timeSince } from '@/utils/format';

const APP_VERSION = '1.0.0';

export default function ProfileScreen() {
  const router = useRouter();
  const { colors, isFieldMode, toggle } = useTheme();
  const [logoutConfirmVisible, setLogoutConfirmVisible] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const { user, logout } = useAuthStore();
  const {
    pendingCount,
    failedCount,
    lastFailedError,
    lastSyncTime,
    flushIfOnline,
    isOnline,
  } = useSyncStore();

  const handleLogout = async () => {
    try {
      await logout();
      router.replace('/(auth)/login');
    } catch (error) {
      Alert.alert('Error', 'Failed to log out.');
    }
  };

  const handleForceSync = async () => {
    setIsSyncing(true);
    try {
      const result = await flushIfOnline();
      if (result.errors.length > 0) {
        Alert.alert('Sync finished', `${result.errors.length} event(s) still need attention.`);
      } else {
        Alert.alert('Sync complete', 'All pending events were processed.');
      }
    } catch (error) {
      Alert.alert('Sync failed', 'Unable to sync pending events right now.');
    } finally {
      setIsSyncing(false);
    }
  };

  if (!user) {
    return null;
  }

  const initials = getInitials(user.name);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.avatarContainer}>
          <View
            style={[
              styles.avatar,
              {
                backgroundColor: colors.teal,
              },
            ]}
          >
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <Text style={[styles.name, { color: colors.textPrimary }]}>{user.name}</Text>
          <Text style={[styles.email, { color: colors.textMuted }]}>{user.email}</Text>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
            ACCOUNT INFO
          </Text>

          <View
            style={[
              styles.infoCard,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.textMuted }]}>Role</Text>
              <Text style={[styles.infoValue, { color: colors.textPrimary }]}>
                {user.role}
              </Text>
            </View>
            <View style={[styles.divider, { borderColor: colors.border }]} />
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.textMuted }]}>Tier</Text>
              <Text style={[styles.infoValue, { color: colors.textPrimary }]}>
                {user.tier}
              </Text>
            </View>
            <View style={[styles.divider, { borderColor: colors.border }]} />
            <View style={styles.infoRow}>
              <Text style={[styles.infoLabel, { color: colors.textMuted }]}>Tenant</Text>
              <Text style={[styles.infoValue, { color: colors.textPrimary }]}>
                {user.tenant_id.slice(0, 8)}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
            SYNC STATUS
          </Text>

          <View
            style={[
              styles.syncCard,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.syncRow}>
              <Text style={[styles.syncLabel, { color: colors.textMuted }]}>Connection</Text>
              <Text style={[styles.syncValue, { color: isOnline ? colors.green : colors.amber }]}>
                {isOnline ? 'Online' : 'Offline'}
              </Text>
            </View>
            <View style={[styles.divider, { borderColor: colors.border }]} />
            <View style={styles.syncRow}>
              <Text style={[styles.syncLabel, { color: colors.textMuted }]}>Pending Events</Text>
              <Text style={[styles.syncValue, { color: colors.textPrimary }]}>
                {pendingCount}
              </Text>
            </View>
            <View style={[styles.divider, { borderColor: colors.border }]} />
            <View style={styles.syncRow}>
              <Text style={[styles.syncLabel, { color: colors.textMuted }]}>Needs Review</Text>
              <Text style={[styles.syncValue, { color: failedCount ? colors.red : colors.textPrimary }]}>
                {failedCount}
              </Text>
            </View>
            <View style={[styles.divider, { borderColor: colors.border }]} />
            <View style={styles.syncRow}>
              <Text style={[styles.syncLabel, { color: colors.textMuted }]}>Last Sync</Text>
              <Text style={[styles.syncValue, { color: colors.textPrimary }]}>
                {lastSyncTime ? timeSince(lastSyncTime) : 'Not yet'}
              </Text>
            </View>
            {failedCount > 0 ? (
              <>
                <View style={[styles.divider, { borderColor: colors.border }]} />
                <View style={styles.syncAlert}>
                  <Text style={[styles.syncAlertTitle, { color: colors.red }]}>
                    Manager review needed
                  </Text>
                  <Text style={[styles.syncAlertText, { color: colors.textMuted }]}>
                    {lastFailedError || 'One or more events exhausted automatic retries. Review the quote and sync again after the issue is corrected.'}
                  </Text>
                </View>
              </>
            ) : null}
            <View style={[styles.divider, { borderColor: colors.border }]} />
            <Pressable
              onPress={handleForceSync}
              disabled={isSyncing}
              style={({ pressed }) => [
                styles.syncButton,
                {
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              {isSyncing ? (
                <ActivityIndicator size="small" color={colors.teal} />
              ) : (
                <Text style={[styles.syncButtonText, { color: colors.teal }]}>
                  Force Sync Now
                </Text>
              )}
            </Pressable>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
            APPEARANCE
          </Text>

          <View
            style={[
              styles.themeCard,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.themeRow}>
              <View>
                <Text style={[styles.themeLabel, { color: colors.textPrimary }]}>
                  Sunlight Mode
                </Text>
                <Text style={[styles.themeDesc, { color: colors.textMuted }]}>
                  High contrast for outdoor use
                </Text>
              </View>
              <SunlightToggle
                isFieldMode={isFieldMode}
                onToggle={toggle}
                colors={colors}
              />
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.textMuted }]}>
            APP
          </Text>

          <View
            style={[
              styles.versionCard,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <Text style={[styles.versionLabel, { color: colors.textMuted }]}>
              Version
            </Text>
            <Text style={[styles.versionValue, { color: colors.textPrimary }]}>
              {APP_VERSION}
            </Text>
          </View>
        </View>

        <Pressable
          onPress={() => setLogoutConfirmVisible(true)}
          style={({ pressed }) => [
            styles.signOutButton,
            {
              backgroundColor: colors.red,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>
      </ScrollView>

      <Modal
        transparent
        animationType="fade"
        visible={logoutConfirmVisible}
        onRequestClose={() => setLogoutConfirmVisible(false)}
      >
        <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
          <View
            style={[
              styles.dialog,
              {
                backgroundColor: colors.card,
              },
            ]}
          >
            <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>
              Sign Out?
            </Text>
            <Text style={[styles.dialogMessage, { color: colors.textMuted }]}>
              Are you sure you want to sign out?
            </Text>

            <View style={styles.dialogButtons}>
              <Pressable
                onPress={() => setLogoutConfirmVisible(false)}
                style={({ pressed }) => [
                  styles.dialogButton,
                  {
                    backgroundColor: colors.elevated,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text style={[styles.dialogButtonText, { color: colors.textPrimary }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setLogoutConfirmVisible(false);
                  handleLogout();
                }}
                style={({ pressed }) => [
                  styles.dialogButton,
                  {
                    backgroundColor: colors.red,
                    opacity: pressed ? 0.8 : 1,
                  },
                ]}
              >
                <Text style={styles.dialogButtonText}>Sign Out</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: SPACING.LG,
    gap: SPACING.XXL,
  },
  avatarContainer: {
    alignItems: 'center',
    gap: SPACING.MD,
    marginBottom: SPACING.LG,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
  },
  name: {
    fontSize: 20,
    fontWeight: '600',
  },
  email: {
    fontSize: 14,
  },
  section: {
    gap: SPACING.MD,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
  },
  infoCard: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.MD,
    gap: SPACING.SM,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.SM,
  },
  infoLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  syncCard: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.MD,
    gap: SPACING.SM,
  },
  syncRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: SPACING.SM,
  },
  syncLabel: {
    fontSize: 12,
    fontWeight: '600',
  },
  syncValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  syncButton: {
    paddingVertical: SPACING.MD,
    alignItems: 'center',
  },
  syncButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  syncAlert: {
    gap: SPACING.XS,
  },
  syncAlertTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  syncAlertText: {
    fontSize: 12,
    lineHeight: 18,
  },
  themeCard: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.MD,
  },
  themeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  themeLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: SPACING.SM,
  },
  themeDesc: {
    fontSize: 12,
  },
  versionCard: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.MD,
  },
  versionLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: SPACING.SM,
  },
  versionValue: {
    fontSize: 14,
    fontWeight: '500',
  },
  divider: {
    height: 1,
    borderBottomWidth: 1,
  },
  signOutButton: {
    height: 48,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'center',
    alignItems: 'center',
  },
  signOutText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dialog: {
    borderRadius: BORDER_RADIUS.LG,
    padding: SPACING.LG,
    width: '80%',
    gap: SPACING.MD,
  },
  dialogTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  dialogMessage: {
    fontSize: 14,
  },
  dialogButtons: {
    flexDirection: 'row',
    gap: SPACING.MD,
    marginTop: SPACING.MD,
  },
  dialogButton: {
    flex: 1,
    height: 44,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'center',
    alignItems: 'center',
  },
  dialogButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
});
