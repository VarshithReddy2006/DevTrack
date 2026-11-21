// ============================================================================
// axiosClient.ts - Centralized HTTP Client
// ============================================================================
// Single axios instance with interceptors for error normalization,
// request/response logging, and Clerk token injection.
// ============================================================================

import axios, {
  type AxiosInstance,
  type AxiosError,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ApiError } from '../types/api.types';
import { reportServiceUnavailable } from '../store/maintenanceStore';
import { envConfig } from './envCheck';

// Add Clerk to Window interface
declare global {
  interface Window {
    Clerk?: any;
  }
}

const BASE_URL = envConfig.VITE_API_BASE_URL;
const TIMEOUT = 30_000; // 30 seconds - increased to handle slow backend responses

type AuthInvalidHandler = (() => void) | null;
let onAuthInvalid: AuthInvalidHandler = null;

export function setOnAuthInvalid(handler: AuthInvalidHandler) {
  onAuthInvalid = handler;
}

// ---------------------------------------------------------------------------
// Create Axios Instance
// ---------------------------------------------------------------------------

const axiosClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

// ---------------------------------------------------------------------------
// Request Interceptor - Attach Clerk Token
// ---------------------------------------------------------------------------

axiosClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    // Inject Clerk session token if available
    if (window.Clerk && window.Clerk.session) {
      try {
        const token = await window.Clerk.session.getToken();
        if (token && config.headers) {
          config.headers.Authorization = `Bearer ${token}`;
        }
      } catch (err) {
        console.warn('Failed to get Clerk session token for request', err);
      }
    }
    return config;
  },
  (error: AxiosError) => Promise.reject(error)
);

// ---------------------------------------------------------------------------
// Response Interceptor - Normalize Errors
// ---------------------------------------------------------------------------

axiosClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiError>) => {

    // Handle 401 - Unauthorized
    if (error.response?.status === 401) {
      // With Clerk, a 401 means the session token was not attached or has expired.
      // We call the optional auth-invalid handler (e.g. to clear local state)
      // but do NOT hard-redirect - Clerk route protection handles unauthenticated
      // users, and a transient 401 (token not ready on mount) should not
      // kick the user to the login page.
      try {
        onAuthInvalid?.();
      } catch {
        // ignore
      }
    }

    // 503 with Retry-After means planned maintenance; show the maintenance screen.
    // Other 503s (for example an unconfigured optional feature) stay ordinary errors.
    if (error.response?.status === 503) {
      reportServiceUnavailable(error.response.headers?.['retry-after']);
    }

    // Normalize error for consumers
    const retryAfter = error.response?.headers['retry-after'] ?? error.response?.data?.retryAfter;
    const normalized: ApiError = {
      success: false,
      message:
        error.response?.data?.message ||
        error.message ||
        'An unexpected error occurred',
      code: error.response?.data?.code || 'UNKNOWN_ERROR',
      statusCode: error.response?.status || 500,
      retryAfter: typeof retryAfter === 'string' || typeof retryAfter === 'number' ? retryAfter : undefined,
      timestamp: new Date().toISOString(),
      details: error.response?.data?.details,
    };

    return Promise.reject(normalized);
  }
);

export default axiosClient;
