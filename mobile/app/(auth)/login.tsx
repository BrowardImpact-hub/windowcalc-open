import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import * as LocalAuthentication from 'expo-local-authentication';
import { SPACING, BORDER_RADIUS, COLORS, DARK_THEME, SHADOWS } from '@/constants/theme';
import { useAuthStore } from '@/store/authStore';
import { useTheme } from '@/hooks/useTheme';

export default function LoginScreen() {
  const { colors } = useTheme();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [errorSlideAnim] = useState(new Animated.Value(0));
  const [biometricTried, setBiometricTried] = useState(false);

  const { login, isLoading, error, clearError, token, isAuthenticated } = useAuthStore();

  // Check biometric availability
  useEffect(() => {
    const checkBiometrics = async () => {
      try {
        const compatible = await LocalAuthentication.hasHardwareAsync();
        const enrolled = await LocalAuthentication.isEnrolledAsync();
        setBiometricAvailable(compatible && enrolled && token !== null);
      } catch (e) {
        console.warn('Failed to check biometrics:', e);
      }
    };

    checkBiometrics();
  }, [token]);

  // Animate error message
  useEffect(() => {
    if (error) {
      Animated.spring(errorSlideAnim, {
        toValue: 1,
        useNativeDriver: true,
      }).start();

      const timer = setTimeout(() => {
        Animated.timing(errorSlideAnim, {
          toValue: 0,
          duration: 500,
          useNativeDriver: true,
        }).start();
        clearError();
      }, 5000);

      return () => clearTimeout(timer);
    }
  }, [error, errorSlideAnim, clearError]);

  const handleLogin = async () => {
    if (!email || !password) {
      return;
    }

    try {
      await login(email, password);
    } catch (e) {
      // Error is handled by store
    }
  };

  const handleBiometricLogin = async () => {
    try {
      setBiometricTried(true);
      await LocalAuthentication.authenticateAsync({
        disableDeviceFallback: false,
      });
      // If successful, we already have token from previous login
      // This would trigger navigation in app root
    } catch (e) {
      console.warn('Biometric auth failed:', e);
      setBiometricTried(false);
    }
  };

  if (isAuthenticated) {
    return null; // Will redirect from app root
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Logo */}
        <View style={styles.logoContainer}>
          <Text style={[styles.logo, { color: colors.teal }]}>WC</Text>
          <Text style={[styles.logoText, { color: colors.textPrimary }]}>WindowCalc Field</Text>
        </View>

        {/* Email Input */}
        <View style={styles.inputContainer}>
          <Text style={[styles.label, { color: colors.textPrimary }]}>Email</Text>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                color: colors.textPrimary,
              },
            ]}
            placeholder="you@company.com"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={email}
            onChangeText={(text) => setEmail(text.toLowerCase())}
            editable={!isLoading}
          />
        </View>

        {/* Password Input */}
        <View style={styles.inputContainer}>
          <Text style={[styles.label, { color: colors.textPrimary }]}>Password</Text>
          <View
            style={[
              styles.passwordContainer,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
              },
            ]}
          >
            <TextInput
              style={[
                styles.passwordInput,
                {
                  color: colors.textPrimary,
                },
              ]}
              placeholder="••••••••"
              placeholderTextColor={colors.textMuted}
              secureTextEntry={!showPassword}
              value={password}
              onChangeText={setPassword}
              editable={!isLoading}
            />
            <Pressable
              onPress={() => setShowPassword(!showPassword)}
              style={styles.eyeButton}
            >
              <Text style={{ fontSize: 18 }}>{showPassword ? '👁️' : '👁️‍🗨️'}</Text>
            </Pressable>
          </View>
        </View>

        {/* Error Message */}
        {error && (
          <Animated.View
            style={[
              styles.errorContainer,
              {
                backgroundColor: colors.red,
                transform: [
                  {
                    translateY: errorSlideAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-50, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <Text style={styles.errorText}>{error}</Text>
          </Animated.View>
        )}

        {/* Sign In Button */}
        <Pressable
          onPress={handleLogin}
          disabled={isLoading || !email || !password}
          style={({ pressed }) => [
            styles.signInButton,
            {
              backgroundColor: colors.teal,
              opacity: isLoading || !email || !password ? 0.6 : pressed ? 0.8 : 1,
            },
          ]}
        >
          {isLoading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.signInText}>Sign In</Text>
          )}
        </Pressable>

        {/* Biometric Option */}
        {biometricAvailable && !biometricTried && (
          <Pressable
            onPress={handleBiometricLogin}
            style={({ pressed }) => [
              styles.biometricButton,
              {
                backgroundColor: colors.card,
                borderColor: colors.border,
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text style={{ fontSize: 24 }}>🔐</Text>
            <Text style={[styles.biometricText, { color: colors.textPrimary }]}>
              Use Biometrics
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: SPACING.LG,
    gap: SPACING.XL,
  },
  logoContainer: {
    alignItems: 'center',
    gap: SPACING.MD,
    marginBottom: SPACING.HUGE,
  },
  logo: {
    fontSize: 80,
    fontWeight: '700',
  },
  logoText: {
    fontSize: 20,
    fontWeight: '600',
  },
  inputContainer: {
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
  passwordContainer: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    alignItems: 'center',
  },
  passwordInput: {
    flex: 1,
    padding: SPACING.MD,
    fontSize: 16,
  },
  eyeButton: {
    paddingRight: SPACING.MD,
    padding: SPACING.SM,
  },
  errorContainer: {
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.MD,
  },
  errorText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  signInButton: {
    height: 48,
    borderRadius: BORDER_RADIUS.MD,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: SPACING.MD,
  },
  signInText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  biometricButton: {
    borderWidth: 1,
    borderRadius: BORDER_RADIUS.MD,
    padding: SPACING.LG,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.MD,
  },
  biometricText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
