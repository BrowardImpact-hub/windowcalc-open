import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  SafeAreaView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SPACING, BORDER_RADIUS } from '@/constants/theme';
import { useTheme } from '@/hooks/useTheme';
import { useDraftStore } from '@/store/draftStore';
import { useSyncStore } from '@/store/syncStore';

export default function NewQuoteScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const [isLoading, setIsLoading] = useState(false);
  const createQuoteDraft = useDraftStore((state) => state.createQuoteDraft);
  const { enqueueEvent, flushIfOnline } = useSyncStore();

  const [formData, setFormData] = useState({
    customerName: '',
    address: '',
    phone: '',
    notes: '',
  });

  const handleNext = async () => {
    if (!formData.customerName.trim() || !formData.address.trim()) {
      Alert.alert('Required fields', 'Please enter customer name and address.');
      return;
    }

    setIsLoading(true);

    try {
      const quote = await createQuoteDraft({
        customer_name: formData.customerName,
        customer_phone: formData.phone,
        job_address: formData.address,
        notes: formData.notes,
      });

      await enqueueEvent(
        'quote_create',
        {
          quote_id: quote.id,
          customer_name: quote.customer_name,
          customer_phone: quote.customer_phone || null,
          job_address: quote.job_address,
          notes: quote.notes || null,
          status: quote.status,
        },
        { type: 'quote', id: quote.id }
      );

      await flushIfOnline().catch(() => {
        // Staying quiet here is intentional: local draft is the fallback.
      });

      router.push({
        pathname: '/(app)/add-opening/[quoteId]',
        params: { quoteId: quote.id },
      });
    } catch (error) {
      Alert.alert('Error', 'Failed to save quote draft on this device.');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={[styles.title, { color: colors.textPrimary }]}>New Quote</Text>

          <View style={styles.inputSection}>
            <Text style={[styles.label, { color: colors.textPrimary }]}>
              Customer Name *
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.textPrimary,
                },
              ]}
              placeholder="John Smith"
              placeholderTextColor={colors.textMuted}
              value={formData.customerName}
              onChangeText={(text) =>
                setFormData({ ...formData, customerName: text })
              }
              editable={!isLoading}
            />
          </View>

          <View style={styles.inputSection}>
            <Text style={[styles.label, { color: colors.textPrimary }]}>
              Property Address *
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.textPrimary,
                },
              ]}
              placeholder="123 Main St, Miami, FL 33101"
              placeholderTextColor={colors.textMuted}
              value={formData.address}
              onChangeText={(text) =>
                setFormData({ ...formData, address: text })
              }
              editable={!isLoading}
            />
            <Pressable
              onPress={() =>
                Alert.alert(
                  'Maps verification',
                  'Address verification will be added once the field mapping flow is wired into the mobile draft system.'
                )
              }
              style={({ pressed }) => [
                styles.verifyButton,
                {
                  backgroundColor: colors.elevated,
                  opacity: pressed ? 0.8 : 1,
                },
              ]}
            >
              <Text style={[styles.verifyButtonText, { color: colors.teal }]}>
                Verify with Maps
              </Text>
            </Pressable>
          </View>

          <View style={styles.inputSection}>
            <Text style={[styles.label, { color: colors.textPrimary }]}>
              Phone (Optional)
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.textPrimary,
                },
              ]}
              placeholder="(305) 555-0100"
              placeholderTextColor={colors.textMuted}
              keyboardType="phone-pad"
              value={formData.phone}
              onChangeText={(text) =>
                setFormData({ ...formData, phone: text })
              }
              editable={!isLoading}
            />
          </View>

          <View style={styles.inputSection}>
            <Text style={[styles.label, { color: colors.textPrimary }]}>
              Notes (Optional)
            </Text>
            <TextInput
              style={[
                styles.input,
                styles.notesInput,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.textPrimary,
                },
              ]}
              placeholder="Any special details..."
              placeholderTextColor={colors.textMuted}
              multiline
              numberOfLines={4}
              value={formData.notes}
              onChangeText={(text) =>
                setFormData({ ...formData, notes: text })
              }
              editable={!isLoading}
            />
          </View>

          <Pressable
            onPress={handleNext}
            disabled={isLoading}
            style={({ pressed }) => [
              styles.nextButton,
              {
                backgroundColor: colors.teal,
                opacity:
                  isLoading ||
                  !formData.customerName.trim() ||
                  !formData.address.trim()
                    ? 0.6
                    : pressed
                    ? 0.8
                    : 1,
              },
            ]}
          >
            {isLoading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.nextButtonText}>Next: Add Openings</Text>
            )}
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  content: {
    padding: SPACING.LG,
    gap: SPACING.LG,
    paddingBottom: SPACING.HUGE,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: SPACING.LG,
  },
  inputSection: {
    gap: SPACING.SM,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
    fontSize: 16,
  },
  notesInput: {
    textAlignVertical: 'top',
  },
  verifyButton: {
    marginTop: SPACING.SM,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
    alignItems: 'center',
  },
  verifyButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  nextButton: {
    height: 48,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: SPACING.LG,
  },
  nextButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
