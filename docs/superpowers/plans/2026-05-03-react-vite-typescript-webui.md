# React Vite TypeScript Web UI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `frontend/web` from a DOM-driven HTML/JS UI into a React + Vite + TypeScript browser UI while preserving the existing local Node API/SSE server behavior.

**Architecture:** Keep `frontend/web/server.mjs` as the local API, session, SSE, artifact, and workspace server. Introduce a Vite-built React app beside the legacy UI first, verify parity through `/react`, then switch `/` to the React build after core flows pass.

**Tech Stack:** React, ReactDOM, Vite, TypeScript, Vitest, React Testing Library, existing Node `server.mjs`, existing `/api/*` and `/api/events` contracts.

---

## Scope And Assumptions

- Scope is only the browser Web UI under `frontend/web`.
- Do not change the Python runtime protocol unless a frontend parity gap proves that an existing API is insufficient.
- Keep `run_myharness_web.bat` and `scripts/run_myharness_web_server.ps1` as the normal user entrypoint.
- Keep `npm start` as `node server.mjs`.
- Use a side-by-side React preview path first: `http://localhost:4173/react`.
- Vite build assets must not use `/assets/*` because that route currently serves repository assets from `assets/`. Use `/web-assets/*`.
- Keep native browser `title` tooltips out of the React UI. Use `data-tooltip` and the existing/custom tooltip behavior.
- Korean user-facing copy should remain Korean where the current Web UI already uses Korean.

## File Map

### Existing Files To Modify

- `frontend/web/package.json`
  - Add React/Vite/TypeScript dependencies and scripts.
- `frontend/web/package-lock.json`
  - Regenerate with `npm install`.
- `frontend/web/server.mjs`
  - Serve Vite `dist` files.
  - Add `/react` preview route.
  - Later switch `/` to React when parity is confirmed.
- `frontend/web/index.html`
  - Final cutover only: replace legacy static shell with React root.
- `frontend/web/styles.css`
  - Keep as source of design tokens and layout styles during early migration.
  - Gradually move only component-specific CSS into React-owned CSS files if needed.
- `pyproject.toml`
  - Final packaging update so built React assets are included in wheel/sdist flow.
- `Installer.bat`
  - Replace `node --check frontend\web\script.js` with React build/typecheck verification.
- `README.md`
  - Update development verification commands.

### Existing Files To Keep Until Final Cleanup

- `frontend/web/script.js`
- `frontend/web/modules/*.js`
- `frontend/web/tests/*.test.mjs`

These stay in place while `/react` reaches parity. Remove them only after `/` has switched to the React UI and test coverage has moved.

### New Files To Create

- `frontend/web/react.html`
  - Temporary Vite entry for side-by-side React preview.
- `frontend/web/vite.config.ts`
  - Vite build/dev configuration.
- `frontend/web/tsconfig.json`
  - Browser TypeScript configuration.
- `frontend/web/tsconfig.node.json`
  - Vite config TypeScript configuration.
- `frontend/web/src/main.tsx`
  - React entrypoint.
- `frontend/web/src/App.tsx`
  - Main app composition.
- `frontend/web/src/types/backend.ts`
  - API and SSE event contract types.
- `frontend/web/src/types/ui.ts`
  - UI state types.
- `frontend/web/src/api/http.ts`
  - `getJson`, `postJson`, `deleteJson` wrappers.
- `frontend/web/src/api/events.ts`
  - EventSource lifecycle wrapper.
- `frontend/web/src/state/app-state.tsx`
  - React reducer/context/store for Web UI state.
- `frontend/web/src/state/reducer.ts`
  - Reducer and action handling.
- `frontend/web/src/components/AppShell.tsx`
- `frontend/web/src/components/Sidebar.tsx`
- `frontend/web/src/components/ChatPanel.tsx`
- `frontend/web/src/components/MessageList.tsx`
- `frontend/web/src/components/Composer.tsx`
- `frontend/web/src/components/ArtifactPanel.tsx`
- `frontend/web/src/components/ModalHost.tsx`
- `frontend/web/src/components/StatusPill.tsx`
- `frontend/web/src/components/TooltipLayer.tsx`
- `frontend/web/src/components/__tests__/Composer.test.tsx`
- `frontend/web/src/state/__tests__/reducer.test.ts`
- `frontend/web/src/api/__tests__/events.test.ts`

---

## Task 1: Add React/Vite/TypeScript Tooling Without Changing The Current UI

**Files:**
- Modify: `frontend/web/package.json`
- Modify: `frontend/web/package-lock.json`
- Create: `frontend/web/vite.config.ts`
- Create: `frontend/web/tsconfig.json`
- Create: `frontend/web/tsconfig.node.json`
- Create: `frontend/web/react.html`
- Create: `frontend/web/src/main.tsx`
- Create: `frontend/web/src/App.tsx`

- [ ] **Step 1: Update `frontend/web/package.json` scripts and dependencies**

Use this shape, preserving existing dependencies:

