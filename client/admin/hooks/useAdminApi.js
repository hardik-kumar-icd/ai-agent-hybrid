import { useCallback, useMemo } from 'react';
import axios from 'axios';

/**
 * useAdminApi
 *
 * Shared API client for all admin sections. Receives the admin token from the
 * parent AdminDashboard (which manages the token state). Returns:
 *   - api: axios instance with baseURL set to the current origin
 *   - get(url, params): convenience wrapper that adds the Bearer token + handles
 *     error normalization
 *   - hasToken: boolean, true if a non-empty token is configured
 *
 * Token is NEVER stored anywhere persistent. It lives in the parent React
 * state for the duration of the page session.
 */

function sanitizeToken(raw) {
  if (!raw) return '';
  let value = String(raw).trim();
  if (value.startsWith('REACT_APP_ADMIN_TOKEN=')) {
    value = value.replace(/^REACT_APP_ADMIN_TOKEN=/, '').trim();
  }
  if (value.startsWith('ADMIN_API_KEY=')) {
    value = value.replace(/^ADMIN_API_KEY=/, '').trim();
  }
  return value;
}

export function useAdminApi(token) {
  const normalizedToken = sanitizeToken(token);
  const hasToken = normalizedToken.length > 0;

  const api = useMemo(() => {
    const origin =
      typeof window !== 'undefined' && window.location ? window.location.origin : '';
    return axios.create({
      baseURL: origin || undefined,
      timeout: 60000,
    });
  }, []);

  /**
   * GET helper. Returns { ok, data, status, error }.
   * Never throws — caller checks .ok.
   */
  const get = useCallback(
    async (url, params = undefined) => {
      if (!hasToken) {
        return { ok: false, status: 0, error: 'no admin token configured' };
      }
      try {
        const response = await api.get(url, {
          headers: { Authorization: `Bearer ${normalizedToken}` },
          params,
        });
        return { ok: true, data: response.data, status: response.status };
      } catch (err) {
        const status = err.response?.status || 0;
        const error =
          err.response?.data?.error ||
          err.response?.data?.message ||
          err.message ||
          'request failed';
        return { ok: false, status, error };
      }
    },
    [api, normalizedToken, hasToken]
  );

  /**
   * Generic request. Used by the existing Knowledge Base / Diagnostics sections
   * that send POST / DELETE in addition to GET.
   */
  const request = useCallback(
    async (method, url, options = {}) => {
      if (!hasToken) {
        return { ok: false, status: 0, error: 'no admin token configured' };
      }
      try {
        const config = {
          method,
          url,
          headers: {
            ...(options.headers || {}),
            Authorization: `Bearer ${normalizedToken}`,
          },
          ...(options.params ? { params: options.params } : {}),
          ...(options.data ? { data: options.data } : {}),
        };
        const response = await api.request(config);
        return { ok: true, data: response.data, status: response.status };
      } catch (err) {
        const status = err.response?.status || 0;
        const error =
          err.response?.data?.error ||
          err.response?.data?.message ||
          err.message ||
          'request failed';
        return { ok: false, status, error };
      }
    },
    [api, normalizedToken, hasToken]
  );

  return { api, get, request, hasToken, normalizedToken };
}
