# translate cat SPEC

## Goal

Chrome extension for YouTube subtitle translation. Only AI API translation. Unified provider interface, provider-specific adapters.

Supported providers:

- OpenAI
- Anthropic Claude
- opencode Zen

## Platform / Stack

- Chrome Extension Manifest V3
- TypeScript + Vite
- Options UI: vanilla HTML/CSS/TS
- No React/Svelte/Vue

## Permissions

Minimal permissions:

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

No `activeTab`, no `alarms`, no `unlimitedStorage`.

Content scripts:

- MAIN world, `document_start`: intercept YouTube caption requests
- Isolated world: popup-controlled session lifecycle, overlay renderer, status overlay

## Core UX

User flow:

1. User opens extension popup.
2. User enables YouTube AI subtitles checkbox.
3. Extension validates provider/API key/model/target language settings.
4. If missing config: open options page and show short status overlay.
5. If valid: start translation for current subtitle track.
6. Hide native YouTube captions completely.
7. Render AI-translated subtitles via custom overlay.

Target language selected only in extension options. YouTube menu does not show language list.

AI mode persists across YouTube SPA navigation while popup enable setting remains on, unless user turns captions off.

When new video starts and AI mode remains active, translation begins automatically when captions become available. Translation start status overlay is enough; no extra “active for new video” notice.

## Turning AI Mode Off

AI mode stops when user:

- selects normal YouTube subtitle track
- turns captions off

Then extension:

- stops current session
- aborts in-flight translation jobs
- removes AI overlay
- removes native-caption hide CSS

## YouTube Subtitle Source

Primary source: intercept YouTube player’s own `/api/timedtext` request.

Reason:主动 fetch `/api/timedtext` may return HTTP 200 with empty body due to YouTube POT/experiment flags. More reliable: MAIN world patches `XMLHttpRequest` and `fetch`, captures player-owned response.

MAIN world script:

- patch `XMLHttpRequest.prototype.open/send`
- patch `window.fetch`
- match `/api/timedtext`
- read `responseText` / `response.clone().text()`
- dispatch `CustomEvent('simple-translator-yt-captions', { detail: { url, responseText } })`

Isolated content script:

- listens to event
- parses `url` params to detect track/lang/kind
- parses caption response
- starts/updates session

Supported caption formats:

- `json3` primary
- `vtt` fallback

## Subtitle Types

Two input types:

### Manual subtitles

Author/uploaded/official subtitles.

Properties:

- cue boundaries usually sentence-like
- stable timing
- often has punctuation

Manual path:

- parse cue
- preserve start/end time
- translate text only

### ASR subtitles

ASR = Automatic Speech Recognition. YouTube labels often show:

- `English (auto-generated)`
- `日文（自動產生）`
- `英文（自動產生）`

Properties:

- machine-generated
- word/phrase fragments
- rolling captions
- weak punctuation

ASR path:

- detect via `kind=asr` or track name contains auto-generated/自動產生
- locally merge segments into sentence-like cues
- AI only translates text
- AI must not change timestamps

ASR merge heuristic:

- break when gap > 700ms
- break when accumulated chars > 120
- break on `.?!。！？`
- break when duration > 6s
- each merged cue keeps `sourceIds`

## Data Model

```ts
export type CaptionKind = 'manual' | 'asr'

export interface RawCaptionSegment {
  id: string
  index: number
  startMs: number
  endMs: number
  text: string
  source?: 'json3' | 'vtt'
}

export interface CaptionCue {
  id: string
  startMs: number
  endMs: number
  text: string
  sourceIds: string[]
}

export interface TranslatedCue {
  id: string
  startMs: number
  endMs: number
  text: string
}

export interface CaptionTrackIdentity {
  videoId: string
  langCode?: string
  name?: string
  kind: CaptionKind
  vssId?: string
  urlHash?: string
}
```

Stable ids include videoId, track identity, and segment/cue index. Do not use normalized text as primary key.

## Translation Scheduler

Use window-based lookahead, not whole-video translation.

Defaults:

- window length: 30s
- lookahead: 2 windows
- max parallel jobs: 2

Window rules:

- window only cuts by cue membership
- never split cue text
- cue belongs to window if `cue.startMs` falls in window
- overlap/context cues may be sent as context only, but response must include only requested ids

Playback sync:

- read `HTMLVideoElement.currentTime`
- renderer updates using `requestAnimationFrame` while playing
- render once on pause
- seek event prioritizes current window

Session behavior:

- each video has `YoutubeSubtitleSession`
- SPA navigation resets per-video state
- in-flight jobs aborted on video change or AI mode off
- cache survives

## Cache

Use `chrome.storage.local`.

Cache policy:

- TTL: 3 days
- auto-rotate when exceeding size
- no `unlimitedStorage`
- rotate oldest entries first

Cache granularity: per translation window.

Cache key parts:

```txt
videoId
sourceTrack(langCode + kind + vssId/urlHash)
targetLang
providerType
model
promptVersion
windowStartMs
sourceTextHash
```

Value:

```ts
interface TranslationWindowCacheEntry {
  key: string
  createdAt: number
  lastAccessedAt: number
  expiresAt: number
  sizeBytes: number
  cues: TranslatedCue[]
}
```

Cleanup happens on cache read/write:

1. remove expired
2. if still over budget, remove least recently accessed entries

## Rendering

Use custom overlay for all subtitle types.

Native YouTube captions:

- hidden completely while AI mode active
- not restored on fatal translation/provider errors
- restored only when user exits AI mode

Overlay behavior:

