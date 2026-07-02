<p align="center">
  <img src="icon.png" alt="translate cat" width="128" />
</p>

# translate cat

Chrome MV3 extension — AI-powered real-time YouTube subtitle translation.

Translates YouTube captions (manual + auto-generated ASR) into your target language using OpenAI, Anthropic Claude, or [opencode Zen Go](https://opencode.ai).

## Quick Start

```bash
bun install
bun run check
```

1. `chrome://extensions` → Developer mode → Load unpacked → `dist/`
2. Open extension Options → configure provider, model, API key, target language
3. YouTube video with captions → click extension → enable toggle

## Scripts

| Command             | Description                              |
| ------------------- | ---------------------------------------- |
| `bun run build`     | Build → `dist/`                          |
| `bun run dev`       | Watch rebuild                            |
| `bun run typecheck` | TypeScript check                         |
| `bun run lint`      | oxlint                                   |
| `bun test`          | Unit tests                               |
| `bun run check`     | Full CI: typecheck + lint + test + build |

## Providers

| Provider      | Endpoint                                         |
| ------------- | ------------------------------------------------ |
| `openai`      | `https://api.openai.com/v1/chat/completions`     |
| `anthropic`   | `https://api.anthropic.com/v1/messages`          |
| `opencodeZen` | `https://opencode.ai/zen/go/v1/chat/completions` |

Model presets available per provider in Options; custom model IDs supported.

## How It Works

- **MAIN-world capture** — intercepts YouTube `/api/timedtext` requests (XHR + fetch)
- **Parsing** — json3, vtt, TTML, SRV subtitle formats
- **ASR merge** — local fusion of auto-caption fragments before translation
- **Window scheduler** — 30s sliding window, 2-window lookahead
- **Background pipeline** — provider-specific chat completions adapter
- **Cache** — `chrome.storage.local`, 3-day TTL, auto-rotate on budget
- **Overlay** — custom DOM renderer syncs to `requestAnimationFrame`
- **Error handling** — 401/403 fatal, 429/5xx retry 2× with backoff

## Architecture

```
src/
├── background/           # Service worker + provider adapters
├── content/              # Isolated content script
├── popup/                # Extension popup
├── options/              # Options page
├── shared/               # Types & messages
└── youtube/              # Capture, parsing, session, scheduler, renderer
```

## Settings

- Provider configs → `chrome.storage.sync`
- API keys → `chrome.storage.local` (never synced, never exposed to content scripts)
- Target languages: zh-TW, zh-CN, en, ja, ko, es, fr, de

## Permissions

```json
{
  "permissions": ["storage"],
  "host_permissions": [
    "https://www.youtube.com/*",
    "https://api.openai.com/*",
    "https://api.anthropic.com/*",
    "https://opencode.ai/*"
  ]
}
```

No `activeTab`, `alarms`, `unlimitedStorage`.

## Tech Stack

TypeScript + Bun · MV3 · Vanilla DOM · oxlint · Bun test runner

---
