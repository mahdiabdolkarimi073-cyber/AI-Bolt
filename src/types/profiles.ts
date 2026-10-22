/** Model profile (fallback chain) types. */

export interface ProfileCandidate {
  id: string;
  profileId: string;
  connectionId: string;
  modelId: string;
  priority: number;
  enabled: boolean;
  label?: string | null;
  createdAt: number;
}

export interface ModelProfile {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  candidates: ProfileCandidate[];
  createdAt: number;
  updatedAt: number;
}

export interface DefaultProfile {
  profileId: string | null;
  profile?: ModelProfile | null;
}

export interface ProjectProfileAssignment {
  projectId: string;
  profileId: string;
  profileName: string;
  profileEnabled: boolean;
  assignedAt: number;
}

/** Resolved candidate with connection metadata, from /profiles/{pid}/candidates/resolve. */
export interface ResolvedCandidate {
  candidateId: string;
  connectionId: string;
  modelId: string;
  priority: number;
  label?: string | null;
  adapter: string;
  baseUrl?: string | null;
  displayName: string;
  connectionStatus: string;
}

export interface CreateProfileInput {
  name: string;
  description?: string;
}

export interface UpdateProfileInput {
  name?: string;
  description?: string;
  enabled?: boolean;
}

export interface AddCandidateInput {
  connectionId: string;
  modelId: string;
  priority?: number;
  label?: string;
}

export interface UpdateCandidateInput {
  priority?: number;
  enabled?: boolean;
  label?: string | null;
}
