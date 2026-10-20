export type ProviderId = 'gemini' | 'groq' | 'cerebras' | 'openrouter';

export interface Provider {
  id: ProviderId;
  name: string;
  model: string;
  status: 'connected' | 'disconnected';
}

export interface FileNode {
  id: string;
  name: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  language?: string;
}

export interface OpenTab {
  id: string;
  name: string;
  path: string;
  dirty?: boolean;
  language: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps?: ChatStep[];
  ts: number;
}

export interface ChatStep {
  id: string;
  label: string;
  status: 'running' | 'done' | 'pending';
}

export type SidebarSection =
  | 'projects'
  | 'explorer'
  | 'search'
  | 'history'
  | 'knowledge'
  | 'settings';

export type BottomTab = 'terminal' | 'problems' | 'output' | 'tests' | 'preview';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  variant?: 'info' | 'success' | 'error';
}
