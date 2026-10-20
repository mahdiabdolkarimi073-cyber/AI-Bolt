import { useCallback, useEffect, useState } from 'react';
import { config } from '@/config';
import type { ApiError } from '@/types/domain';
import type {
  ApiConnectionDetail,
  AgentDefaults,
  CreateConnectionInput,
  UpdateConnectionInput,
  AddCredentialInput,
  UpdateCredentialInput,
  AddModelInput,
  UpdateModelInput,
  ConnectionTestResult,
  ProviderPreset,
  DiagnosticEvent,
} from '@/types/connections';
import * as connApi from '@/services/connectionService';

/**
 * React hook that manages AI connections, credentials, models, defaults, and
 * connection testing. Loads from the backend when available; in local fallback
 * mode (no backend) it returns a clear error so the UI can explain the
 * limitation instead of pretending to work.
 */
export interface UseConnectionsState {
  connections: ApiConnectionDetail[];
  defaults: AgentDefaults | null;
  loading: boolean;
  error: string | null;
  /** True when no backend is configured — the UI shows a setup notice. */
  backendUnavailable: boolean;
}

export interface UseConnectionsReturn extends UseConnectionsState {
  refresh: () => Promise<void>;
  createConnection: (input: CreateConnectionInput) => Promise<ApiConnectionDetail | null>;
  updateConnection: (id: string, input: UpdateConnectionInput) => Promise<ApiConnectionDetail | null>;
  deleteConnection: (id: string) => Promise<boolean>;
  addCredential: (connectionId: string, input: AddCredentialInput) => Promise<boolean>;
  updateCredential: (connectionId: string, credId: string, input: UpdateCredentialInput) => Promise<boolean>;
  deleteCredential: (connectionId: string, credId: string) => Promise<boolean>;
  addModel: (connectionId: string, input: AddModelInput) => Promise<boolean>;
  updateModel: (connectionId: string, modelId: string, input: UpdateModelInput) => Promise<boolean>;
  deleteModel: (connectionId: string, modelId: string) => Promise<boolean>;
  testConnection: (connectionId: string, model: string, credentialId?: string) => Promise<ConnectionTestResult | null>;
  setDefaults: (connectionId: string | null, model: string | null) => Promise<boolean>;
  refreshModels: (connectionId: string) => Promise<string[] | null>;
  loadPresets: () => Promise<ProviderPreset[] | null>;
  loadDiagnostics: (connectionId?: string) => Promise<DiagnosticEvent[] | null>;
  clearDiagnostics: (connectionId?: string) => Promise<boolean>;
  clearError: () => void;
}

function toMessage(error: ApiError | null, fallback: string): string {
  return error?.message ?? fallback;
}

export function useConnections(): UseConnectionsReturn {
  const [state, setState] = useState<UseConnectionsState>({
    connections: [],
    defaults: null,
    loading: false,
    error: null,
    backendUnavailable: !config.backendEnabled,
  });

  const refresh = useCallback(async () => {
    if (!config.backendEnabled) {
      setState((s) => ({ ...s, backendUnavailable: true, loading: false }));
      return;
    }
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [connRes, defRes] = await Promise.all([connApi.listConnections(), connApi.getAgentDefaults()]);
      if (connRes.error || defRes.error) {
        setState((s) => ({
          ...s,
          loading: false,
          error: toMessage(connRes.error ?? defRes.error, 'Failed to load connections.'),
        }));
        return;
      }
      setState((s) => ({
        ...s,
        connections: connRes.data ?? [],
        defaults: defRes.data ?? null,
        loading: false,
        error: null,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load connections.',
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createConnection = useCallback(
    async (input: CreateConnectionInput): Promise<ApiConnectionDetail | null> => {
      const { data, error } = await connApi.createConnection(input);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to create connection.') }));
        return null;
      }
      await refresh();
      return data ? (await connApi.getConnection(data.id)).data ?? null : null;
    },
    [refresh],
  );

  const updateConnection = useCallback(
    async (id: string, input: UpdateConnectionInput): Promise<ApiConnectionDetail | null> => {
      const { data, error } = await connApi.updateConnection(id, input);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to update connection.') }));
        return null;
      }
      await refresh();
      return data ? (await connApi.getConnection(data.id)).data ?? null : null;
    },
    [refresh],
  );

  const deleteConnection = useCallback(
    async (id: string): Promise<boolean> => {
      const { error } = await connApi.deleteConnection(id);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to delete connection.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const addCredential = useCallback(
    async (connectionId: string, input: AddCredentialInput): Promise<boolean> => {
      const { error } = await connApi.addCredential(connectionId, input);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to add API key.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const updateCredential = useCallback(
    async (connectionId: string, credId: string, input: UpdateCredentialInput): Promise<boolean> => {
      const { error } = await connApi.updateCredential(connectionId, credId, input);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to update API key.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const deleteCredential = useCallback(
    async (connectionId: string, credId: string): Promise<boolean> => {
      const { error } = await connApi.deleteCredential(connectionId, credId);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to remove API key.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const addModel = useCallback(
    async (connectionId: string, input: AddModelInput): Promise<boolean> => {
      const { error } = await connApi.addModel(connectionId, input);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to add model.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const updateModel = useCallback(
    async (connectionId: string, modelId: string, input: UpdateModelInput): Promise<boolean> => {
      const { error } = await connApi.updateModel(connectionId, modelId, input);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to update model.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const deleteModel = useCallback(
    async (connectionId: string, modelId: string): Promise<boolean> => {
      const { error } = await connApi.deleteModel(connectionId, modelId);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to remove model.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const testConnection = useCallback(
    async (connectionId: string, model: string, credentialId?: string): Promise<ConnectionTestResult | null> => {
      const { data, error } = await connApi.testConnection(connectionId, model, credentialId);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to test connection.') }));
        return null;
      }
      await refresh();
      return data;
    },
    [refresh],
  );

  const setDefaults = useCallback(
    async (connectionId: string | null, model: string | null): Promise<boolean> => {
      const { error } = await connApi.setAgentDefaults(connectionId, model);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to set defaults.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  const refreshModels = useCallback(
    async (connectionId: string): Promise<string[] | null> => {
      const { data, error } = await connApi.refreshModels(connectionId);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to refresh models.') }));
        return null;
      }
      return data;
    },
    [],
  );

  const loadPresets = useCallback(async (): Promise<ProviderPreset[] | null> => {
    const { data, error } = await connApi.listPresets();
    if (error) {
      return null;
    }
    return data;
  }, []);

  const loadDiagnostics = useCallback(async (connectionId?: string): Promise<DiagnosticEvent[] | null> => {
    const { data, error } = await connApi.listDiagnostics(connectionId);
    if (error) return null;
    return data;
  }, []);

  const clearDiagnostics = useCallback(async (connectionId?: string): Promise<boolean> => {
    const { error } = await connApi.clearDiagnostics(connectionId);
    if (error) {
      setState((s) => ({ ...s, error: toMessage(error, 'Failed to clear diagnostics.') }));
      return false;
    }
    return true;
  }, []);

  return {
    ...state,
    refresh,
    createConnection,
    updateConnection,
    deleteConnection,
    addCredential,
    updateCredential,
    deleteCredential,
    addModel,
    updateModel,
    deleteModel,
    testConnection,
    setDefaults,
    refreshModels,
    loadPresets,
    loadDiagnostics,
    clearDiagnostics,
    clearError,
  };
}
