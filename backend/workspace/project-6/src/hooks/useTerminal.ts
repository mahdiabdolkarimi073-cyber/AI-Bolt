// Phase 10 — useTerminal hook.
//
// Manages terminal sessions for the active project: starting commands (with
// approval gating), streaming live output over WebSocket, tracking status,
// command history, and AI diagnosis. The hook is backend-dependent; when no
// backend is configured it exposes a clear `unavailable` state.

import { useCallback, useEffect, useRef, useState } from 'react';
import { executionService } from '@/services/executionService';
import type {
  DetectedRuntime,
  ExecSessionKind,
  ExecSessionSource,
  ExecSessionStatus,
  ExecSessionSummary,
  InferredCommand,
  ProposedChange,
  RuntimeDetectionResponse,
  SessionOutputResponse,
  StartSessionRequest,
  StreamMessage,
  TerminalLine,
} from '@/types/execution';
import { ApiErrorClass } from '@/lib/errors';

export interface TerminalSessionState {
  id: string;
  projectId: string;
  command: string;
  workingDir: string;
  kind: ExecSessionKind;
  source: ExecSessionSource;
  status: ExecSessionStatus;
  exitCode?: number | null;
  startedAt: number;
  finishedAt?: number | null;
  longRunning: boolean;
  lines: TerminalLine[];
  previewUrl?: string | null;
  ws?: WebSocket | null;
}

export interface PendingApproval {
  request: StartSessionRequest & { reason: string };
  resolve: (approved: boolean) => void;
}

export interface PendingDiagnosis {
  analysis: string;
  changes: ProposedChange[];
  sessionId: string;
  projectId: string;
}

export interface UseTerminalResult {
  available: boolean;
  sessions: TerminalSessionState[];
  activeSessionId: string | null;
  activeSession: TerminalSessionState | null;
  runtime: DetectedRuntime | null;
  commands: InferredCommand[];
  detecting: boolean;
  detectionError: string | null;
  pendingApproval: PendingApproval | null;
  pendingDiagnosis: PendingDiagnosis | null;
  diagnosisBusy: boolean;
  diagnosisError: string | null;
  history: string[];
  error: string | null;
  selectSession: (id: string) => void;
  closeSession: (id: string) => void;
  runCommand: (cmd: {
    command: string;
    kind?: ExecSessionKind;
    source?: ExecSessionSource;
    longRunning?: boolean;
    workingSubdir?: string;
    sensitive?: boolean;
    reason?: string;
  }) => Promise<void>;
  stopSession: (id: string) => Promise<void>;
  clearOutput: (id: string) => Promise<void>;
  approvePending: (approved: boolean) => void;
  refreshRuntime: () => Promise<void>;
  diagnose: (sessionId: string, opts?: { allowSimulation?: boolean }) => Promise<void>;
  dismissDiagnosis: () => void;
  clearError: () => void;
}

const MAX_LINES_PER_SESSION = 4000;
const MAX_HISTORY = 100;

let lineSeq = 0;
function makeLine(stream: TerminalLine['stream'], text: string): TerminalLine {
  lineSeq += 1;
  return { id: `l-${lineSeq}`, stream, text, ts: Date.now() };
}

function appendLines(existing: TerminalLine[], incoming: TerminalLine[]): TerminalLine[] {
  const merged = [...existing, ...incoming];
  if (merged.length <= MAX_LINES_PER_SESSION) return merged;
  return merged.slice(-MAX_LINES_PER_SESSION);
}

