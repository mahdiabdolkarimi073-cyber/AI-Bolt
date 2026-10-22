import { useCallback, useEffect, useState } from 'react';
import { config } from '@/config';
import type { ApiError } from '@/types/domain';
import type {
  ModelProfile,
  DefaultProfile,
  CreateProfileInput,
  UpdateProfileInput,
  AddCandidateInput,
  UpdateCandidateInput,
  ResolvedCandidate,
} from '@/types/profiles';
import * as profileApi from '@/services/profileService';

export interface UseProfilesState {
  profiles: ModelProfile[];
  defaultProfile: DefaultProfile | null;
  loading: boolean;
  error: string | null;
  backendUnavailable: boolean;
}

export interface UseProfilesReturn extends UseProfilesState {
  refresh: () => Promise<void>;
  createProfile: (input: CreateProfileInput) => Promise<ModelProfile | null>;
  updateProfile: (id: string, input: UpdateProfileInput) => Promise<ModelProfile | null>;
  deleteProfile: (id: string) => Promise<boolean>;
  addCandidate: (profileId: string, input: AddCandidateInput) => Promise<boolean>;
  updateCandidate: (profileId: string, candidateId: string, input: UpdateCandidateInput) => Promise<boolean>;
  deleteCandidate: (profileId: string, candidateId: string) => Promise<boolean>;
  reorderCandidates: (profileId: string, orderedIds: string[]) => Promise<boolean>;
  resolveCandidates: (profileId: string) => Promise<ResolvedCandidate[] | null>;
  setDefaultProfile: (profileId: string | null) => Promise<boolean>;
  clearError: () => void;
}

function toMessage(error: ApiError | null, fallback: string): string {
  return error?.message ?? fallback;
}

export function useProfiles(): UseProfilesReturn {
  const [state, setState] = useState<UseProfilesState>({
    profiles: [],
    defaultProfile: null,
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
      const [profRes, defRes] = await Promise.all([profileApi.listProfiles(), profileApi.getDefaultProfile()]);
      if (profRes.error || defRes.error) {
        setState((s) => ({
          ...s,
          loading: false,
          error: toMessage(profRes.error ?? defRes.error, 'Failed to load profiles.'),
        }));
        return;
      }
      setState((s) => ({
        ...s,
        profiles: profRes.data ?? [],
        defaultProfile: defRes.data ?? null,
        loading: false,
        error: null,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load profiles.',
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createProfile = useCallback(
    async (input: CreateProfileInput): Promise<ModelProfile | null> => {
      const { data, error } = await profileApi.createProfile(input);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to create profile.') }));
        return null;
      }
      await refresh();
      return data;
    },
    [refresh],
  );

  const updateProfile = useCallback(
    async (id: string, input: UpdateProfileInput): Promise<ModelProfile | null> => {
      const { data, error } = await profileApi.updateProfile(id, input);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to update profile.') }));
        return null;
      }
      await refresh();
      return data;
    },
    [refresh],
  );

  const deleteProfile = useCallback(
    async (id: string): Promise<boolean> => {
      const { error } = await profileApi.deleteProfile(id);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to delete profile.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const addCandidate = useCallback(
    async (profileId: string, input: AddCandidateInput): Promise<boolean> => {
      const { error } = await profileApi.addCandidate(profileId, input);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to add candidate.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const updateCandidate = useCallback(
    async (profileId: string, candidateId: string, input: UpdateCandidateInput): Promise<boolean> => {
      const { error } = await profileApi.updateCandidate(profileId, candidateId, input);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to update candidate.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const deleteCandidate = useCallback(
    async (profileId: string, candidateId: string): Promise<boolean> => {
      const { error } = await profileApi.deleteCandidate(profileId, candidateId);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to remove candidate.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const reorderCandidates = useCallback(
    async (profileId: string, orderedIds: string[]): Promise<boolean> => {
      const { error } = await profileApi.reorderCandidates(profileId, orderedIds);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to reorder candidates.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const resolveCandidates = useCallback(
    async (profileId: string): Promise<ResolvedCandidate[] | null> => {
      const { data, error } = await profileApi.resolveCandidates(profileId);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to resolve candidates.') }));
        return null;
      }
      return data;
    },
    [],
  );

  const setDefaultProfile = useCallback(
    async (profileId: string | null): Promise<boolean> => {
      const { error } = await profileApi.setDefaultProfile(profileId);
      if (error) {
        setState((s) => ({ ...s, error: toMessage(error, 'Failed to set default profile.') }));
        return false;
      }
      await refresh();
      return true;
    },
    [refresh],
  );

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  return {
    ...state,
    refresh,
    createProfile,
    updateProfile,
    deleteProfile,
    addCandidate,
    updateCandidate,
    deleteCandidate,
    reorderCandidates,
    resolveCandidates,
    setDefaultProfile,
    clearError,
  };
}
