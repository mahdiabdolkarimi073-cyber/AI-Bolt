/**
 * Workspace service tests (Phase 9).
 *
 * Covers:
 *  - Path traversal sanitization before any backend call.
 *  - Confirmation guards on destructive operations.
 *  - Correct request construction (method, path, body).
 *  - Graceful behavior when the backend is unavailable.
 *  - Import ZIP uses FormData/raw body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vi.mock factories are hoisted above imports, so any variable they reference
// must be created with vi.hoisted to be available at hoist time.
const { requestMock, configMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  configMock: {
    backendEnabled: true,
    apiBaseUrl: 'http://localhost:8000',
    requestTimeoutMs: 15000,
  },
}));

vi.mock('@/lib/http', () => ({
  request: (...args: unknown[]) => requestMock(...args),
}));

vi.mock('@/config', () => ({
  config: configMock,
}));

import { workspaceService } from '@/services/workspace';

function ok<T>(data: T) {
  return { data, error: null };
}
function err(code: string, message: string, status = 400) {
  return { data: null, error: { code, message, status } };
}

beforeEach(() => {
  requestMock.mockReset();
  configMock.backendEnabled = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('workspaceService.isAvailable', () => {
  it('reflects config.backendEnabled', () => {
    configMock.backendEnabled = true;
    expect(workspaceService.isAvailable()).toBe(true);
    configMock.backendEnabled = false;
    expect(workspaceService.isAvailable()).toBe(false);
  });
});

describe('workspaceService.readFile — path sanitization', () => {
  it('rejects traversal before calling the backend', async () => {
    await expect(workspaceService.readFile('p1', '../escape.txt')).rejects.toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('strips leading slashes from absolute-style paths', async () => {
    // /etc/passwd is normalized to etc/passwd (a relative path inside the
    // project). The backend's safe_resolve enforces containment; the frontend
    // just avoids sending a leading slash.
    requestMock.mockResolvedValue(ok({ path: 'etc/passwd', content: 'x', language: 'text' }));
    await workspaceService.readFile('p1', '/etc/passwd');
    expect(requestMock).toHaveBeenCalledTimes(1);
    const path = requestMock.mock.calls[0][0] as string;
    expect(path).not.toContain('..');
  });

  it('normalizes backslashes and calls the backend with a clean path', async () => {
    requestMock.mockResolvedValue(ok({ path: 'src/App.tsx', content: 'x', language: 'tsx' }));
    await workspaceService.readFile('p1', 'src\\App.tsx');
    expect(requestMock).toHaveBeenCalledTimes(1);
    const path = requestMock.mock.calls[0][0] as string;
    // The path is URL-encoded in the query string; decode before checking.
    expect(decodeURIComponent(path)).toContain('src/App.tsx');
    expect(path).not.toContain('..');
  });
});

describe('workspaceService.writeFile', () => {
  it('sends POST with path, content, and overwrite flag', async () => {
    requestMock.mockResolvedValue(ok({ path: 'a.ts', content: 'hi', language: 'ts' }));
    await workspaceService.writeFile('p1', 'a.ts', 'hi', { overwrite: true });
    expect(requestMock).toHaveBeenCalledTimes(1);
    const [, opts] = requestMock.mock.calls[0];
    expect(opts).toMatchObject({ method: 'POST', body: { path: 'a.ts', content: 'hi', overwrite: true } });
  });

  it('rejects traversal paths', async () => {
    await expect(workspaceService.writeFile('p1', '../x', 'hi')).rejects.toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rethrows backend errors as ApiErrorClass', async () => {
    requestMock.mockResolvedValue(err('exists', 'File exists.', 409));
    await expect(workspaceService.writeFile('p1', 'a.ts', 'hi')).rejects.toThrow(/File exists/);
  });
});

describe('workspaceService.deletePath — confirmation guard', () => {
  it('throws without confirm', async () => {
    await expect(workspaceService.deletePath('p1', 'a.ts', false)).rejects.toThrow(/confirmation/i);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('calls backend with confirm=true', async () => {
    requestMock.mockResolvedValue({ data: null, error: null });
    await workspaceService.deletePath('p1', 'a.ts', true);
    expect(requestMock).toHaveBeenCalledTimes(1);
    const [path] = requestMock.mock.calls[0];
    expect(path).toContain('confirm=true');
  });

  it('rejects traversal even with confirm', async () => {
    await expect(workspaceService.deletePath('p1', '../x', true)).rejects.toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('workspaceService.deleteProjectFiles — confirmation guard', () => {
  it('throws without confirm', async () => {
    await expect(workspaceService.deleteProjectFiles('p1', false)).rejects.toThrow(/confirmation/i);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('calls backend when confirmed', async () => {
    requestMock.mockResolvedValue({ data: null, error: null });
    await workspaceService.deleteProjectFiles('p1', true);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

describe('workspaceService.search', () => {
  it('builds query string with q and mode', async () => {
    requestMock.mockResolvedValue(ok({ results: [], mode: 'filename', total: 0 }));
    await workspaceService.search('p1', 'App', 'filename', 50);
    const [path] = requestMock.mock.calls[0];
    expect(path).toContain('q=App');
    expect(path).toContain('mode=filename');
    expect(path).toContain('limit=50');
  });

  it('throws on backend error', async () => {
    requestMock.mockResolvedValue(err('server', 'down', 500));
    await expect(workspaceService.search('p1', 'App')).rejects.toThrow();
  });
});

describe('workspaceService.createEmptyProject', () => {
  it('sends POST to /workspace/create-empty', async () => {
    requestMock.mockResolvedValue(ok({ id: 'p1', name: 'New', path: 'new', template: 'blank', createdAt: 0, updatedAt: 0 }));
    await workspaceService.createEmptyProject('New');
    const [path, opts] = requestMock.mock.calls[0];
    expect(path).toBe('/workspace/create-empty');
    expect(opts).toMatchObject({ method: 'POST', body: { name: 'New' } });
  });
});

describe('workspaceService.importZip', () => {
  it('sends FormData with raw=true', async () => {
    requestMock.mockResolvedValue(ok({ id: 'p1', name: 'imp', path: 'imp', template: 'blank', createdAt: 0, updatedAt: 0 }));
    const file = new File(['x'], 'proj.zip', { type: 'application/zip' });
    await workspaceService.importZip(file, 'imp');
    const [path, opts] = requestMock.mock.calls[0];
    expect(path).toContain('/workspace/import-zip');
    expect(path).toContain('name=imp');
    expect(opts).toMatchObject({ method: 'POST', raw: true });
    expect(opts.body).toBeInstanceOf(FormData);
  });
});

describe('workspaceService.listTree', () => {
  it('calls the tree endpoint with optional params', async () => {
    requestMock.mockResolvedValue(ok([]));
    await workspaceService.listTree('p1', 'src', 2);
    const [path] = requestMock.mock.calls[0];
    expect(path).toContain('/workspace/p1/tree');
    expect(path).toContain('subpath=src');
    expect(path).toContain('depth=2');
  });

  it('omits params when not provided', async () => {
    requestMock.mockResolvedValue(ok([]));
    await workspaceService.listTree('p1');
    const [path] = requestMock.mock.calls[0];
    expect(path).toBe('/workspace/p1/tree');
  });

  it('sends nested subpath for lazy folder expansion', async () => {
    requestMock.mockResolvedValue(ok([
      { id: 'app/crm/page.tsx', name: 'page.tsx', type: 'file', language: 'tsx' },
    ]));
    const result = await workspaceService.listTree('p1', 'app/crm', 1);
    const [path] = requestMock.mock.calls[0];
    expect(path).toContain('subpath=app%2Fcrm');
    expect(path).toContain('depth=1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('app/crm/page.tsx');
  });

  it('sends deeply nested subpath for multi-level lazy loading', async () => {
    requestMock.mockResolvedValue(ok([
      { id: 'app/crm/customers/[id]/page.tsx', name: 'page.tsx', type: 'file', language: 'tsx' },
    ]));
    await workspaceService.listTree('p1', 'app/crm/customers/[id]', 1);
    const [path] = requestMock.mock.calls[0];
    expect(path).toContain('subpath=app');
    expect(path).toContain('crm');
    expect(path).toContain('customers');
  });

  it('returns empty array when backend returns null data', async () => {
    requestMock.mockResolvedValue({ data: null, error: null });
    const result = await workspaceService.listTree('p1', 'empty-dir', 1);
    expect(result).toEqual([]);
  });

  it('throws on backend error for lazy load', async () => {
    requestMock.mockResolvedValue(err('not_found', 'Directory not found.', 404));
    await expect(workspaceService.listTree('p1', 'missing', 1)).rejects.toThrow(/Directory not found/);
  });
});

describe('workspaceService.renamePath', () => {
  it('rejects traversal in either path', async () => {
    await expect(workspaceService.renamePath('p1', '../a', 'b')).rejects.toThrow();
    await expect(workspaceService.renamePath('p1', 'a', '../b')).rejects.toThrow();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('sends both paths sanitized', async () => {
    requestMock.mockResolvedValue(ok({ fromPath: 'a.ts', toPath: 'b.ts' }));
    await workspaceService.renamePath('p1', 'a.ts', 'b.ts');
    const [, opts] = requestMock.mock.calls[0];
    expect(opts.body).toMatchObject({ fromPath: 'a.ts', toPath: 'b.ts', overwrite: false });
  });
});