- positioned inside YouTube player
- `pointer-events: none`
- displays current translated cue where `startMs <= currentTimeMs < endMs`
- empty if current window not translated yet or failed

Style:

- mimic YouTube native subtitles
- read `.ytp-caption-segment` computed style when available
- fallback style:
  - font size: `clamp(18px, 3.5vw, 34px)`
  - white text
  - black background `rgba(8, 8, 8, .75)`
  - bottom around 8–12%

## Status / Error Overlay

Separate browser-page overlay at bottom-right.

Used for:

- translating status
- missing settings
- provider test result
- errors

Behavior:

- closable
- auto-dismiss after 3 seconds
- if user misses error, acceptable
- does not interrupt translation

## Options Page

Settings:

```ts
export type ProviderType = 'openai' | 'anthropic' | 'opencodeZen'

export interface ExtensionSettings {
  activeProvider: ProviderType
  targetLang: TargetLangCode
  customInstruction?: string
  models: Record<ProviderType, string>
  apiKeys: Partial<Record<ProviderType, string>>
}
```

One API key per provider.

Target languages fixed:

```ts
;[
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
]
```

Model selection:

- built-in model list per provider
- user may manually enter custom model id
- no dynamic `/models` fetch

Test button:

- tests active provider only
- runs in background service worker
- sends minimal request: `Reply exactly: OK`
- success only if trimmed response equals `OK`

## Providers

No user-editable base URL. Each provider has fixed endpoint.

```ts
openai      -> https://api.openai.com/v1/chat/completions
anthropic   -> https://api.anthropic.com/v1/messages
opencodeZen -> https://opencode.ai/zen/go/v1/chat/completions
```

`opencodeZen` uses OpenAI-compatible chat completions protocol internally, but remains separate provider type externally.

Unified interface:

```ts
export interface JsonCompletionRequest {
  model: string
  system: string
  user: string
  temperature?: number
  schemaName: string
  schema: unknown
}

export interface ProviderJsonResult<T> {
  data: T
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
  raw?: unknown
}

export interface AiProvider {
  type: ProviderType
  completeJson<T>(request: JsonCompletionRequest): Promise<ProviderJsonResult<T>>
  testConnection(model: string): Promise<void>
}
```

Provider adapters live only in background. Content scripts never receive API keys.

## Translation Protocol

All subtitle translation uses strict JSON response.

Input payload to provider prompt includes:

```json
{
  "targetLanguage": "zh-TW",
  "items": [
    { "id": "cue-1", "text": "Hello" },
    { "id": "cue-2", "text": "world" }
  ],
  "contextBefore": [{ "id": "ctx-1", "text": "..." }],
  "contextAfter": [{ "id": "ctx-2", "text": "..." }]
}
```

Required response:

```json
{
  "translations": [
    { "id": "cue-1", "text": "你好" },
    { "id": "cue-2", "text": "世界" }
  ]
}
```

Validation:

- response must be valid JSON
- `translations` must be array
- ids must exactly match requested ids
- no missing ids
- no extra ids
- text must be string
- timestamps are never accepted from AI for normal translation path

Prompt rules:

- translate to target language
- natural subtitle style
- no explanation
- preserve meaning
- preserve proper nouns when appropriate
- output JSON only
- do not merge/split/reorder items
- do not translate context-only items
- apply optional `customInstruction` after core schema rules

Provider structured output:

- use JSON schema / structured output when provider supports it
- otherwise prompt-only JSON
- if structured output fails, retry prompt-only JSON

## Error / Retry Strategy

Window translation retry:

- retry up to 2 times
- exponential backoff
- JSON parse/validation fail triggers repair/retry

Fatal errors:

- 401/403 invalid auth stops session jobs
- show bottom-right overlay for 3s
- do not restore native captions

Non-fatal errors:

- 429/5xx/network/window JSON fail marks window failed after retries
- current subtitle may be blank for failed window
- show bottom-right overlay for 3s

No infinite retry.

## Popup Control

Popup contains:

- `Enable YouTube AI subtitles` checkbox
- `Settings` button opening options page

Implementation:

- checkbox persists `settings.enabled`
- YouTube content script listens to `chrome.storage.onChanged`
- enabled starts AI mode using current source subtitle track and options target language
- disabled stops AI mode and restores native captions

## SPA Lifecycle

YouTube is SPA. Must handle:

- URL/videoId changes
- `yt-navigate-finish`
- video element replacement
- caption request arrival for new video
- CC off / source track change

On video change:

- abort in-flight jobs for old video
- remove old translated cues from active memory
- clear renderer state
- keep AI mode flag if user has not turned it off
- keep cache
- wait for new caption request
- auto-start translation for new video if AI mode active

## Suggested File Structure

```txt
src/
  manifest.ts or public/manifest.json
  background/
    index.ts
    providers/
      types.ts
      registry.ts
      openai.ts
      anthropic.ts
      opencode-zen.ts
      openai-chat-transport.ts
    subtitle-translation.ts
    settings.ts
    cache.ts
  content/
    main-world-capture.ts
    youtube/
      index.ts
      session.ts
      caption-types.ts
      caption-parser-json3.ts
      caption-parser-vtt.ts
      asr-merge.ts
      scheduler.ts
      renderer.ts
      player-state.ts
      status-overlay.ts
      background-client.ts
  options/
    index.html
    options.ts
    options.css
  shared/
    languages.ts
    providers.ts
    messages.ts
    hash.ts
```

## Non-goals

- No webpage translation outside YouTube
- No Drive/Docs support
- No custom provider/base URL
- No native messaging / local CLI provider
- No streaming translation
- No bilingual mode
- No download SRT/VTT for now
- No dynamic model fetching
