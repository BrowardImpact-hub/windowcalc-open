import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { api } from '@/api/endpoints';
import { clearToken, saveToken, setUnauthorizedHandler } from '@/api/client';
import { User, AuthSession, DeviceInfo } from '@/types';
import { generateUUID } from '@/utils/uuid';
import * as Device from 'expo-device';

interface AuthStore {
  token: string | null;
  user: User | null;
  isLoading: boolean;
  error: string | null;
  isAuthenticated: boolean;

  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  loadStoredSession: () => Promise<void>;
  clearError: () => void;
}

const AUTH_TOKEN_KEY = 'wc_token';
const AUTH_USER_KEY = 'wc_user';
const AUTH_EXPIRES_KEY = 'wc_expires';
const DEVICE_ID_KEY = 'wc_device_id';

export async function getOrCreateDeviceId(): Promise<string> {
  try {
    let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = generateUUID();
      await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  } catch (e) {
    // Fallback if secure store is unavailable
    return generateUUID();
  }
}

function getDeviceInfo(): DeviceInfo {
  return {
    device_id: '', // Will be set in login
    device_name: Device.deviceName || `${Device.modelName} Mobile`,
    platform: Device.osName?.toLowerCase() === 'android' ? 'android' : 'ios',
  };
}

export const useAuthStore = create<AuthStore>((set, get) => {
  // Set up unauthorized handler
  setUnauthorizedHandler(() => {
    set({ token: null, user: null, error: 'Session expired. Please log in again.' });
  });

  return {
    token: null,
    user: null,
    isLoading: false,
    error: null,
    isAuthenticated: false,

    login: async (email: string, password: string) => {
      set({ isLoading: true, error: null });
      try {
        const deviceId = await getOrCreateDeviceId();
        const deviceInfo = getDeviceInfo();
        deviceInfo.device_id = deviceId;

        const session: AuthSession = await api.auth.createSession(
          email,
          password,
          deviceInfo
        );

        // Save to secure store
        await saveToken(session.token);
        try {
          await SecureStore.setItemAsync(AUTH_USER_KEY, JSON.stringify(session.user));
          await SecureStore.setItemAsync(AUTH_EXPIRES_KEY, session.expires_at);
        } catch (e) {
          console.warn('Failed to save user/expiry to secure store:', e);
        }

        set({
          token: session.token,
          user: session.user,
          isAuthenticated: true,
          isLoading: false,
          error: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Login failed';
        set({
          isLoading: false,
          error: message,
          token: null,
          user: null,
          isAuthenticated: false,
        });
        throw error;
      }
    },

    logout: async () => {
      try {
        await clearToken();
        try {
          await SecureStore.deleteItemAsync(AUTH_USER_KEY);
          await SecureStore.deleteItemAsync(AUTH_EXPIRES_KEY);
        } catch (e) {
          console.warn('Failed to clear user/expiry from secure store:', e);
        }
      } catch (e) {
        console.warn('Logout failed:', e);
      }

      set({
        token: null,
        user: null,
        isAuthenticated: false,
        error: null,
      });
    },

    loadStoredSession: async () => {
      set({ isLoading: true });
      try {
        const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
        const userJson = await SecureStore.getItemAsync(AUTH_USER_KEY);
        const expiresAt = await SecureStore.getItemAsync(AUTH_EXPIRES_KEY);

        if (token && userJson && expiresAt) {
          // Check if token is expired
          const now = new Date();
          const expires = new Date(expiresAt);

          if (expires > now) {
            const user: User = JSON.parse(userJson);
            set({
              token,
              user,
              isAuthenticated: true,
              isLoading: false,
              error: null,
            });
          } else {
            // Token expired
            await clearToken();
            set({
              token: null,
              user: null,
              isAuthenticated: false,
              isLoading: false,
              error: null,
            });
          }
        } else {
          set({
            token: null,
            user: null,
            isAuthenticated: false,
            isLoading: false,
            error: null,
          });
        }
      } catch (error) {
        console.warn('Failed to load stored session:', error);
        set({
          token: null,
          user: null,
          isAuthenticated: false,
          isLoading: false,
          error: null,
        });
      }
    },

    clearError: () => {
      set({ error: null });
    },
  };
});
