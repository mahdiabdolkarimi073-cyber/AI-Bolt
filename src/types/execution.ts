// Phase 10 — execution & terminal types shared across the frontend.

export type ExecSessionStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'timeout';

export type ExecSessionKind =
  | 'command'
  | 'run'
  | 'test'
  | 'build'
  | 'typecheck'
  | 'lint'
  | 'deps'
  | 'preview';

export type ExecSessionSource = 'user' | 'ai_proposed';

export interface DetectedRuntime {
  runtime: string;
  language?: string | null;
  framework?: string | null;
  packageManager?: string | null;
  manifest?: string | null;
  details?: Record<string, unknown>;
  availableTools: Record<string, boolean>;
  missingTools: string[];
  installHint?: string | null;
}

export interface InferredCommand {
  action: string;
  command: string | null;
  kind: ExecSessionKind;
  longRunning: boolean;
  reason: string;
  sensitive: boolean;
  available: boolean;
  missingTool?: string | null;
}

export interface RuntimeDetectionResponse {
  projectId: string;
  runtime: DetectedRuntime;
  commands: InferredCommand[];
  shell: string;
}

export interface ExecSessionSummary {
  id: string;
  projectId: string;
  command: string;
  workingDir: string;
  shell: string;
  kind: ExecSessionKind;
  source: ExecSessionSource;
  longRunning: boolean;
  status: ExecSessionStatus;
  exitCode?: number | null;
  startedAt: number;
  finishedAt?: number | null;
  truncated: boolean;
}

export interface StartSessionRequest {
  projectId: string;
  command: string;
  workingSubdir?: string;
  kind?: ExecSessionKind;
  source?: ExecSessionSource;
  longRunning?: boolean;
  approved?: boolean;
  timeoutS?: number | null;
  shellOverride?: string | null;
}

export interface StartSessionResponse {
  sessionId: string;
  status: ExecSessionStatus;
  streamPath: string;
  shell: string;
  workingDir: string;
}

export interface SessionOutputResponse {
  sessionId: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  previewUrl?: string | null;
  live: boolean;
  status: ExecSessionStatus;
  exitCode?: number | null;
}

export type StreamMessage =
  | { type: 'stream'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'end'; exitCode: number; status: ExecSessionStatus }
  | { type: 'stopped' }
  | { type: 'timeout'; timeoutS: number }
  | { type: 'error'; code: string; message: string };

export interface ProposedChange {
  path: string;
  description: string;
  original: string;
  updated: string;
}

export interface DiagnoseRequest {
  projectId: string;
  sessionId: string;
  conversationId?: string | null;
  connectionId?: string | null;
  model?: string;
  providerId?: string;
  allowSimulation?: boolean;
  maxContextChars?: number;
}

export interface DiagnoseResponse {
  diagnosisId: string;
  status: string;
  analysis?: string | null;
  proposedChanges: ProposedChange[];
  error?: { code: string; message: string } | null;
}

export interface TerminalLine {
  id: string;
  stream: 'stdout' | 'stderr' | 'command' | 'info';
  text: string;
  ts: number;
}
