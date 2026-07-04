# AGENTS.md — translate cat

Chrome MV3 extension (TypeScript + Bun, no framework) that overlays AI-translated YouTube subtitles. Built by `scripts/build.ts` → `dist/`; load unpacked from there.

## Invariants

- `src/youtube/main-world-capture.ts` runs in the page's MAIN world: no `chrome.*` APIs, no imports with chrome types at runtime; talk to the extension only via `postMessage`/`CustomEvent` (constants in `caption-capture-event.ts`).
- Settings are read/written only through `GET_SETTINGS`/`SET_SETTINGS` runtime messages to the background worker (it merges `DEFAULT_SETTINGS`). Never call `chrome.storage` for settings from content/YouTube code; the one exception is read-only change observation via `watchSettings` in `src/shared/messages.ts` — never add ad-hoc `chrome.storage.onChanged` listeners.
- API keys live in `chrome.storage.local` (`providerSecrets`); configs and settings in `chrome.storage.sync`. Never log secrets or move them to sync.
- Never persist `enabled: false` from inferred player state (CC button off, timeouts). Only an explicit user action (toggle button, popup) may change the stored setting; transient failures deactivate locally and self-heal on the next video load.
- Provider fetch/parse failures must throw the typed errors in `src/background/providers/errors.ts`; `subtitle-translation.ts` classifies them (401/403 fatal, 408/429/5xx/network/parse retryable). A plain `Error` means non-retryable — don't "upgrade" it.
- Translation cache: reads are pure; all writes go through the module write queue in `cache.ts`; only complete windows (no missing ids) may be cached.

## Architecture contract

- `src/content/index.ts` — activation lifecycle and CC-state orchestration only (arm/teardown, render loop, navigation poll).
- `src/youtube/session.ts` — per-video translation state (segments, windows, cues); no DOM.
- `src/youtube/scheduler.ts` — pure window planning; keep it side-effect free.
- `src/youtube/translate-toggle.ts` — player toggle button UI only.
- `src/background/providers/` — one adapter per provider; shared OpenAI-compatible logic lives in `openai.ts` (opencode Zen subclasses it).
- `src/shared/messages.ts` — the only source of message/response contracts between contexts.
- `tests/` mirrors `src/`; test pure logic (parsing, scheduling, session, providers via stubbed `fetch`) — no browser/DOM harness exists.

Target ~600 LOC per file; when a file exceeds this, split by ownership.

## Quality gates (run before handoff)

```bash
bun run check   # typecheck + lint + fmt:check + test + build
```

## Commit format

`<type>: <imperative summary>` — types: feat, fix, refactor, perf, docs, chore.
Body explains the user-visible symptom for fixes. Avoid `update`, `cleanup`, `wip`.