export function useTerminal(projectId: string | null): UseTerminalResult {
  const available = executionService.isAvailable();
  const [sessions, setSessions] = useState<TerminalSessionState[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<DetectedRuntime | null>(null);
  const [commands, setCommands] = useState<InferredCommand[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [pendingDiagnosis, setPendingDiagnosis] = useState<PendingDiagnosis | null>(null);
  const [diagnosisBusy, setDiagnosisBusy] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const sessionsRef = useRef<TerminalSessionState[]>([]);
  sessionsRef.current = sessions;

  const updateSession = useCallback((id: string, patch: Partial<TerminalSessionState> | ((s: TerminalSessionState) => Partial<TerminalSessionState>)) => {
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s)));
  }, []);

  const attachStream = useCallback((sessionId: string) => {
    const ws = executionService.openStream(sessionId, {
      onMessage: (msg: StreamMessage) => {
        if (msg.type === 'stream') {
          const lines = msg.text.split('\n');
          const terminalLines = lines.map((l) => makeLine(msg.stream, l));
          // Drop a trailing empty line from the final newline.
          if (terminalLines.length > 0 && terminalLines[terminalLines.length - 1].text === '') {
            terminalLines.pop();
          }
          updateSession(sessionId, (s) => ({ lines: appendLines(s.lines, terminalLines) }));
        } else if (msg.type === 'end') {
          updateSession(sessionId, { status: msg.status, exitCode: msg.exitCode, finishedAt: Date.now() });
        } else if (msg.type === 'stopped') {
          updateSession(sessionId, { status: 'stopped', finishedAt: Date.now() });
        } else if (msg.type === 'timeout') {
          updateSession(sessionId, { status: 'timeout', finishedAt: Date.now() });
          setError(`Command timed out after ${msg.timeoutS}s.`);
        } else if (msg.type === 'error') {
          setError(msg.message);
          updateSession(sessionId, { status: 'failed' });
        }
      },
      onError: () => {
        // WebSocket errors are usually followed by close; surface a soft error.
        setError('Live stream connection was lost. Reconnecting is not automatic.');
      },
    });
    updateSession(sessionId, { ws });
  }, [updateSession]);

  const refreshRuntime = useCallback(async () => {
    if (!projectId) {
      setRuntime(null);
      setCommands([]);
      return;
    }
    if (!available) {
      setDetectionError('Backend is not configured. Terminal & execution require the local backend.');
      return;
    }
    setDetecting(true);
    setDetectionError(null);
    try {
      const res = await executionService.detectRuntime(projectId);
      setRuntime(res.runtime);
      setCommands(res.commands);
    } catch (e) {
      const msg = e instanceof ApiErrorClass ? e.message : 'Failed to detect project runtime.';
      setDetectionError(msg);
      setRuntime(null);
      setCommands([]);
    } finally {
      setDetecting(false);
    }
  }, [projectId, available]);

  useEffect(() => {
    refreshRuntime();
  }, [refreshRuntime]);

  // Cleanup WebSocket on unmount or project switch.
  useEffect(() => {
    return () => {
      sessionsRef.current.forEach((s) => {
        try {
          s.ws?.close();
        } catch {
          // ignore
        }
      });
    };
  }, [projectId]);

  const runCommand = useCallback(async (cmd: {
    command: string;
    kind?: ExecSessionKind;
    source?: ExecSessionSource;
    longRunning?: boolean;
    workingSubdir?: string;
    sensitive?: boolean;
    reason?: string;
  }) => {
    if (!projectId) {
      setError('Open a project first.');
      return;
    }
    if (!available) {
      setError('Backend is not configured. Terminal & execution require the local backend.');
      return;
    }
    const kind = cmd.kind ?? 'command';
    const source = cmd.source ?? 'user';
    const sensitive = cmd.sensitive ?? false;
    const needsApproval = source === 'ai_proposed' || sensitive || kind === 'deps';
    const pid = projectId;

    const baseRequest: StartSessionRequest = {
      projectId: pid,
      command: cmd.command,
      workingSubdir: cmd.workingSubdir ?? '',
      kind,
      source,
      longRunning: cmd.longRunning ?? false,
      approved: !needsApproval,
    };

    if (needsApproval) {
      await new Promise<void>((resolve) => {
        setPendingApproval({
          request: { ...baseRequest, reason: cmd.reason ?? '' },
          resolve: (ok) => {
            setPendingApproval(null);
            if (!ok) {
              resolve();
              return;
            }
            void doStart({ ...baseRequest, approved: true }).then(() => resolve());
          },
        });
      });
      return;
    }
    await doStart(baseRequest);

    async function doStart(req: StartSessionRequest): Promise<void> {
      try {
        const res = await executionService.startSession(req);
        const session: TerminalSessionState = {
          id: res.sessionId,
          projectId: pid,
          command: req.command,
          workingDir: res.workingDir,
          kind,
          source,
          status: res.status,
          startedAt: Date.now(),
          longRunning: req.longRunning ?? false,
          lines: [makeLine('command', `$ ${req.command}`)],
        };
        setSessions((prev) => [...prev, session]);
        setActiveSessionId(res.sessionId);
        setHistory((prev) => [req.command, ...prev.filter((c) => c !== req.command)].slice(0, MAX_HISTORY));
        attachStream(res.sessionId);
      } catch (e) {
        const msg = e instanceof ApiErrorClass ? e.message : 'Failed to start command.';
        setError(msg);
      }
    }
  }, [projectId, available, attachStream]);

  const stopSession = useCallback(async (id: string) => {
    const s = sessionsRef.current.find((x) => x.id === id);
    if (s?.ws) {
      executionService.sendStop(s.ws);
    }
    try {
      await executionService.stopSession(id);
      updateSession(id, { status: 'stopped', finishedAt: Date.now() });
    } catch (e) {
      setError(e instanceof ApiErrorClass ? e.message : 'Failed to stop session.');
    }
  }, [updateSession]);

  const clearOutput = useCallback(async (id: string) => {
    updateSession(id, { lines: [] });
    try {
      await executionService.clearSession(id);
    } catch {
      // non-fatal
    }
  }, [updateSession]);

  const closeSession = useCallback(async (id: string) => {
    const s = sessionsRef.current.find((x) => x.id === id);
    if (s && (s.status === 'running' || s.status === 'pending')) {
      await stopSession(id);
    }
    try {
      s?.ws?.close();
    } catch {
      // ignore
    }
    try {
      await executionService.removeSession(id);
    } catch {
      // non-fatal
    }
    setSessions((prev) => {
      const next = prev.filter((x) => x.id !== id);
      if (activeSessionId === id) {
        setActiveSessionId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  }, [activeSessionId, stopSession]);

  const approvePending = useCallback((approved: boolean) => {
    pendingApproval?.resolve(approved);
  }, [pendingApproval]);

  const diagnose = useCallback(async (sessionId: string, opts?: { allowSimulation?: boolean }) => {
    if (!projectId) return;
    setDiagnosisBusy(true);
    setDiagnosisError(null);
    setPendingDiagnosis(null);
    try {
      const res = await executionService.diagnose({
        projectId,
        sessionId,
        allowSimulation: opts?.allowSimulation ?? true,
      });
      if (res.error) {
        setDiagnosisError(res.error.message);
      } else if (res.proposedChanges.length === 0) {
        setPendingDiagnosis({ analysis: res.analysis ?? 'No specific changes proposed.', changes: [], sessionId, projectId });
      } else {
        setPendingDiagnosis({ analysis: res.analysis ?? '', changes: res.proposedChanges, sessionId, projectId });
      }
    } catch (e) {
      setDiagnosisError(e instanceof ApiErrorClass ? e.message : 'Diagnosis failed.');
    } finally {
      setDiagnosisBusy(false);
    }
  }, [projectId]);

  const dismissDiagnosis = useCallback(() => setPendingDiagnosis(null), []);
  const clearError = useCallback(() => setError(null), []);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  return {
    available,
    sessions,
    activeSessionId,
    activeSession,
    runtime,
    commands,
    detecting,
    detectionError,
    pendingApproval,
    pendingDiagnosis,
    diagnosisBusy,
    diagnosisError,
    history,
    error,
    selectSession: setActiveSessionId,
    closeSession,
    runCommand,
    stopSession,
    clearOutput,
    approvePending,
    refreshRuntime,
    diagnose,
    dismissDiagnosis,
    clearError,
  };
}
