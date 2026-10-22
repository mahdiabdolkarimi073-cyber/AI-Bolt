import { useCallback, useEffect, useRef, useState } from 'react';
import { executionService } from '@/services/executionService';
import { ApiErrorClass } from '@/lib/errors';
import type { PreviewState, PreviewStatus, PreviewLogsResponse } from '@/types/execution';

export interface UsePreviewResult {
  available: boolean;
  state: PreviewState;
  url: string | null;
  command: string | null;
  error: string | null;
  runtime: string | null;
  framework: string | null;
  logs: Array<{ stream: string; text: string }>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => void;
  starting: boolean;
  stopping: boolean;
  clearError: () => void;
}

const POLL_INTERVAL_MS = 3000;

export function usePreview(projectId: string | null): UsePreviewResult {
  const available = executionService.isAvailable();
  const [state, setState] = useState<PreviewState>('idle');
  const [url, setUrl] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<string | null>(null);
  const [framework, setFramework] = useState<string | null>(null);
  const [logs, setLogs] = useState<Array<{ stream: string; text: string }>>([]);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Reset state when project changes.
  useEffect(() => {
    setState('idle');
    setUrl(null);
    setCommand(null);
    setError(null);
    setRuntime(null);
    setFramework(null);
    setLogs([]);
    if (projectId) {
      void pollStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Poll the backend for preview status while starting or running.
  const pollStatus = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid || !available) return;
    try {
      const status = await executionService.getPreviewStatus(pid);
      if (status.projectId !== projectIdRef.current) return;
      setState(status.state);
      setUrl(status.url ?? null);
      setCommand(status.command ?? null);
      setError(status.error ?? null);
      setRuntime(status.runtime ?? null);
      setFramework(status.framework ?? null);
      if (status.state === 'starting' || status.state === 'running') {
        const logsRes = await executionService.getPreviewLogs(pid);
        if (logsRes.projectId === projectIdRef.current) {
          setLogs(logsRes.lines);
        }
      }
    } catch {
      // Silent — polling errors are transient.
    }
  }, [available]);

  useEffect(() => {
    if (!projectId || !available) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    // Start polling.
    pollRef.current = setInterval(() => {
      void pollStatus();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [projectId, available, pollStatus, refreshKey]);

  const start = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid || !available) return;
    setStarting(true);
    setError(null);
    try {
      const status = await executionService.startPreview(pid);
      if (status.projectId !== projectIdRef.current) return;
      setState(status.state);
      setUrl(status.url ?? null);
      setCommand(status.command ?? null);
      setRuntime(status.runtime ?? null);
      setFramework(status.framework ?? null);
      // Immediately poll for updates since the server takes time to print its URL.
      setRefreshKey((k) => k + 1);
    } catch (e) {
      const msg = e instanceof ApiErrorClass ? e.message : 'Failed to start preview server.';
      setError(msg);
      setState('error');
    } finally {
      setStarting(false);
    }
  }, [available]);

  const stop = useCallback(async () => {
    const pid = projectIdRef.current;
    if (!pid || !available) return;
    setStopping(true);
    try {
      const status = await executionService.stopPreview(pid);
      if (status.projectId !== projectIdRef.current) return;
      setState(status.state);
      setUrl(null);
    } catch (e) {
      const msg = e instanceof ApiErrorClass ? e.message : 'Failed to stop preview server.';
      setError(msg);
    } finally {
      setStopping(false);
    }
  }, [available]);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    available,
    state,
    url,
    command,
    error,
    runtime,
    framework,
    logs,
    start,
    stop,
    refresh,
    starting,
    stopping,
    clearError,
  };
}
