import { config } from '@/config';
import { request } from '@/lib/http';
import { ApiErrorClass } from '@/lib/errors';
import type { FileNode } from '@/types';

/**
 * Workspace service — controlled, validated access to the user's project
 * folders on disk. ALL file operations go through the backend, which enforces
 * path containment inside an approved workspace root. The frontend never
 * constructs raw filesystem paths itself.
 *
 * Security principles (enforced on the backend, mirrored here for defense in depth):
 *   - Paths are resolved and checked against the workspace root.
 *   - No path traversal (..) escapes the root.
 *   - No arbitrary command execution from the browser.
 *   - Destructive operations require an explicit confirmation flag.
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

export const workspaceService = {
  /** True when workspace operations can actually run (backend present). */
  isAvailable(): boolean {
    return config.backendEnabled;
  },

  /** List the file tree for a project root. */
  async listTree(projectId: string): Promise<FileNode[]> {
    const { data, error } = await request<FileNode[]>(`/workspace/${encodeURIComponent(projectId)}/tree`);
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

  /** Delete a file. Requires explicit confirmation. */
  async deleteFile(projectId: string, relPath: string, confirm: boolean): Promise<void> {
    if (!confirm) throw new ApiErrorClass('confirmation_required', 'Delete requires confirmation.', 400);
    const safe = sanitizeRelativePath(relPath);
    const { error } = await request<void>(
      `/workspace/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(safe)}`,
      { method: 'DELETE' },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
  },
};
