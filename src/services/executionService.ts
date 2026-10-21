// Phase 10 — execution service client.
//
// Talks to the FastAPI backend's /exec routes. All operations require the
// backend to be configured; when it isn't, callers get a clear
// `backend_unavailable` error rather than a silent no-op.

import { config } from '@/config';
import { request } from '@/lib/http';
import { ApiErrorClass } from '@/lib/errors';
import type {
  DiagnoseRequest,
  DiagnoseResponse,
  ExecSessionSummary,
  PreviewLogsResponse,
  PreviewStatus,
  RuntimeDetectionResponse,
  SessionOutputResponse,
  StartSessionRequest,
  StartSessionResponse,
  StreamMessage,
} from '@/types/execution';

function wsUrl(path: string): string {
  const base = config.apiBaseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${base}${path}`;
}

export const executionService = {
  isAvailable(): boolean {
    return config.backendEnabled;
  },

  async detectRuntime(projectId: string): Promise<RuntimeDetectionResponse> {
    const { data, error } = await request<RuntimeDetectionResponse>(
      `/exec/runtime/${encodeURIComponent(projectId)}`,
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('server', 'Empty response from backend.', 500);
    return data;
  },

  async startSession(body: StartSessionRequest): Promise<StartSessionResponse> {
    const { data, error } = await request<StartSessionResponse>('/exec/sessions', {
      method: 'POST',
      body,
    });
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('server', 'Empty response from backend.', 500);
    return data;
  },

  async listSessions(projectId?: string): Promise<ExecSessionSummary[]> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const { data, error } = await request<{ sessions: ExecSessionSummary[] }>(
      `/exec/sessions${qs}`,
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    return data?.sessions ?? [];
  },

  async getOutput(sessionId: string): Promise<SessionOutputResponse> {
    const { data, error } = await request<SessionOutputResponse>(
      `/exec/sessions/${encodeURIComponent(sessionId)}/output`,
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('not_found', 'Session not found.', 404);
    return data;
  },

  async stopSession(sessionId: string): Promise<ExecSessionSummary> {
    const { data, error } = await request<ExecSessionSummary>(
      `/exec/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST' },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('server', 'Empty response from backend.', 500);
    return data;
  },

  async clearSession(sessionId: string): Promise<{ sessionId: string; cleared: boolean }> {
    const { data, error } = await request<{ sessionId: string; cleared: boolean }>(
      `/exec/sessions/${encodeURIComponent(sessionId)}/clear`,
      { method: 'POST' },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    return data ?? { sessionId, cleared: true };
  },

  async removeSession(sessionId: string): Promise<void> {
    const { error } = await request<void>(
      `/exec/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
  },

  async diagnose(body: DiagnoseRequest): Promise<DiagnoseResponse> {
    const { data, error } = await request<DiagnoseResponse>('/exec/diagnose', {
      method: 'POST',
      body,
      timeoutMs: 45_000,
    });
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('server', 'Diagnosis returned no data.', 500);
    return data;
  },

  /** Open a WebSocket to a session's live output stream. Returns the socket
   * and a disposer. The caller wires onmessage/onclose. */
  openStream(sessionId: string, handlers: {
    onMessage: (msg: StreamMessage) => void;
    onError?: (e: Event) => void;
    onClose?: (e: CloseEvent) => void;
  }): WebSocket {
    const ws = new WebSocket(wsUrl(`/exec/sessions/${encodeURIComponent(sessionId)}/stream`));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as StreamMessage;
        handlers.onMessage(msg);
      } catch {
        // Ignore malformed frames.
      }
    };
    ws.onerror = (e) => handlers.onError?.(e);
    ws.onclose = (e) => handlers.onClose?.(e);
    return ws;
  },

  /** Send a stop control message over an open stream socket. */
  sendStop(ws: WebSocket): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
    }
  },

  // --- Preview server management ---

  async startPreview(projectId: string, opts?: { commandOverride?: string; workingSubdir?: string }): Promise<PreviewStatus> {
    const { data, error } = await request<PreviewStatus>(
      `/preview/start/${encodeURIComponent(projectId)}`,
      { method: 'POST', body: { commandOverride: opts?.commandOverride ?? null, workingSubdir: opts?.workingSubdir ?? '' } },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    if (!data) throw new ApiErrorClass('server', 'Empty response from backend.', 500);
    return data;
  },

  async stopPreview(projectId: string): Promise<PreviewStatus> {
    const { data, error } = await request<PreviewStatus>(
      `/preview/stop/${encodeURIComponent(projectId)}`,
      { method: 'POST' },
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    return data ?? { projectId, state: 'idle' };
  },

  async getPreviewStatus(projectId: string): Promise<PreviewStatus> {
    const { data, error } = await request<PreviewStatus>(
      `/preview/status/${encodeURIComponent(projectId)}`,
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    return data ?? { projectId, state: 'idle' };
  },

  async getPreviewLogs(projectId: string): Promise<PreviewLogsResponse> {
    const { data, error } = await request<PreviewLogsResponse>(
      `/preview/logs/${encodeURIComponent(projectId)}`,
    );
    if (error) throw new ApiErrorClass(error.code, error.message, error.status);
    return data ?? { projectId, stdout: '', stderr: '', lines: [] };
  },
};
