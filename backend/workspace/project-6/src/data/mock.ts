import type {
  FileNode,
  OpenTab,
  ChatMessage,
  Provider,
} from '@/types';

export const providers: Provider[] = [
  { id: 'gemini', name: 'Gemini', model: 'gemini-2.0-flash', status: 'connected' },
  { id: 'groq', name: 'GroqCloud', model: 'llama-3.3-70b', status: 'disconnected' },
  { id: 'cerebras', name: 'Cerebras', model: 'llama-3.1-8b', status: 'disconnected' },
  { id: 'openrouter', name: 'OpenRouter', model: 'auto', status: 'disconnected' },
];

export const sampleFileTree: FileNode[] = [
  {
    id: 'src',
    name: 'src',
    type: 'folder',
    children: [
      {
        id: 'components',
        name: 'components',
        type: 'folder',
        children: [
          { id: 'Button.tsx', name: 'Button.tsx', type: 'file', language: 'tsx' },
          { id: 'Card.tsx', name: 'Card.tsx', type: 'file', language: 'tsx' },
        ],
      },
      { id: 'App.tsx', name: 'App.tsx', type: 'file', language: 'tsx' },
      { id: 'main.tsx', name: 'main.tsx', type: 'file', language: 'tsx' },
      { id: 'styles.css', name: 'styles.css', type: 'file', language: 'css' },
    ],
  },
  {
    id: 'public',
    name: 'public',
    type: 'folder',
    children: [{ id: 'favicon.svg', name: 'favicon.svg', type: 'file', language: 'svg' }],
  },
  { id: 'package.json', name: 'package.json', type: 'file', language: 'json' },
  { id: 'README.md', name: 'README.md', type: 'file', language: 'md' },
];

export const initialTabs: OpenTab[] = [
  { id: 't-app', name: 'App.tsx', path: 'src/App.tsx', language: 'tsx', dirty: true },
  { id: 't-page', name: 'page.tsx', path: 'src/app/page.tsx', language: 'tsx' },
  { id: 't-css', name: 'styles.css', path: 'src/styles.css', language: 'css' },
];

export const sampleFileContents: Record<string, string> = {
  'App.tsx': `import { useState } from "react";
import { Button } from "./components/Button";

// Main application component
export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="app">
      <h1>Counter: {count}</h1>
      <Button onClick={() => setCount((c) => c + 1)}>
        Increment
      </Button>
    </div>
  );
}`,
  'page.tsx': `import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Home",
  description: "Welcome to the landing page",
};

export default function Page() {
  return (
    <main>
      <h1>Welcome</h1>
      <p>Start building something great.</p>
    </main>
  );
}`,
  'styles.css': `:root {
  --primary: #3b82f6;
  --bg: #0a0b0f;
  --text: #d4d7dd;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: "Inter", sans-serif;
}`,
};

export const initialChat: ChatMessage[] = [
  {
    id: 'm1',
    role: 'assistant',
    content:
      'سلام! آماده‌ام برای ساخت، بررسی و بهبود پروژه‌ات کمکت کنم. یک پروژه باز کن یا درخواستت را بنویس تا شروع کنیم.',
    ts: Date.now() - 60000,
  },
  {
    id: 'm2',
    role: 'user',
    content: 'A landing page with a hero and three feature cards.',
    ts: Date.now() - 50000,
  },
  {
    id: 'm3',
    role: 'assistant',
    content: 'Got it. I\'ll scaffold a hero section and three feature cards with responsive layouts.',
    steps: [
      { id: 's1', label: 'Create Hero.tsx', status: 'done' },
      { id: 's2', label: 'Create FeatureCard.tsx', status: 'done' },
      { id: 's3', label: 'Wire up routes', status: 'running' },
    ],
    ts: Date.now() - 40000,
  },
];

export const sampleTerminalLines: string[] = [
  '$ npm run dev',
  '',
  '> vite-react-starter@0.0.0 dev',
  '> vite',
  '',
  '  VITE v5.4.2  ready in 312 ms',
  '',
  '  ➜  Local:   http://localhost:5173/',
  '  ➜  Network: use --host to expose',
  '',
  '$ _',
];

export const sampleProblems = [
  { file: 'App.tsx', line: 12, col: 5, severity: 'warning' as const, message: 'Unused import "Button".' },
  { file: 'page.tsx', line: 3, col: 1, severity: 'info' as const, message: 'Consider adding a meta viewport tag.' },
];

export const sampleOutput = [
  '[info] Build started',
  '[info] Bundling modules...',
  '[info] 24 modules transformed',
  '[success] Build finished in 412ms',
];

export const sampleTests = [
  { name: 'renders counter', status: 'pass' as const, time: '12ms' },
  { name: 'increments on click', status: 'pass' as const, time: '8ms' },
  { name: 'does not overflow on mobile', status: 'skip' as const, time: '—' },
];

export const sampleChatHistory = [
  { id: 'h1', title: 'Landing page with hero', ts: '2m ago' },
  { id: 'h2', title: 'API route for contact form', ts: '1h ago' },
  { id: 'h3', title: 'Fix auth redirect loop', ts: 'Yesterday' },
  { id: 'h4', title: 'Refactor database queries', ts: '2d ago' },
];
