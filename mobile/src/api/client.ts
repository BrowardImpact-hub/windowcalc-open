import * as SecureStore from 'expo-secure-store';
import { API_BASE } from '@/constants/api';
import { ApiError } from '@/types';

const AUTH_TOKEN_KEY = 'wc_token';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export class ApiException extends Error {
  constructor(
    public status: number,
    public message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiException';
  }
}

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  } catch (e) {
    console.warn('Failed to read token from secure store:', e);
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
  } catch (e) {
    console.error('Failed to save token to secure store:', e);
    throw new Error('Failed to persist authentication token');
  }
}

export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
  } catch (e) {
    console.warn('Failed to clear token from secure store:', e);
  }
}

export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  requestOptions?: { timeoutMs?: number }
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const token = await getToken();

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options: RequestInit = {
    method,
    headers,
  };
  const controller = new AbortController();
  const timeoutMs = requestOptions?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  options.signal = controller.signal;

  if (body && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, options);

    if (!response.ok) {
      if (response.status === 401) {
        await clearToken();
        if (onUnauthorized) {
          onUnauthorized();
        }
      }

      let errorMessage = `API Error: ${response.status}`;
      let errorDetails: Record<string, unknown> | undefined;

      try {
        const errorData = (await response.json()) as Record<string, unknown>;
        const candidateMessage = errorData.error || errorData.message;
        if (typeof candidateMessage === 'string' && candidateMessage.trim()) {
          errorMessage = candidateMessage;
        }
        errorDetails = errorData;
      } catch {
        // Response was not JSON, use status message
      }

      throw new ApiException(response.status, errorMessage, errorDetails);
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ApiException) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiException(408, `Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }

    if (error instanceof TypeError) {
      throw new ApiException(0, `Network error: ${error.message}`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function get<T>(path: string, requestOptions?: { timeoutMs?: number }): Promise<T> {
  return apiRequest<T>('GET', path, undefined, requestOptions);
}

export function post<T>(
  path: string,
  body?: Record<string, unknown>,
  requestOptions?: { timeoutMs?: number }
): Promise<T> {
  return apiRequest<T>('POST', path, body, requestOptions);
}

export function patch<T>(
  path: string,
  body?: Record<string, unknown>,
  requestOptions?: { timeoutMs?: number }
): Promise<T> {
  return apiRequest<T>('PATCH', path, body, requestOptions);
}

export function put<T>(
  path: string,
  body?: Record<string, unknown>,
  requestOptions?: { timeoutMs?: number }
): Promise<T> {
  return apiRequest<T>('PUT', path, body, requestOptions);
}

export function del<T>(path: string, requestOptions?: { timeoutMs?: number }): Promise<T> {
  return apiRequest<T>('DELETE', path, undefined, requestOptions);
}
