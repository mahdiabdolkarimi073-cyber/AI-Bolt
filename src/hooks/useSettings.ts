import { useEffect, useRef, useState } from 'react';
import { getRepositories } from '@/services';
import { config } from '@/config';
import type { AppSettings, AsyncResult } from '@/types/domain';
import { DEFAULT_SETTINGS } from '@/types/domain';

/**
 * Loads app settings from the active repository on mount and exposes a
 * patched update function that also persists the change.
 *
 * In browser fallback mode this reads/writes localStorage; in backend mode
 * it calls the FastAPI service. The UI is agnostic to which.
 */
export function useSettings() {
  const [state, setState] = useState<AsyncResult<AppSettings>>({ kind: 'loading' });
  const repos = getRepositories();
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    let cancelled = false;
    (async () => {
      try {
        const s = await repos.settings.get();
        if (!cancelled) setState({ kind: 'success', data: { ...DEFAULT_SETTINGS, ...s } });
      } catch {
        if (!cancelled) setState({ kind: 'success', data: DEFAULT_SETTINGS });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repos]);

  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    try {
      const next = await repos.settings.update(patch);
      setState({ kind: 'success', data: next });
    } catch {
      // keep current state on failure; UI remains usable
    }
  };

  return { state, update, backendEnabled: config.backendEnabled };
}
