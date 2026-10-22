import { config } from '@/config';
import { request } from '@/lib/http';
import { ApiErrorClass } from '@/lib/errors';
import type { FileNode } from '@/types';
import type { Project } from '@/types/domain';

/**
 * Workspace service — controlled, validated access to the user's project
 * folders on disk. ALL file operations go through the backend, which enforces
 * path containment inside an approved workspace root. The frontend never
 * constructs raw filesystem paths itself.
 *
 * When no backend is configured, methods return a clear `backend_unavailable`
 * error — they never silently fall back to touching the real filesystem.
 */

/** Resolve a relative path and reject traversal attempts before calling the backend. */
function sanitizeRelativePath(rel: string): string {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.includes('..')) {
    throw new ApiErrorClass('invalid_path', 'Path traversal is not allowed.', 400);
  }
  return normalized;
}

export interface WorkspaceFile {
  path: string;
  content: string;
  language: string;
}

export interface FileInfo {
  path: string;
  size: number;
  modifiedAt: number;
  isDir: boolean;
  isText: boolean;
}

export interface SearchResult {
  path: string;
  name: string;
  line: number | null;
  match: string;
}

export interface SearchResponse {
  results: SearchResult[];
  mode: 'filename' | 'content';
  total: number;
}

export interface ImportResult {
  project: Project;
}

export const workspaceService = {
  /** True when workspace operations can actually run (backend present). */
  isAvailable(): boolean {
    return config.backendEnabled;
  },

  /** List the file tree for a project root (lazy, one level by default). */
  async listTree(projectId: string, subpath?: string, depth?: number): Promise<FileNode[]> {
    const params = new URLSearchParams();
    if (subpath) params.set('subpath', subpath);
    if (depth) params.set('depth', String(depth));
    const qs = params.toString();
    const { data, error } = await request<FileNode[]>(
      `/workspace/${encodeURIComponent(projectId)}/tree${qs ? `?${qs}` : ''}`,
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    return data ?? [];
  },

  /** Read a file's contents. */
  async readFile(projectId: string, relPath: string): Promise<WorkspaceFile> {
    const safe = sanitizeRelativePath(relPath);
    const { data, error } = await request<WorkspaceFile>(
      `/workspace/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(safe)}`,
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('not_found', 'File not found.', 404);
    return data;
  },

  /** Get file metadata without reading content. */
  async getFileInfo(projectId: string, relPath: string): Promise<FileInfo> {
    const safe = sanitizeRelativePath(relPath);
    const { data, error } = await request<FileInfo>(
      `/workspace/${encodeURIComponent(projectId)}/files/info?path=${encodeURIComponent(safe)}`,
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('not_found', 'File not found.', 404);
    return data;
  },

  /** Write a file's contents. Requires confirmation for overwrite. */
  async writeFile(
    projectId: string,
    relPath: string,
    content: string,
    opts: { overwrite?: boolean } = {},
  ): Promise<WorkspaceFile> {
    const safe = sanitizeRelativePath(relPath);
    const { data, error } = await request<WorkspaceFile>(
      `/workspace/${encodeURIComponent(projectId)}/files`,
      { method: 'POST', body: { path: safe, content, overwrite: opts.overwrite ?? false } },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('server', 'Empty response from backend.', 500);
    return data;
  },

  /** Delete a file or directory. Requires explicit confirmation. */
  async deletePath(projectId: string, relPath: string, confirm: boolean): Promise<void> {
    if (!confirm) throw new ApiErrorClass('confirmation_required', 'Delete requires confirmation.', 400);
    const safe = sanitizeRelativePath(relPath);
    const { error } = await request<void>(
      `/workspace/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(safe)}&confirm=true`,
      { method: 'DELETE' },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
  },

  /** Create a directory. */
  async createDirectory(projectId: string, relPath: string): Promise<{ path: string; type: string }> {
    const safe = sanitizeRelativePath(relPath);
    const { data, error } = await request<{ path: string; type: string }>(
      `/workspace/${encodeURIComponent(projectId)}/dirs`,
      { method: 'POST', body: { path: safe } },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('server', 'Empty response from backend.', 500);
    return data;
  },

  /** Rename / move a file or directory. */
  async renamePath(
    projectId: string,
    fromPath: string,
    toPath: string,
    opts: { overwrite?: boolean } = {},
  ): Promise<{ fromPath: string; toPath: string }> {
    const from = sanitizeRelativePath(fromPath);
    const to = sanitizeRelativePath(toPath);
    const { data, error } = await request<{ fromPath: string; toPath: string }>(
      `/workspace/${encodeURIComponent(projectId)}/rename`,
      { method: 'POST', body: { fromPath: from, toPath: to, overwrite: opts.overwrite ?? false } },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('server', 'Empty response from backend.', 500);
    return data;
  },

  /** Search filenames or source text within a project. */
  async search(
    projectId: string,
    query: string,
    mode: 'filename' | 'content' = 'filename',
    limit?: number,
  ): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query, mode });
    if (limit) params.set('limit', String(limit));
    const { data, error } = await request<SearchResponse>(
      `/workspace/${encodeURIComponent(projectId)}/search?${params.toString()}`,
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    return data ?? { results: [], mode, total: 0 };
  },

  /** Create an empty project (registers a new directory under WORKSPACE_ROOT). */
  async createEmptyProject(name: string): Promise<Project> {
    const { data, error } = await request<Project>('/workspace/create-empty', {
      method: 'POST',
      body: { name },
    });
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('server', 'Empty response from backend.', 500);
    return data;
  },

  /** Import a project from a ZIP archive. */
  async importZip(file: File, name?: string): Promise<Project> {
    const formData = new FormData();
    formData.append('file', file);
    const params = name ? `?name=${encodeURIComponent(name)}` : '';
    const { data, error } = await request<Project>(
      `/workspace/import-zip${params}`,
      { method: 'POST', body: formData, raw: true },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('server', 'Import failed.', 500);
    return data;
  },

  /** List recent projects. */
  async listRecent(): Promise<Project[]> {
    const { data, error } = await request<Project[]>('/workspace/recent/list');
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    return data ?? [];
  },

  /** Remove a project from the recent list without deleting its files. */
  async removeFromRecent(projectId: string): Promise<void> {
    const { error } = await request<void>(
      `/workspace/recent/${encodeURIComponent(projectId)}`,
      { method: 'DELETE' },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
  },

  /** Delete a project's files on disk (destructive, separate from DB record). */
  async deleteProjectFiles(projectId: string, confirm: boolean): Promise<void> {
    if (!confirm) throw new ApiErrorClass('confirmation_required', 'Confirmation required.', 400);
    const { error } = await request<void>(
      `/workspace/${encodeURIComponent(projectId)}/files-on-disk?confirm=true`,
      { method: 'DELETE' },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
  },
};