```json
{
  "name": "@myharness/web",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.mjs",
    "dev": "vite --host 127.0.0.1",
    "build": "tsc -b && vite build",
    "typecheck": "tsc -b",
    "test": "node --test tests/*.test.mjs && vitest run",
    "test:react": "vitest run"
  },
  "dependencies": {
    "@highlightjs/cdn-assets": "^11.11.1",
    "gpt-tokenizer": "^3.4.0",
    "highlight.js": "^11.11.1",
    "katex": "^0.16.45",
    "marked": "^18.0.2",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.3.0",
    "@testing-library/user-event": "^14.6.1",
    "@types/node": "^22.15.0",
    "@types/react": "^19.1.2",
    "@types/react-dom": "^19.1.2",
    "@vitejs/plugin-react": "^4.4.1",
    "jsdom": "^26.1.0",
    "typescript": "~5.8.3",
    "vite": "^6.3.2",
    "vitest": "^3.1.2"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:

```powershell
cd frontend\web
npm install
```

Expected:

```text
added/changed packages
found 0 vulnerabilities
```

If npm reports audit warnings, do not change unrelated package versions in this task. Record the warning and continue.

- [ ] **Step 3: Create `frontend/web/vite.config.ts`**

```ts
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "web-assets",
    rollupOptions: {
      input: {
        react: resolve(__dirname, "react.html"),
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4173",
      "/assets": "http://127.0.0.1:4173",
      "/vendor": "http://127.0.0.1:4173",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
  },
});
```

- [ ] **Step 4: Create `frontend/web/tsconfig.json`**

```json
{
  "files": [],
  "references": [{ "path": "./tsconfig.node.json" }],
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

- [ ] **Step 5: Create `frontend/web/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "types": ["node"]
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 6: Create temporary React entry `frontend/web/react.html`**

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyHarness React Preview</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Create initial React files**

`frontend/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "../styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("React root element was not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`frontend/web/src/App.tsx`:

```tsx
export default function App() {
  return (
    <div className="app-shell" data-react-webui="true">
      <main className="chat-panel">
        <section className="messages" aria-live="polite">
          <div className="welcome">
            <span className="welcome-mark">MH</span>
            <h2>무엇을 도와드릴까요?</h2>
            <p>React 전환 프리뷰가 준비되었습니다.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
```

- [ ] **Step 8: Verify tooling**

Run:

```powershell
cd frontend\web
npm run typecheck
npm run build
```

Expected:

```text
vite v...
✓ built in ...
```

- [ ] **Step 9: Commit**

```powershell
git add frontend/web/package.json frontend/web/package-lock.json frontend/web/vite.config.ts frontend/web/tsconfig.json frontend/web/tsconfig.node.json frontend/web/react.html frontend/web/src
git commit -m "chore(web): add react vite typescript scaffold"
```

---

## Task 2: Serve React Preview From The Existing Node Web Server

**Files:**
- Modify: `frontend/web/server.mjs`

- [ ] **Step 1: Add Vite dist constants near existing root constants**

Add after `const webRoot = normalize(root);`:

```js
const webDistRoot = normalize(join(root, "dist"));
```

- [ ] **Step 2: Add React preview path helper near `isPageVisitPath`**

```js
function isReactPreviewPath(pathname) {
  return pathname === "/react" || pathname === "/react/";
}
```

- [ ] **Step 3: Update `resolvePath` to serve React preview and Vite assets**

Change the `filePath` selection so these cases are checked before the legacy root fallback:

```js
const filePath =
  isReactPreviewPath(pathname)
    ? (existsSync(join(webDistRoot, "react.html")) ? join(webDistRoot, "react.html") : join(root, "react.html"))
    : pathname.startsWith("/web-assets/")
      ? join(webDistRoot, pathname.replace(/^\/+/, ""))
      : pathname === "/"
        ? join(root, "index.html")
        : pathname === "/vendor/marked/marked.esm.js"
```

Keep the existing vendor and repository asset cases unchanged.

- [ ] **Step 4: Allow `dist` in the path safety check**

Update the safety check:

```js
if (
  normalized !== webRoot &&
  !normalized.startsWith(webRoot) &&
  normalized !== webDistRoot &&
  !normalized.startsWith(webDistRoot) &&
  !normalized.startsWith(assetsRoot) &&
  !normalized.startsWith(vendorRoot)
) {
  return null;
}
```

- [ ] **Step 5: Build and start the existing server**

Run:

```powershell
cd frontend\web
npm run build
npm start
```

Expected:

```text
MyHarness web server listening on ...
```

- [ ] **Step 6: Browser check**

Open `http://localhost:4173/react` in the Codex app browser.

Expected:

- React preview renders.
- No console errors.
- `/` still renders the legacy UI.
- `/assets/logo.png` and other repository assets still work.
- `/web-assets/*` Vite assets return 200.

- [ ] **Step 7: Commit**

```powershell
git add frontend/web/server.mjs
git commit -m "feat(web): serve react preview build"
```

---

## Task 3: Define TypeScript API And Event Contracts

**Files:**
- Create: `frontend/web/src/types/backend.ts`
- Create: `frontend/web/src/api/http.ts`
- Create: `frontend/web/src/api/events.ts`
- Create: `frontend/web/src/api/__tests__/events.test.ts`

- [ ] **Step 1: Create `frontend/web/src/types/backend.ts`**

```ts
export type WorkspaceScope = {
  mode: "shared" | "ip" | string;
  name: string;
  root: string;
};

export type Workspace = {
  name: string;
  path: string;
  scope?: WorkspaceScope;
};

export type Attachment = {
  media_type: string;
  data: string;
  name: string;
};

export type BackendStateSnapshot = {
  provider?: string;
  provider_label?: string;
  model?: string;
  effort?: string;
  permission_mode?: string;
  cwd?: string;
  workspace?: Workspace;
};

export type TranscriptItem = {
  role: "system" | "user" | "assistant" | "tool" | "tool_result" | "log";
  text: string;
  kind?: "steering" | "queued" | null;
  tool_name?: string | null;
  tool_input?: Record<string, unknown> | null;
  is_error?: boolean | null;
};

export type BackendEvent =
  | { type: "ready"; state?: BackendStateSnapshot; commands?: unknown[]; skills?: unknown[]; tasks?: unknown[] }
  | { type: "state_snapshot"; state?: BackendStateSnapshot }
  | { type: "transcript_item"; item?: TranscriptItem }
  | { type: "assistant_delta"; value?: string }
  | { type: "assistant_complete"; has_tool_uses?: boolean | null }
  | { type: "tool_started"; tool_name?: string; tool_input?: Record<string, unknown> | null }
  | { type: "tool_progress"; tool_name?: string; message?: string; tool_input?: Record<string, unknown> | null }
  | { type: "tool_completed"; tool_name?: string; output?: string; is_error?: boolean | null }
  | { type: "line_complete"; quiet?: boolean }
  | { type: "modal_request"; modal?: Record<string, unknown> | null }
  | { type: "select_request"; select_options?: Array<Record<string, unknown>> | null; message?: string | null }
  | { type: "todo_update"; todo_markdown?: string | null }
  | { type: "plan_mode_change"; plan_mode?: string | null }
  | { type: "history_snapshot"; history_events?: Array<Record<string, unknown>> | null }
  | { type: "status"; message?: string | null; value?: string | null }
  | { type: "error"; message?: string | null }
  | { type: "shutdown"; message?: string | null }
  | { type: string; [key: string]: unknown };

export type SessionResponse = {
  sessionId: string;
  clientId?: string;
  frontendId?: string;
  workspace?: Workspace;
};
```

- [ ] **Step 2: Create `frontend/web/src/api/http.ts`**

```ts
async function readError(response: Response): Promise<Error> {
  const body = await response.text();
  let message = body || `HTTP ${response.status}`;
  try {
    const data = body ? JSON.parse(body) : null;
    if (data?.error) {
      message = String(data.error);
    }
  } catch {
    // Keep raw text when the server returns non-JSON.
  }
  const error = new Error(message) as Error & { status?: number };
  error.status = response.status;
  return error;
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<T>;
}

export async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<T>;
}

export async function deleteJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<T>;
}
```

- [ ] **Step 3: Create `frontend/web/src/api/events.ts`**

```ts
import type { BackendEvent } from "../types/backend";

export type EventHandlers = {
  onEvent(event: BackendEvent): void;
  onError(error: Event): void;
};

export function openBackendEvents(params: URLSearchParams, handlers: EventHandlers): EventSource {
  const source = new EventSource(`/api/events?${params.toString()}`);

  source.onmessage = (message) => {
    try {
      handlers.onEvent(JSON.parse(message.data) as BackendEvent);
    } catch {
      handlers.onEvent({ type: "error", message: "이벤트를 해석하지 못했습니다." });
    }
  };

  source.onerror = (error) => {
    handlers.onError(error);
  };

  return source;
}
```

- [ ] **Step 4: Add event parsing test**

`frontend/web/src/api/__tests__/events.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { openBackendEvents } from "../events";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: ((error: Event) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
}

describe("openBackendEvents", () => {
  it("parses backend event messages", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onEvent = vi.fn();

    openBackendEvents(new URLSearchParams({ sessionId: "s1" }), {
      onEvent,
      onError: vi.fn(),
    });

    FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ type: "assistant_delta", value: "안녕하세요" }),
    } as MessageEvent<string>);

    expect(onEvent).toHaveBeenCalledWith({ type: "assistant_delta", value: "안녕하세요" });
  });
});
```

- [ ] **Step 5: Verify**

Run:

```powershell
cd frontend\web
npm run typecheck
npm run test:react
```

Expected:

```text
PASS src/api/__tests__/events.test.ts
```

- [ ] **Step 6: Commit**

```powershell
git add frontend/web/src/types frontend/web/src/api
git commit -m "feat(web): add typed api contracts"
```

---

## Task 4: Build The React State Store And Reducer

**Files:**
- Create: `frontend/web/src/types/ui.ts`
- Create: `frontend/web/src/state/reducer.ts`
- Create: `frontend/web/src/state/app-state.tsx`
- Create: `frontend/web/src/state/__tests__/reducer.test.ts`

- [ ] **Step 1: Create UI state types**

`frontend/web/src/types/ui.ts`:

```ts
import type { Attachment, TranscriptItem, Workspace, WorkspaceScope } from "./backend";

export type StatusKind =
  | "connecting"
  | "startingBackend"
  | "ready"
  | "thinking"
  | "sending"
  | "processing"
  | "restoring"
  | "error"
  | "stopped"
  | "startFailed"
  | "connectionError";

export type ChatMessage = {
  id: string;
  role: TranscriptItem["role"];
  text: string;
  toolName?: string;
  isError?: boolean;
};

export type ComposerState = {
  draft: string;
  attachments: Attachment[];
  pastedTexts: string[];
  token: string | null;
};

export type AppState = {
  sessionId: string | null;
  clientId: string;
  ready: boolean;
  busy: boolean;
  status: StatusKind;
  statusText: string;
  provider: string;
  model: string;
  effort: string;
  permissionMode: string;
  workspaceName: string;
  workspacePath: string;
  workspaceScope: WorkspaceScope;
  workspaces: Workspace[];
  messages: ChatMessage[];
  composer: ComposerState;
};
```

- [ ] **Step 2: Create reducer**

`frontend/web/src/state/reducer.ts`:

```ts
import type { BackendEvent } from "../types/backend";
import type { AppState, ChatMessage } from "../types/ui";

export type AppAction =
  | { type: "backend_event"; event: BackendEvent }
  | { type: "set_draft"; value: string }
  | { type: "set_busy"; value: boolean }
  | { type: "clear_composer" };

export const initialAppState: AppState = {
  sessionId: null,
  clientId: "",
  ready: false,
  busy: false,
  status: "connecting",
  statusText: "연결 중",
  provider: "-",
  model: "-",
  effort: "-",
  permissionMode: "-",
  workspaceName: "",
  workspacePath: "",
  workspaceScope: { mode: "shared", name: "shared", root: "" },
  workspaces: [],
  messages: [],
  composer: {
    draft: "",
    attachments: [],
    pastedTexts: [],
    token: null,
  },
};

function appendMessage(messages: ChatMessage[], message: Omit<ChatMessage, "id">): ChatMessage[] {
  return [...messages, { id: crypto.randomUUID(), ...message }];
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "set_draft":
      return { ...state, composer: { ...state.composer, draft: action.value } };

    case "set_busy":
      return { ...state, busy: action.value };

    case "clear_composer":
      return {
        ...state,
        composer: { draft: "", attachments: [], pastedTexts: [], token: null },
      };

    case "backend_event": {
      const event = action.event;
      if (event.type === "ready") {
        const snapshot = event.state || {};
        return {
          ...state,
          ready: true,
          status: "ready",
          statusText: "준비됨",
          provider: String(snapshot.provider_label || snapshot.provider || state.provider),
          model: String(snapshot.model || state.model),
          effort: String(snapshot.effort || state.effort),
          permissionMode: String(snapshot.permission_mode || state.permissionMode),
          workspaceName: String(snapshot.workspace?.name || state.workspaceName),
          workspacePath: String(snapshot.workspace?.path || state.workspacePath),
          workspaceScope: snapshot.workspace?.scope || state.workspaceScope,
        };
      }

      if (event.type === "status") {
        return {
          ...state,
          statusText: String(event.message || event.value || state.statusText),
        };
      }

      if (event.type === "transcript_item" && event.item) {
        return {
          ...state,
          messages: appendMessage(state.messages, {
            role: event.item.role,
            text: event.item.text,
            toolName: event.item.tool_name || undefined,
            isError: event.item.is_error === true,
          }),
        };
      }

      if (event.type === "assistant_delta") {
        const value = String(event.value || "");
        const last = state.messages[state.messages.length - 1];
        if (last?.role === "assistant") {
          return {
            ...state,
            messages: [
              ...state.messages.slice(0, -1),
              { ...last, text: `${last.text}${value}` },
            ],
          };
        }
        return {
          ...state,
          messages: appendMessage(state.messages, { role: "assistant", text: value }),
        };
      }

      if (event.type === "error") {
        return {
          ...state,
          status: "error",
          statusText: String(event.message || "오류"),
        };
      }

      return state;
    }

    default:
      return state;
  }
}
```

- [ ] **Step 3: Create context provider**

`frontend/web/src/state/app-state.tsx`:

```tsx
import { createContext, useContext, useMemo, useReducer } from "react";
import { appReducer, initialAppState, type AppAction } from "./reducer";
import type { AppState } from "../types/ui";

type AppStateContextValue = {
  state: AppState;
  dispatch: React.Dispatch<AppAction>;
};

const AppStateContext = createContext<AppStateContextValue | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const value = useContext(AppStateContext);
  if (!value) {
    throw new Error("useAppState must be used inside AppStateProvider");
  }
  return value;
}
```

- [ ] **Step 4: Add reducer tests**

`frontend/web/src/state/__tests__/reducer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { appReducer, initialAppState } from "../reducer";

vi.stubGlobal("crypto", { randomUUID: () => "message-1" });

describe("appReducer", () => {
  it("applies ready snapshots", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "ready",
        state: {
          provider: "codex",
          provider_label: "Codex",
          model: "gpt-5",
          effort: "medium",
          permission_mode: "full_auto",
          workspace: {
            name: "Default",
            path: "C:/demo",
            scope: { mode: "shared", name: "shared", root: "C:/root" },
          },
        },
      },
    });

    expect(next.ready).toBe(true);
    expect(next.statusText).toBe("준비됨");
    expect(next.workspaceName).toBe("Default");
  });

  it("appends assistant deltas to the active assistant message", () => {
    const first = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_delta", value: "안녕" },
    });
    const second = appReducer(first, {
      type: "backend_event",
      event: { type: "assistant_delta", value: "하세요" },
    });

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].text).toBe("안녕하세요");
  });
});
```

- [ ] **Step 5: Wire provider in `App.tsx`**

```tsx
import { AppStateProvider } from "./state/app-state";

function AppContent() {
  return (
    <div className="app-shell" data-react-webui="true">
      <main className="chat-panel">
        <section className="messages" aria-live="polite">
          <div className="welcome">
            <span className="welcome-mark">MH</span>
            <h2>무엇을 도와드릴까요?</h2>
            <p>React 전환 프리뷰가 준비되었습니다.</p>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppStateProvider>
      <AppContent />
    </AppStateProvider>
  );
}
```

- [ ] **Step 6: Verify**

Run:

```powershell
cd frontend\web
npm run typecheck
npm run test:react
```

Expected:

```text
PASS src/state/__tests__/reducer.test.ts
```

- [ ] **Step 7: Commit**

```powershell
git add frontend/web/src/types/ui.ts frontend/web/src/state frontend/web/src/App.tsx
git commit -m "feat(web): add react state reducer"
```

---

## Task 5: Port The Stable App Shell

**Files:**
- Create: `frontend/web/src/components/AppShell.tsx`
- Create: `frontend/web/src/components/Sidebar.tsx`
- Create: `frontend/web/src/components/ChatPanel.tsx`
- Create: `frontend/web/src/components/StatusPill.tsx`
- Create: `frontend/web/src/components/TooltipLayer.tsx`
- Modify: `frontend/web/src/App.tsx`

- [ ] **Step 1: Create `StatusPill.tsx`**

```tsx
import { useAppState } from "../state/app-state";

export function StatusPill() {
  const { state } = useAppState();
  return (
    <div className="status-pill" id="readyPill">
      {state.statusText}
    </div>
  );
}
```

- [ ] **Step 2: Create `Sidebar.tsx`**

```tsx
import { useAppState } from "../state/app-state";

export function Sidebar() {
  const { state } = useAppState();

  return (
    <aside className="sidebar" aria-label="채팅 탐색">
      <div className="brand-row">
        <a className="brand" href="#" aria-label="MyHarness 채팅 홈">
          <span className="brand-name">MyHarness</span>
        </a>
      </div>

      <div className="sidebar-project-menu">
        <button
          className="sidebar-project"
          type="button"
          data-action="open-workspace"
          aria-label="프로젝트 선택"
          aria-expanded="false"
          data-tooltip="현재 프로젝트 선택"
        >
          <span className="sidebar-project-icon" aria-hidden="true" />
          <strong>{state.workspaceName || "Default"}</strong>
        </button>
      </div>

      <button className="new-chat" type="button" data-action="new-chat" aria-label="새 채팅">
        <span aria-hidden="true" />
        새 채팅
      </button>

      <section className="history-panel" aria-label="Chat History">
        <div className="history-heading">
          <span className="section-label">Chat History</span>
          <button className="history-refresh" type="button">
            Restart
          </button>
        </div>
        <div className="history-list">
          <p className="empty">대화 내역을 불러오는 중...</p>
        </div>
      </section>

      <button className="sidebar-footer" type="button" data-action="open-model-settings" aria-label="모델 설정 열기" data-tooltip="모델 설정">
        <span className="profile-mark" aria-hidden="true">MH</span>
        <div className="runtime-copy">
          <strong>Provider: {state.provider}</strong>
          <small>Model: {state.model}</small>
        </div>
      </button>
    </aside>
  );
}
```

- [ ] **Step 3: Create `ChatPanel.tsx`**

```tsx
import { StatusPill } from "./StatusPill";

export function ChatPanel() {
  return (
    <main className="chat-panel">
      <header className="chat-header">
        <div className="header-left">
          <button className="chat-title" type="button">
            <span>MyHarness</span>
          </button>
        </div>
        <div className="header-actions">
          <StatusPill />
        </div>
      </header>

      <section className="messages" aria-live="polite">
        <div className="welcome">
          <span className="welcome-mark">MH</span>
          <h2>무엇을 도와드릴까요?</h2>
          <p>업무에 필요한 조사, 정리, 코드 작업을 도와드릴 준비가 되어 있습니다.</p>
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Create `TooltipLayer.tsx`**

```tsx
export function TooltipLayer() {
  return null;
}
```

This task only prevents native `title` usage. A custom tooltip renderer can be added later if parity requires it.

- [ ] **Step 5: Create `AppShell.tsx`**

```tsx
import { ChatPanel } from "./ChatPanel";
import { Sidebar } from "./Sidebar";
import { TooltipLayer } from "./TooltipLayer";

export function AppShell() {
  return (
    <div className="app-shell" data-react-webui="true">
      <Sidebar />
      <ChatPanel />
      <TooltipLayer />
    </div>
  );
}
```

- [ ] **Step 6: Update `App.tsx`**

```tsx
import { AppShell } from "./components/AppShell";
import { AppStateProvider } from "./state/app-state";

export default function App() {
  return (
    <AppStateProvider>
      <AppShell />
    </AppStateProvider>
  );
}
```

- [ ] **Step 7: Visual check**

Run:

```powershell
cd frontend\web
npm run build
npm start
```

Open `http://localhost:4173/react` in the Codex app browser.

Expected:

- Sidebar and chat shell render.
- No obvious overlap or text clipping at desktop width.
- Console has no errors.

- [ ] **Step 8: Commit**

```powershell
git add frontend/web/src/components frontend/web/src/App.tsx
git commit -m "feat(web): port react app shell"
```

---

## Task 6: Port Session Startup And SSE Event Flow

**Files:**
- Create: `frontend/web/src/api/session.ts`
- Create: `frontend/web/src/hooks/useBackendSession.ts`
- Modify: `frontend/web/src/App.tsx`
- Modify: `frontend/web/src/state/reducer.ts`
- Modify: `frontend/web/src/types/backend.ts`

- [ ] **Step 1: Create `frontend/web/src/api/session.ts`**

```ts
import { postJson } from "./http";
import type { SessionResponse } from "../types/backend";

export function startSession(payload: Record<string, unknown>) {
  return postJson<SessionResponse>("/api/session", payload);
}
```

- [ ] **Step 2: Extend reducer with session action**

Add to `AppAction`:

```ts
| { type: "session_started"; sessionId: string; clientId?: string }
```

Add case:

```ts
case "session_started":
  return {
    ...state,
    sessionId: action.sessionId,
    clientId: action.clientId || state.clientId,
    status: "ready",
    statusText: "준비됨",
  };
```

- [ ] **Step 3: Create `frontend/web/src/hooks/useBackendSession.ts`**

```ts
import { useEffect, useRef } from "react";
import { openBackendEvents } from "../api/events";
import { startSession } from "../api/session";
import { useAppState } from "../state/app-state";

export function useBackendSession() {
  const { state, dispatch } = useAppState();
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (state.sessionId) {
        return;
      }

      const session = await startSession({
        clientId: state.clientId || undefined,
      });

      if (cancelled) {
        return;
      }

      dispatch({
        type: "session_started",
        sessionId: session.sessionId,
        clientId: session.clientId,
      });
    }

    void boot().catch((error) => {
      dispatch({
        type: "backend_event",
        event: { type: "error", message: error instanceof Error ? error.message : String(error) },
      });
    });

    return () => {
      cancelled = true;
    };
  }, [dispatch, state.clientId, state.sessionId]);

  useEffect(() => {
    if (!state.sessionId || sourceRef.current) {
      return;
    }

    const params = new URLSearchParams({
      sessionId: state.sessionId,
      clientId: state.clientId,
    });

    sourceRef.current = openBackendEvents(params, {
      onEvent: (event) => dispatch({ type: "backend_event", event }),
      onError: () => dispatch({ type: "backend_event", event: { type: "error", message: "이벤트 연결 오류" } }),
    });

    return () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };
  }, [dispatch, state.clientId, state.sessionId]);
}
```

- [ ] **Step 4: Call hook from app content**

In `App.tsx`:

```tsx
import { AppShell } from "./components/AppShell";
import { useBackendSession } from "./hooks/useBackendSession";
import { AppStateProvider } from "./state/app-state";

function AppContent() {
  useBackendSession();
  return <AppShell />;
}

export default function App() {
  return (
    <AppStateProvider>
      <AppContent />
    </AppStateProvider>
  );
}
```

- [ ] **Step 5: Verify against real server**

Run:

```powershell
cd frontend\web
npm run build
npm start
```

Open `http://localhost:4173/react`.

Expected:

- Status reaches `준비됨`.
- Provider/model footer updates after `ready`.
- Network tab shows `/api/session` 200.
- Network tab shows `/api/events?...` open.
- No duplicate backend sessions are created on one page load.

- [ ] **Step 6: Commit**

```powershell
git add frontend/web/src/api/session.ts frontend/web/src/hooks frontend/web/src/App.tsx frontend/web/src/state/reducer.ts frontend/web/src/types/backend.ts
git commit -m "feat(web): connect react ui to backend events"
```

---

## Task 7: Port Composer And Basic Message Send

**Files:**
- Create: `frontend/web/src/components/Composer.tsx`
- Create: `frontend/web/src/components/__tests__/Composer.test.tsx`
- Create: `frontend/web/src/api/messages.ts`
- Modify: `frontend/web/src/components/ChatPanel.tsx`
- Modify: `frontend/web/src/state/reducer.ts`

- [ ] **Step 1: Create message API**

`frontend/web/src/api/messages.ts`:

```ts
import { postJson } from "./http";

export type SendMessagePayload = {
  sessionId: string;
  clientId: string;
  line: string;
  attachments?: unknown[];
};

export function sendMessage(payload: SendMessagePayload) {
  return postJson<Record<string, unknown>>("/api/message", payload);
}
```

- [ ] **Step 2: Create `Composer.tsx`**

```tsx
import { FormEvent } from "react";
import { sendMessage } from "../api/messages";
import { useAppState } from "../state/app-state";

export function Composer() {
  const { state, dispatch } = useAppState();
  const draft = state.composer.draft;
  const canSend = Boolean(state.sessionId && draft.trim() && !state.busy);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const line = draft.trim();
    if (!state.sessionId || !line) {
      return;
    }

    dispatch({ type: "set_busy", value: true });
    dispatch({
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "user", text: line } },
    });
    dispatch({ type: "clear_composer" });

    try {
      await sendMessage({
        sessionId: state.sessionId,
        clientId: state.clientId,
        line,
        attachments: state.composer.attachments,
      });
    } catch (error) {
      dispatch({
        type: "backend_event",
        event: { type: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  return (
    <form className="composer" onSubmit={handleSubmit}>
      <div className="composer-box">
        <textarea
          rows={1}
          placeholder="메세지를 입력하세요..."
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(event) => dispatch({ type: "set_draft", value: event.currentTarget.value })}
        />
        <button type="submit" disabled={!canSend} aria-label="메시지 보내기">
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m22 2-7 20-4-9-9-4Z" />
            <path d="M22 2 11 13" />
          </svg>
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 3: Add composer test**

`frontend/web/src/components/__tests__/Composer.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Composer } from "../Composer";
import { AppStateProvider } from "../../state/app-state";

