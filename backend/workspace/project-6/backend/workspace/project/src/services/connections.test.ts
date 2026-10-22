import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ADAPTER_LABELS,
  ADAPTER_DEFAULT_URLS,
  TEST_CATEGORY_LABELS,
  type ApiConnectionDetail,
  type ConnectionTestResult,
} from '@/types/connections';

// These tests cover the pure frontend pieces of Phase 6: type constants,
// masking behavior expectations, and the connection service contract against a
// mocked backend. Real provider HTTP is tested on the backend side
// (docs/provider-management.md documents that the backend cannot run in this
// preview environment).

describe('connection types', () => {
  it('exposes labels for every supported adapter', () => {
    expect(ADAPTER_LABELS.openai_compatible).toBe('OpenAI-compatible');
    expect(ADAPTER_LABELS.gemini).toBe('Google Gemini');
  });

  it('provides sensible default base URLs', () => {
    expect(ADAPTER_DEFAULT_URLS.gemini).toMatch(/^https:\/\//);
    expect(ADAPTER_DEFAULT_URLS.openai_compatible).toMatch(/^https:\/\//);
  });

  it('maps every test category to a human label', () => {
    const categories = [
      'ok', 'auth_failed', 'rate_limited', 'quota_or_billing', 'invalid_model',
      'invalid_endpoint', 'timeout', 'network_error', 'provider_error', 'not_configured',
    ];
    for (const c of categories) {
      expect(TEST_CATEGORY_LABELS[c]).toBeTruthy();
    }
  });

  it('a connection detail never includes a plaintext secret field', () => {
    const detail: ApiConnectionDetail = {
      id: 'conn-1',
      displayName: 'Test',
      adapter: 'gemini',
      providerLabel: null,
      baseUrl: 'https://example.com',
      enabled: true,
      status: 'untested',
      defaultModel: null,
      createdAt: 1,
      updatedAt: 1,
      models: [],
      credentials: [
        { id: 'cred-1', connectionId: 'conn-1', label: null, keyMask: 'sk-x••••ab12', enabled: true, isPrimary: true, createdAt: 1, updatedAt: 1 },
      ],
      hasKey: true,
    };
    const json = JSON.stringify(detail);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('encrypted');
    expect(detail.credentials[0].keyMask).not.toContain('sk-fullkey');
  });
});

// --- Connection service with mocked fetch ---

// We mock the config module so `backendEnabled` is true, then intercept fetch.
vi.mock('@/config', () => ({
  config: {
    apiBaseUrl: 'http://localhost:8000',
    backendEnabled: true,
    defaultProvider: 'gemini',
    requestTimeoutMs: 15000,
  },
}));

import * as connService from '@/services/connectionService';

function mockFetch(response: { ok: boolean; status: number; body: unknown }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(response.body),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('connectionService', () => {
  it('lists connections from the backend', async () => {
    const body: ApiConnectionDetail[] = [
      {
        id: 'conn-1', displayName: 'A', adapter: 'gemini', providerLabel: null,
        baseUrl: 'https://x', enabled: true, status: 'untested', defaultModel: null,
        createdAt: 1, updatedAt: 1, models: [], credentials: [], hasKey: false,
      },
    ];
    const fetchMock = mockFetch({ ok: true, status: 200, body });
    const { data, error } = await connService.listConnections();
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe('conn-1');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('creates a connection via POST', async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 201,
      body: { id: 'conn-2', displayName: 'New', adapter: 'gemini', providerLabel: null, baseUrl: 'https://g', enabled: true, status: 'untested', defaultModel: null, createdAt: 1, updatedAt: 1 },
    });
    const { data, error } = await connService.createConnection({ displayName: 'New', adapter: 'gemini', baseUrl: 'https://g' });
    expect(error).toBeNull();
    expect(data?.id).toBe('conn-2');
    const call = fetchMock.mock.calls[0];
    expect(call[1].method).toBe('POST');
  });

  it('deletes a connection via DELETE', async () => {
    const fetchMock = mockFetch({ ok: true, status: 204, body: null });
    const { error } = await connService.deleteConnection('conn-1');
    expect(error).toBeNull();
    const call = fetchMock.mock.calls[0];
    expect(call[1].method).toBe('DELETE');
    expect(call[0]).toContain('/connections/conn-1');
  });

  it('adds a credential and never expects the secret back', async () => {
    const fetchMock = mockFetch({
      ok: true,
      status: 201,
      body: { id: 'cred-1', connectionId: 'conn-1', label: 'primary', keyMask: 'sk-x••••ab12', enabled: true, isPrimary: true, createdAt: 1, updatedAt: 1 },
    });
    const { data, error } = await connService.addCredential('conn-1', { secret: 'sk-fullkey-value', label: 'primary', isPrimary: true });
    expect(error).toBeNull();
    expect(data?.keyMask).toBe('sk-x••••ab12');
    // The response must never contain the raw secret.
    expect(JSON.stringify(data)).not.toContain('sk-fullkey-value');
    // The request body DOES contain the secret (sent to the trusted backend).
    const call = fetchMock.mock.calls[0];
    expect(JSON.stringify(call[1].body)).toContain('sk-fullkey-value');
  });

  it('returns a structured test result', async () => {
    const result: ConnectionTestResult = { category: 'ok', message: 'Connection successful.', statusCode: 200 };
    mockFetch({ ok: true, status: 200, body: result });
    const { data, error } = await connService.testConnection('conn-1', 'gemini-2.0-flash');
    expect(error).toBeNull();
    expect(data?.category).toBe('ok');
  });

  it('surfaces a backend error when the server returns 503', async () => {
    mockFetch({ ok: false, status: 503, body: { detail: 'Encryption not configured.' } });
    const { data, error } = await connService.addCredential('conn-1', { secret: 'sk-x' });
    expect(data).toBeNull();
    expect(error).toBeTruthy();
  });

  it('sets agent defaults via PUT', async () => {
    const fetchMock = mockFetch({ ok: true, status: 200, body: { connectionId: 'conn-1', model: 'gemini-2.0-flash' } });
    const { data, error } = await connService.setAgentDefaults('conn-1', 'gemini-2.0-flash');
    expect(error).toBeNull();
    expect(data?.connectionId).toBe('conn-1');
    const call = fetchMock.mock.calls[0];
    expect(call[1].method).toBe('PUT');
  });
});
