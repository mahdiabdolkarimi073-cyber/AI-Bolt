// Persistent memory & project knowledge base types (Phase 7).
//
// Memory: personal/general durable facts, preferences, conventions, decisions.
// Knowledge: project-scoped durable documentation (summaries, architecture,
// conventions, limitations). The two are kept separate so project-specific
// knowledge never leaks into unrelated projects.

export const MEMORY_TYPES = [
  'preference',
  'convention',
  'decision',
  'constraint',
  'instruction',
  'task',
  'fact',
  'note',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_TYPE_LABELS: Record<MemoryType, string> = {
  preference: 'Preference',
  convention: 'Convention',
  decision: 'Decision',
  constraint: 'Constraint',
  instruction: 'Instruction',
  task: 'Task',
  fact: 'Fact',
  note: 'Note',
};

export const KNOWLEDGE_CATEGORIES = [
  'summary',
  'architecture',
  'convention',
  'limitation',
  'documentation',
  'note',
  'other',
] as const;
export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

export const KNOWLEDGE_CATEGORY_LABELS: Record<KnowledgeCategory, string> = {
  summary: 'Summary',
  architecture: 'Architecture',
  convention: 'Convention',
  limitation: 'Limitation',
  documentation: 'Documentation',
  note: 'Note',
  other: 'Other',
};

/** A persisted memory record. */
export interface Memory {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  projectId: string | null;
  tags: string[];
  importance: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
}

/** A persisted knowledge base entry. */
export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  category: KnowledgeCategory;
  projectId: string | null;
  tags: string[];
  source: string | null;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Paginated list response from the backend. */
export interface ListResult<T> {
  items: T[];
  total: number;
}

/** Input for creating a memory. */
export interface MemoryCreateInput {
  type: MemoryType;
  title: string;
  content: string;
  projectId?: string | null;
  tags?: string[];
  importance?: number;
}

/** Input for updating a memory. All fields optional. */
export interface MemoryUpdateInput {
  type?: MemoryType;
  title?: string;
  content?: string;
  projectId?: string | null;
  tags?: string[];
  importance?: number;
  active?: boolean;
}

export interface KnowledgeCreateInput {
  title: string;
  content: string;
  category: KnowledgeCategory;
  projectId?: string | null;
  tags?: string[];
  source?: string | null;
}

export interface KnowledgeUpdateInput {
  title?: string;
  content?: string;
  category?: KnowledgeCategory;
  projectId?: string | null;
  tags?: string[];
  source?: string | null;
  active?: boolean;
}

/** Query parameters for list/search endpoints. */
export interface MemoryListParams {
  /** 'all' = no project filter; omit = personal/global only; <id> = scoped. */
  projectId?: string | null;
  type?: MemoryType;
  search?: string;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface KnowledgeListParams {
  projectId?: string | null;
  category?: KnowledgeCategory;
  search?: string;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** A single retrieved context item surfaced to the Agent. */
export interface RetrievedContextItem {
  kind: 'memory' | 'knowledge';
  id: string;
  title: string;
  content: string;
  projectId: string | null;
  score: number;
  tags: string[];
}

/** Retrieval metadata returned by the agent run endpoints. */
export interface RetrievalMeta {
  items: RetrievedContextItem[];
  chars: number;
}

/** Defense-in-depth client-side secret detection. Mirrors backend logic. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /AIza[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /password\s*[:=]\s*\S{4,}/i,
  /(api[_-]?key|secret|token)\s*[:=]\s*[A-Za-z0-9_-]{12,}/i,
  /postgresql?:\/\/[^:\s]+:[^@\s]+@/,
  /mongodb(\+srv)?:\/\/[^:\s]+:[^@\s]+@/,
  /redis:\/\/:[^@\s]+@/,
];

export function looksLikeSecret(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 8192);
  return SECRET_PATTERNS.some((p) => p.test(sample));
}

/** Normalize a tag list: lowercase, trimmed, deduped, bounded. */
export function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    const cleaned = String(t).trim().toLowerCase();
    if (!cleaned || seen.has(cleaned)) continue;
    if (cleaned.length > 60) continue;
    seen.add(cleaned);
    out.push(cleaned);
    if (out.length >= 20) break;
  }
  return out;
}