describe("Composer", () => {
  it("keeps send disabled until text exists", async () => {
    render(
      <AppStateProvider>
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메세지를 입력하세요...");
    const send = screen.getByRole("button", { name: "메시지 보내기" });

    expect(send).toBeDisabled();
    await userEvent.type(input, "hello");
    expect(send).toBeDisabled();
  });
});
```

This test stays disabled because no session exists. A later integration test covers enabled state after session startup.

- [ ] **Step 4: Render composer in `ChatPanel.tsx`**

```tsx
import { Composer } from "./Composer";
import { StatusPill } from "./StatusPill";

export function ChatPanel() {
  return (
    <main className="chat-panel">
      <header className="chat-header">
        <div className="header-left">
          <button className="chat-title" type="button">
            <span>MyHarness</span>
          </button>
        </div>
        <div className="header-actions">
          <StatusPill />
        </div>
      </header>

      <section className="messages" aria-live="polite">
        <div className="welcome">
          <span className="welcome-mark">MH</span>
          <h2>무엇을 도와드릴까요?</h2>
          <p>업무에 필요한 조사, 정리, 코드 작업을 도와드릴 준비가 되어 있습니다.</p>
        </div>
      </section>

      <Composer />
    </main>
  );
}
```

- [ ] **Step 5: Verify**

Run:

```powershell
cd frontend\web
npm run typecheck
npm run test:react
npm run build
```

Open `http://localhost:4173/react` and send a short test message.

Expected:

- User message appears immediately.
- Assistant streaming starts through SSE.
- Composer clears after send.
- No console errors.

- [ ] **Step 6: Commit**

```powershell
git add frontend/web/src/api/messages.ts frontend/web/src/components/Composer.tsx frontend/web/src/components/__tests__/Composer.test.tsx frontend/web/src/components/ChatPanel.tsx frontend/web/src/state/reducer.ts
git commit -m "feat(web): add react composer"
```

---

## Task 8: Port Message Rendering And Streaming Parity

**Files:**
- Create: `frontend/web/src/components/MessageList.tsx`
- Modify: `frontend/web/src/components/ChatPanel.tsx`
- Modify: `frontend/web/src/state/reducer.ts`
- Port reference from: `frontend/web/modules/messages.js`
- Port reference from: `frontend/web/modules/events.js`

- [ ] **Step 1: Create basic message list**

`frontend/web/src/components/MessageList.tsx`:

```tsx
import { useAppState } from "../state/app-state";

export function MessageList() {
  const { state } = useAppState();

  if (!state.messages.length) {
    return (
      <section className="messages" aria-live="polite">
        <div className="welcome">
          <span className="welcome-mark">MH</span>
          <h2>무엇을 도와드릴까요?</h2>
          <p>업무에 필요한 조사, 정리, 코드 작업을 도와드릴 준비가 되어 있습니다.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="messages" aria-live="polite">
      {state.messages.map((message) => (
        <article className={`message ${message.role}`} key={message.id}>
          <div className="message-content">
            {message.text}
          </div>
        </article>
      ))}
    </section>
  );
}
```

- [ ] **Step 2: Replace welcome section in `ChatPanel.tsx`**

```tsx
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { StatusPill } from "./StatusPill";

export function ChatPanel() {
  return (
    <main className="chat-panel">
      <header className="chat-header">
        <div className="header-left">
          <button className="chat-title" type="button">
            <span>MyHarness</span>
          </button>
        </div>
        <div className="header-actions">
          <StatusPill />
        </div>
      </header>

      <MessageList />
      <Composer />
    </main>
  );
}
```

- [ ] **Step 3: Port markdown rendering**

Use `marked` and `katex` through Vite imports rather than `/vendor` script imports:

```ts
import { marked } from "marked";
import katex from "katex";
```

Create a small renderer in `frontend/web/src/components/MarkdownMessage.tsx` only after plain message rendering works. Keep the first version limited to:

- paragraphs
- fenced code
- inline code
- links
- KaTeX blocks if current behavior depends on them

- [ ] **Step 4: Port streaming behavior**

Reducer behavior required:

- `assistant_delta` appends to the active assistant message.
- `assistant_complete` sets `busy` false unless a tool call is still active.
- `line_complete` sets `busy` false.
- `tool_started`, `tool_progress`, `tool_completed` create or update visible tool/workflow rows.

Add actions only when tests describe expected behavior.

- [ ] **Step 5: Add reducer tests for line completion and tools**

Add to `frontend/web/src/state/__tests__/reducer.test.ts`:

```ts
it("marks the ui idle on line completion", () => {
  const busy = appReducer(initialAppState, { type: "set_busy", value: true });
  const next = appReducer(busy, { type: "backend_event", event: { type: "line_complete" } });
  expect(next.busy).toBe(false);
});

it("renders tool completion as a tool message", () => {
  const next = appReducer(initialAppState, {
    type: "backend_event",
    event: { type: "tool_completed", tool_name: "bash", output: "done" },
  });
  expect(next.messages[0].role).toBe("tool");
  expect(next.messages[0].text).toContain("done");
});
```

- [ ] **Step 6: Verify**

Run:

```powershell
cd frontend\web
npm run typecheck
npm run test:react
npm run build
```

Manual browser scenarios at `http://localhost:4173/react`:

- Send a normal prompt.
- Send a prompt that runs a shell command.
- Send a prompt that creates a file.
- Confirm streaming text does not duplicate.
- Confirm final answer remains readable.
- Confirm no console errors.

- [ ] **Step 7: Commit**

```powershell
git add frontend/web/src/components/MessageList.tsx frontend/web/src/components/ChatPanel.tsx frontend/web/src/state/reducer.ts frontend/web/src/state/__tests__/reducer.test.ts
git commit -m "feat(web): port message rendering"
```

---

## Task 9: Port Sidebar, History, Workspaces, And Runtime Controls

**Files:**
- Modify: `frontend/web/src/components/Sidebar.tsx`
- Create: `frontend/web/src/api/workspaces.ts`
- Create: `frontend/web/src/api/history.ts`
- Modify: `frontend/web/src/state/reducer.ts`
- Port reference from: `frontend/web/modules/history.js`
- Port reference from: `frontend/web/modules/api.js`
- Port reference from: `frontend/web/modules/ui.js`

- [ ] **Step 1: Add workspace API wrappers**

`frontend/web/src/api/workspaces.ts`:

```ts
import { deleteJson, getJson, postJson } from "./http";
import type { Workspace } from "../types/backend";

export function listWorkspaces() {
  return getJson<{ workspaces: Workspace[] }>("/api/workspaces");
}

export function createWorkspace(name: string) {
  return postJson<{ workspace: Workspace }>("/api/workspaces", { name });
}

export function deleteWorkspace(name: string) {
  return deleteJson<{ ok: true }>("/api/workspaces", { name });
}
```

- [ ] **Step 2: Add history API wrappers**

`frontend/web/src/api/history.ts`:

```ts
import { deleteJson, getJson, postJson } from "./http";

export type HistoryItem = {
  id: string;
  title?: string;
  created_at?: string;
  workspace?: { name?: string; path?: string };
};

export function listHistory() {
  return getJson<{ history: HistoryItem[] }>("/api/history");
}

export function deleteHistory(id: string) {
  return deleteJson<{ ok: true }>("/api/history", { id });
}

export function updateHistoryTitle(id: string, title: string) {
  return postJson<{ ok: true }>("/api/history/title", { id, title });
}
```

- [ ] **Step 3: Extend state**

Add history state to `AppState`:

```ts
history: HistoryItem[];
historyLoading: boolean;
```

Add actions:

```ts
| { type: "set_history"; history: HistoryItem[] }
| { type: "set_workspaces"; workspaces: Workspace[] }
```

- [ ] **Step 4: Render live workspace and history**

Update `Sidebar.tsx` so:

- Current workspace name displays from state.
- History list renders `state.history`.
- Empty state remains `대화 내역이 없습니다.`.
- Model footer displays provider and model from state.

- [ ] **Step 5: Verify**

Run:

```powershell
cd frontend\web
npm run typecheck
npm run test:react
npm run build
```

Manual browser scenarios:

- Load `/react`.
- Confirm workspace name appears.
- Confirm existing history entries appear.
- Click restart/new chat only after handlers are ported.
- Confirm no console errors.

- [ ] **Step 6: Commit**

```powershell
git add frontend/web/src/api/workspaces.ts frontend/web/src/api/history.ts frontend/web/src/components/Sidebar.tsx frontend/web/src/state
git commit -m "feat(web): port sidebar data"
```

---

## Task 10: Port Modals, Settings, And Inline Questions

**Files:**
- Create: `frontend/web/src/components/ModalHost.tsx`
- Create: `frontend/web/src/api/settings.ts`
- Modify: `frontend/web/src/components/AppShell.tsx`
- Modify: `frontend/web/src/state/reducer.ts`
- Port reference from: `frontend/web/modules/modals.js`

- [ ] **Step 1: Add settings API wrappers**

`frontend/web/src/api/settings.ts`:

```ts
import { getJson, postJson } from "./http";

export function readYoloModeSettings() {
  return getJson<{ enabled: boolean }>("/api/settings/yolo-mode");
}

export function changeYoloMode(enabled: boolean) {
  return postJson<{ enabled: boolean }>("/api/settings/yolo-mode", { enabled });
}

export function readShellSettings() {
  return getJson<{ shell: string }>("/api/settings/shell");
}

export function changeShellPreference(shell: string) {
  return postJson<{ shell: string }>("/api/settings/shell", { shell });
}

export function saveSystemPrompt(systemPrompt: string) {
  return postJson<{ ok: true }>("/api/settings/pgpt", { systemPrompt });
}
```

- [ ] **Step 2: Add modal state**

Add to `AppState`:

```ts
modal: { kind: string; payload?: Record<string, unknown> } | null;
```

Handle backend event:

```ts
if (event.type === "modal_request") {
  return {
    ...state,
    modal: { kind: String(event.modal?.kind || "backend"), payload: event.modal || {} },
  };
}
```

- [ ] **Step 3: Create `ModalHost.tsx`**

```tsx
import { useAppState } from "../state/app-state";

export function ModalHost() {
  const { state, dispatch } = useAppState();

  if (!state.modal) {
    return null;
  }

  return (
    <div className="modal-host" role="presentation">
      <div className="modal-card" role="dialog" aria-modal="true">
        <h2>확인 필요</h2>
        <p>{String(state.modal.payload?.message || "계속 진행할까요?")}</p>
        <div className="modal-actions">
          <button type="button" onClick={() => dispatch({ type: "backend_event", event: { type: "status", message: "취소됨" } })}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Port modal kinds one by one**

Move behavior from `frontend/web/modules/modals.js` in this order:

1. Backend permission/question modal.
2. Model settings modal.
3. General settings modal.
4. Workspace modal.
5. Runtime picker.

Each modal kind must have a small React component and a focused test when the behavior is conditional.

- [ ] **Step 5: Wire into shell**

In `AppShell.tsx`:

```tsx
import { ModalHost } from "./ModalHost";

export function AppShell() {
  return (
    <div className="app-shell" data-react-webui="true">
      <Sidebar />
      <ChatPanel />
      <ModalHost />
      <TooltipLayer />
    </div>
  );
}
```

- [ ] **Step 6: Verify**

Manual browser scenarios:

- Trigger a permission prompt.
- Trigger an inline question.
- Open settings.
- Change shell preference.
- Toggle yolo mode.
- Confirm no native `title` tooltip appears.
- Confirm no console errors.

- [ ] **Step 7: Commit**

```powershell
git add frontend/web/src/api/settings.ts frontend/web/src/components/ModalHost.tsx frontend/web/src/components/AppShell.tsx frontend/web/src/state
git commit -m "feat(web): port modals and settings"
```

---

## Task 11: Port Artifact Panel And Project Files

**Files:**
- Create: `frontend/web/src/components/ArtifactPanel.tsx`
- Create: `frontend/web/src/api/artifacts.ts`
- Modify: `frontend/web/src/components/AppShell.tsx`
- Modify: `frontend/web/src/state/reducer.ts`
- Port reference from: `frontend/web/modules/artifacts.js`
- Port reference from: `frontend/web/modules/projectFiles.js`

- [ ] **Step 1: Add artifact API wrappers**

`frontend/web/src/api/artifacts.ts`:

```ts
import { deleteJson, getJson, postJson } from "./http";

export type ArtifactSummary = {
  path: string;
  name: string;
  kind: string;
  label?: string;
  size?: number;
};

export function listArtifacts() {
  return getJson<{ artifacts: ArtifactSummary[] }>("/api/artifacts");
}

export function readArtifact(path: string) {
  const query = new URLSearchParams({ path });
  return getJson<Record<string, unknown>>(`/api/artifact?${query.toString()}`);
}

export function deleteArtifact(path: string) {
  return deleteJson<{ ok: true }>("/api/artifact", { path });
}

export function saveArtifact(path: string, content: string) {
  return postJson<{ ok: true }>("/api/artifact/save", { path, content });
}
```

- [ ] **Step 2: Add artifact state**

Add to `AppState`:

```ts
artifacts: ArtifactSummary[];
activeArtifact: ArtifactSummary | null;
artifactPanelOpen: boolean;
```

Add actions:

```ts
| { type: "set_artifacts"; artifacts: ArtifactSummary[] }
| { type: "open_artifact"; artifact: ArtifactSummary }
| { type: "close_artifact" }
```

- [ ] **Step 3: Create `ArtifactPanel.tsx`**

```tsx
import { useAppState } from "../state/app-state";

export function ArtifactPanel() {
  const { state, dispatch } = useAppState();

  if (!state.artifactPanelOpen || !state.activeArtifact) {
    return null;
  }

  return (
    <aside className="artifact-panel" aria-label="산출물 미리보기">
      <div className="artifact-panel-header">
        <div className="artifact-panel-title">
          <strong>{state.activeArtifact.name}</strong>
          <small>{state.activeArtifact.path}</small>
        </div>
        <div className="artifact-panel-actions">
          <button type="button" className="artifact-action" aria-label="닫기" onClick={() => dispatch({ type: "close_artifact" })}>
            닫기
          </button>
        </div>
      </div>
      <div className="artifact-viewer">
        <p>산출물을 불러오는 중...</p>
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Port viewers by file kind**

Move artifact behavior in this order:

1. Text/Markdown/JSON viewer.
2. HTML iframe preview.
3. Image preview.
4. PDF embed.
5. Save copy/download/delete.
6. Panel resize and history back behavior.

Do not port all panel features in one commit.

- [ ] **Step 5: Wire into shell**

In `AppShell.tsx`:

```tsx
import { ArtifactPanel } from "./ArtifactPanel";

export function AppShell() {
  return (
    <div className="app-shell" data-react-webui="true">
      <Sidebar />
      <ChatPanel />
      <ArtifactPanel />
      <ModalHost />
      <TooltipLayer />
    </div>
  );
}
```

- [ ] **Step 6: Verify**

Manual browser scenarios:

- Ask agent to create a small `.html` artifact.
- Click the file card.
- Confirm right panel opens.
- Confirm HTML preview renders.
- Confirm text/Markdown preview renders.
- Confirm image preview renders if an image exists.
- Confirm panel close works.
- Confirm no console errors.

- [ ] **Step 7: Commit**

```powershell
git add frontend/web/src/api/artifacts.ts frontend/web/src/components/ArtifactPanel.tsx frontend/web/src/components/AppShell.tsx frontend/web/src/state
git commit -m "feat(web): port artifact panel"
```

---

## Task 12: Cut Over Root Route From Legacy UI To React UI

**Files:**
- Modify: `frontend/web/index.html`
- Modify: `frontend/web/vite.config.ts`
- Modify: `frontend/web/server.mjs`

- [ ] **Step 1: Change Vite input from `react.html` to `index.html`**

Update `vite.config.ts`:

```ts
rollupOptions: {
  input: {
    index: resolve(__dirname, "index.html"),
  },
},
```

- [ ] **Step 2: Replace `frontend/web/index.html` with React entry**

```html
<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyHarness</title>
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23181715'/%3E%3Cpath d='M9 17.5 14.2 22 23 10' fill='none' stroke='%23f7f3ea' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"
    />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Preserve legacy file for emergency fallback**

Before replacing, copy the old `index.html` to:

```text
frontend/web/legacy-index.html
```

Use PowerShell:

```powershell
Copy-Item frontend\web\index.html frontend\web\legacy-index.html
```

- [ ] **Step 4: Update server root route**

In `resolvePath`, root should prefer built React dist:

```js
: pathname === "/"
  ? (existsSync(join(webDistRoot, "index.html")) ? join(webDistRoot, "index.html") : join(root, "index.html"))
```

Keep `/legacy-index.html` available only if explicitly requested.

- [ ] **Step 5: Build and verify root route**

Run:

```powershell
cd frontend\web
npm run build
npm start
```

Open:

```text
http://localhost:4173/
```

Expected:

- React UI opens at root.
- `/react` is no longer needed.
- Core chat flow works.
- Existing API endpoints still work.
- Console has no errors.

- [ ] **Step 6: Commit**

```powershell
git add frontend/web/index.html frontend/web/legacy-index.html frontend/web/vite.config.ts frontend/web/server.mjs
git commit -m "feat(web): switch root route to react ui"
```

---

## Task 13: Remove Legacy UI Code After Parity

**Files:**
- Delete: `frontend/web/script.js`
- Delete: `frontend/web/modules/*.js`
- Delete or migrate: `frontend/web/tests/*.test.mjs`
- Delete: `frontend/web/react.html`
- Modify: `frontend/web/vite.config.ts`
- Modify: `pyproject.toml`
- Modify: `README.md`
- Modify: `Installer.bat`

- [ ] **Step 1: Confirm parity checklist before deletion**

All must pass at root `/`:

- New chat.
- Send message.
- Assistant streaming.
- Tool start/progress/completion rendering.
- Permission prompt.
- Inline question.
- Settings modal.
- Model/runtime settings.
- Workspace list/create/delete/switch.
- History list/restore/delete/title edit.
- Slash command menu.
- Skill/MCP/plugin picker.
- `@` file reference picker.
- Attachment image send.
- Pasted text chip.
- Artifact detection.
- Artifact preview for HTML, Markdown/text, image, PDF.
- Shell stream.
- Cancel current run.
- Shutdown/restart backend session.
- Theme toggle.
- Sidebar collapse.
- Mobile viewport.

- [ ] **Step 2: Delete preview entry**

Remove `frontend/web/react.html`.

- [ ] **Step 3: Delete or archive legacy code**

Delete only after tests and browser checks pass:

```text
frontend/web/script.js
frontend/web/modules/
```

If a legacy helper is still needed, move the logic into a typed React file before deletion.

- [ ] **Step 4: Update `pyproject.toml` force include**

Replace legacy includes:

```toml
"frontend/web/index.html" = "myharness/_web/index.html"
"frontend/web/package.json" = "myharness/_web/package.json"
"frontend/web/package-lock.json" = "myharness/_web/package-lock.json"
"frontend/web/server.mjs" = "myharness/_web/server.mjs"
"frontend/web/styles.css" = "myharness/_web/styles.css"
"frontend/web/dist" = "myharness/_web/dist"
```

Remove:

```toml
"frontend/web/script.js" = "myharness/_web/script.js"
"frontend/web/modules" = "myharness/_web/modules"
```

- [ ] **Step 5: Update installer verification**

In `Installer.bat`, replace:

```bat
node --check "frontend\web\script.js"
```

with:

```bat
pushd "frontend\web"
call npm run build
if errorlevel 1 (
  popd
  echo.
  echo [ERROR] frontend\web React build failed.
  pause
  exit /b 1
)
popd
```

Keep:

```bat
node --check "frontend\web\server.mjs"
```

- [ ] **Step 6: Update README verification commands**

Replace:

```bat
node --check frontend/web/server.mjs
node --check frontend/web/script.js
node --check frontend/web/modules/commands.js
py -3 -m compileall src
```

with:

```bat
node --check frontend/web/server.mjs
cd frontend/web && npm run typecheck && npm run build && npm test
py -3 -m compileall src
```

- [ ] **Step 7: Verify full suite**

Run:

```powershell
node --check frontend\web\server.mjs
cd frontend\web
npm run typecheck
npm test
npm run build
cd ..\..
py -3 -m compileall src
pytest tests\test_ui tests\test_services tests\test_tools -q
```

Expected:

- Node syntax check passes.
- React typecheck passes.
- React and remaining Web tests pass.
- Vite build passes.
- Python compile passes.
- Targeted pytest suite passes.

- [ ] **Step 8: Final browser QA**

Use the Codex app browser first. Only use Playwright/browser automation fallback if Codex app browser inspection is unavailable.

Check:

- Desktop viewport around 1440x900.
- Narrow/mobile viewport around 390x844.
- No text overlap.
- No clipped button text.
- No broken modals.
- No console errors.
- Chat streaming remains smooth.
- Artifact panel does not cover composer incorrectly.

Store any screenshots or logs under:

```text
.myharness/ui-checks/
```

- [ ] **Step 9: Commit**

```powershell
git add frontend/web pyproject.toml Installer.bat README.md
git add -u frontend/web
git commit -m "chore(web): remove legacy web ui"
```

---

## Risk Register

- **Vite asset path conflict:** Vite default `/assets/*` conflicts with repository `assets/`. Mitigation: use `build.assetsDir = "web-assets"`.
- **Backend session duplication:** React StrictMode can double-run effects in dev. Mitigation: guard session startup with `sessionId`, cancellation, and a ref if needed.
- **SSE stale events:** Old session events can mutate active UI. Mitigation: include `sessionId` and `clientId` in EventSource params and ignore stale events once chat slots are ported.
- **Feature parity gap:** Legacy modules contain many small behaviors. Mitigation: side-by-side `/react` route and parity checklist before root cutover.
- **Packaging regression:** Existing `pyproject.toml` force-includes legacy web files. Mitigation: update packaging only after React root cutover.
- **Installer regression:** Installer currently checks `script.js`. Mitigation: switch to `npm run build` only after build is stable.

## Implementation Order Recommendation

1. Tooling and preview route.
2. Typed API/event contracts.
3. Reducer/store.
4. Session/SSE.
5. Composer/message rendering.
6. Sidebar/history/workspace.
7. Modals/settings.
8. Artifacts/project files.
9. Root cutover.
10. Legacy cleanup.

## Self-Review

- Spec coverage: The plan targets React + Vite + TypeScript conversion of `frontend/web` only, preserves existing server/API behavior, and includes a side-by-side preview path before root cutover.
- Placeholder scan: No `TBD` or deferred unknown task remains. The only intentionally staged areas are listed with exact order and verification criteria.
- Type consistency: `BackendEvent`, `AppState`, reducer actions, and API wrapper names are introduced before later tasks reference them.
