import { request } from '@/lib/http';
import type { ApiResult } from '@/types/domain';
import type {
  ModelProfile,
  ProfileCandidate,
  DefaultProfile,
  ProjectProfileAssignment,
  ResolvedCandidate,
  CreateProfileInput,
  UpdateProfileInput,
  AddCandidateInput,
  UpdateCandidateInput,
} from '@/types/profiles';

export async function listProfiles(): Promise<ApiResult<ModelProfile[]>> {
  const { data, error } = await request<ModelProfile[]>('/profiles');
  if (error) return { data: null, error };
  return { data: data ?? [], error: null };
}

export async function getProfile(id: string): Promise<ApiResult<ModelProfile>> {
  const { data, error } = await request<ModelProfile>(`/profiles/${encodeURIComponent(id)}`);
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function createProfile(input: CreateProfileInput): Promise<ApiResult<ModelProfile>> {
  const { data, error } = await request<ModelProfile>('/profiles', { method: 'POST', body: input });
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function updateProfile(id: string, input: UpdateProfileInput): Promise<ApiResult<ModelProfile>> {
  const { data, error } = await request<ModelProfile>(`/profiles/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  });
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function deleteProfile(id: string): Promise<ApiResult<void>> {
  const { error } = await request<void>(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (error) return { data: null, error };
  return { data: undefined, error: null };
}

// --- Candidates ---

export async function addCandidate(profileId: string, input: AddCandidateInput): Promise<ApiResult<ProfileCandidate>> {
  const { data, error } = await request<ProfileCandidate>(
    `/profiles/${encodeURIComponent(profileId)}/candidates`,
    { method: 'POST', body: input },
  );
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function updateCandidate(
  profileId: string,
  candidateId: string,
  input: UpdateCandidateInput,
): Promise<ApiResult<ProfileCandidate>> {
  const { data, error } = await request<ProfileCandidate>(
    `/profiles/${encodeURIComponent(profileId)}/candidates/${encodeURIComponent(candidateId)}`,
    { method: 'PATCH', body: input },
  );
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function deleteCandidate(profileId: string, candidateId: string): Promise<ApiResult<void>> {
  const { error } = await request<void>(
    `/profiles/${encodeURIComponent(profileId)}/candidates/${encodeURIComponent(candidateId)}`,
    { method: 'DELETE' },
  );
  if (error) return { data: null, error };
  return { data: undefined, error: null };
}

export async function reorderCandidates(profileId: string, orderedIds: string[]): Promise<ApiResult<ProfileCandidate[]>> {
  const { data, error } = await request<ProfileCandidate[]>(
    `/profiles/${encodeURIComponent(profileId)}/candidates/reorder`,
    { method: 'PUT', body: { orderedIds } },
  );
  if (error) return { data: null, error };
  return { data: data ?? [], error: null };
}

export async function resolveCandidates(profileId: string): Promise<ApiResult<ResolvedCandidate[]>> {
  const { data, error } = await request<ResolvedCandidate[]>(
    `/profiles/${encodeURIComponent(profileId)}/candidates/resolve`,
  );
  if (error) return { data: null, error };
  return { data: data ?? [], error: null };
}

// --- Default profile ---

export async function getDefaultProfile(): Promise<ApiResult<DefaultProfile>> {
  const { data, error } = await request<DefaultProfile>('/profiles/default');
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function setDefaultProfile(profileId: string | null): Promise<ApiResult<{ profileId: string | null }>> {
  const { data, error } = await request<{ profileId: string | null }>('/profiles/default', {
    method: 'PUT',
    body: { profileId },
  });
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

// --- Project assignment ---

export async function getProjectAssignment(projectId: string): Promise<ApiResult<ProjectProfileAssignment | null>> {
  const { data, error } = await request<ProjectProfileAssignment | null>(
    `/profiles/project/${encodeURIComponent(projectId)}`,
  );
  if (error) return { data: null, error };
  return { data: data ?? null, error: null };
}

export async function setProjectAssignment(
  projectId: string,
  profileId: string,
): Promise<ApiResult<ProjectProfileAssignment>> {
  const { data, error } = await request<ProjectProfileAssignment>(
    `/profiles/project/${encodeURIComponent(projectId)}`,
    { method: 'PUT', body: { profileId } },
  );
  if (error) return { data: null, error };
  if (!data) return { data: null, error: { code: 'server', message: 'Empty response from backend.' } };
  return { data, error: null };
}

export async function clearProjectAssignment(projectId: string): Promise<ApiResult<void>> {
  const { error } = await request<void>(`/profiles/project/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
  if (error) return { data: null, error };
  return { data: undefined, error: null };
}
