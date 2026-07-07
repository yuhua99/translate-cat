<p align="center">
  <img src="icon.png" alt="translate cat" width="128" />
</p>

# translate cat

Chrome extension for AI translation.

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/translate-cat/aibehclppnalahklmeiccpcgikeibogh)

## Features

- **YouTube subtitles** — translates captions in real time
- **Selection translation** — select text on any page, click the cat icon

Providers: OpenAI, Anthropic, [opencode Zen](https://opencode.ai).

## Install

```bash
bun install
bun run build
```

Load `dist/` via `chrome://extensions` → Developer mode → Load unpacked.

## Setup

Open the popup, set provider, model, API key, and target language.

- YouTube: enable the toggle on a video with captions
- Elsewhere: select text, click the cat icon

API keys stay local, never synced.

## Development

| Command         | Description                     |
| --------------- | ------------------------------- |
| `bun run dev`   | Watch rebuild                   |
| `bun run check` | typecheck + lint + test + build |
