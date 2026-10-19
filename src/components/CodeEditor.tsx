import { useMemo, useRef, useEffect, useCallback } from 'react';
import { X, Circle } from 'lucide-react';

interface Props {
  code: string;
  language: string;
  filename: string;
  readOnly?: boolean;
  onChange?: (value: string) => void;
  onSave?: () => void;
}

interface Token {
  type: string;
  value: string;
}

const KEYWORDS = new Set([
  'import', 'from', 'export', 'default', 'const', 'let', 'var', 'function',
  'return', 'if', 'else', 'for', 'while', 'switch', 'case', 'break',
  'class', 'extends', 'new', 'async', 'await', 'try', 'catch', 'finally',
  'interface', 'type', 'enum', 'public', 'private', 'protected', 'static',
  'null', 'undefined', 'true', 'false', 'this', 'super', 'typeof', 'instanceof',
  'void', 'as', 'in', 'of', 'def', 'elif', 'with', 'raise', 'yield', 'lambda',
  'pass', 'None', 'True', 'False', 'self',
]);

const TYPES = new Set([
  'string', 'number', 'boolean', 'any', 'unknown', 'never', 'Metadata',
  'ReactNode', 'useState', 'int', 'float', 'str', 'bool', 'list', 'dict',
]);

function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    const lineComment = rest.match(/^\/\/[^\n]*/);
    if (lineComment) { tokens.push({ type: 'comment', value: lineComment[0] }); i += lineComment[0].length; continue; }
    const blockComment = rest.match(/^\/\*[\s\S]*?\*\//);
    if (blockComment) { tokens.push({ type: 'comment', value: blockComment[0] }); i += blockComment[0].length; continue; }
    const pyComment = rest.match(/^#[^\n]*/);
    if (pyComment) { tokens.push({ type: 'comment', value: pyComment[0] }); i += pyComment[0].length; continue; }
    const str = rest.match(/^"(?:\\.|[^"\\])*"|^'(?:\\.|[^'\\])*'|^`(?:\\.|[^`\\])*`/);
    if (str) { tokens.push({ type: 'string', value: str[0] }); i += str[0].length; continue; }
    const num = rest.match(/^\d[\d.eE_xXa-fA-F]*/);
    if (num) { tokens.push({ type: 'number', value: num[0] }); i += num[0].length; continue; }
    const id = rest.match(/^[A-Za-z_$][\w$]*/);
    if (id) {
      const w = id[0];
      let type = 'plain';
      if (KEYWORDS.has(w)) type = 'keyword';
      else if (TYPES.has(w)) type = 'type';
      else {
        const after = code.slice(i + w.length).match(/^\s*\(/);
        if (after) type = 'fn';
        else if (/^[A-Z]/.test(w)) type = 'type';
      }
      tokens.push({ type, value: w });
      i += w.length;
      continue;
    }
    const prop = rest.match(/^\.[A-Za-z_$][\w$]*/);
    if (prop) { tokens.push({ type: 'prop', value: prop[0] }); i += prop[0].length; continue; }
    const tag = rest.match(/^<\/?[A-Za-z][\w.-]*/);
    if (tag) { tokens.push({ type: 'tag', value: tag[0] }); i += tag[0].length; continue; }
    const ws = rest.match(/^\s+/);
    if (ws) { tokens.push({ type: 'plain', value: ws[0] }); i += ws[0].length; continue; }
    const punct = rest.match(/^[{}()\[\];:,.<>=+\-*/%&|!?]+/);
    if (punct) { tokens.push({ type: 'punct', value: punct[0] }); i += punct[0].length; continue; }
    tokens.push({ type: 'plain', value: code[i] });
    i += 1;
  }
  return tokens;
}

function HighlightedCode({ code }: { code: string }) {
  const tokens = useMemo(() => tokenize(code), [code]);
  const lineSpans = useMemo(() => {
    const result: Token[][] = [];
    let current: Token[] = [];
    for (const t of tokens) {
      const parts = t.value.split('\n');
      parts.forEach((part, idx) => {
        if (idx > 0) {
          result.push(current);
          current = [];
        }
        if (part.length > 0) current.push({ type: t.type, value: part });
      });
    }
    result.push(current);
    return result;
  }, [tokens]);

  return (
    <pre className="pointer-events-none absolute inset-0 m-0 overflow-auto py-3 pl-2 pr-6 font-mono text-[13px] leading-[20px]">
      <code className="block">
        {lineSpans.map((spans, i) => (
          <div key={i} className="min-h-5 whitespace-pre">
            {spans.length === 0 ? (
              <span> </span>
            ) : (
              spans.map((t, j) => (
                <span key={j} className={`tok-${t.type}`}>
                  {t.value}
                </span>
              ))
            )}
          </div>
        ))}
      </code>
    </pre>
  );
}

export function CodeEditor({ code, language, filename, readOnly, onChange, onSave }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lines = useMemo(() => code.split('\n'), [code]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (onSave && (e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        onSave();
        return;
      }
      // Tab inserts spaces instead of moving focus.
      if (e.key === 'Tab' && !readOnly) {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const indent = '  ';
        const newValue = code.slice(0, start) + indent + code.slice(end);
        onChange?.(newValue);
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + indent.length;
        });
      }
    },
    [code, onChange, onSave, readOnly],
  );

  // Sync scroll between textarea and highlight overlay.
  const scrollSync = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pre = ta.parentElement?.querySelector('pre');
    if (pre) {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
    }
  }, []);

  useEffect(() => {
    scrollSync();
  }, [code, scrollSync]);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-surface-950 font-mono text-[13px] leading-[20px]">
      <div className="select-none bg-surface-950 py-3 pl-3 pr-4 text-right text-surface-400">
        {lines.map((_, i) => (
          <div key={i} className="h-5 tabular-nums">
            {i + 1}
          </div>
        ))}
      </div>
      <div className="relative flex-1 overflow-hidden">
        <HighlightedCode code={code} />
        <textarea
          ref={textareaRef}
          value={code}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={handleKeyDown}
          onScroll={scrollSync}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="absolute inset-0 m-0 resize-none overflow-auto bg-transparent py-3 pl-2 pr-6 font-mono text-[13px] leading-[20px] text-transparent caret-gray-100 outline-none"
          style={{ caretColor: '#e5e7eb' }}
        />
      </div>
      <span className="sr-only">{filename} ({language})</span>
    </div>
  );
}

interface TabProps {
  id: string;
  name: string;
  dirty?: boolean;
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}

export function EditorTab({ name, dirty, active, onClick, onClose }: TabProps) {
  return (
    <div
      onClick={onClick}
      className={`group relative flex h-full cursor-pointer items-center gap-2 border-r border-surface-700 px-3 text-2xs transition-colors ${
        active
          ? 'bg-surface-950 text-gray-100'
          : 'bg-surface-850 text-surface-300 hover:bg-surface-800 hover:text-gray-200'
      }`}
    >
      {active && <span className="absolute left-0 top-0 h-[2px] w-full bg-accent-500" />}
      <span className="font-mono text-[11px]">{name}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="rounded p-0.5 opacity-0 transition-opacity hover:bg-surface-600 group-hover:opacity-100"
        aria-label={`Close ${name}`}
      >
        {dirty ? (
          <Circle size={9} className="fill-accent-400 text-accent-400" />
        ) : (
          <X size={12} />
        )}
      </button>
    </div>
  );
}
