<p align="center">
  <img src="public/icons/icon.svg" alt="translate cat" width="128" />
</p>

<h1 align="center">translate cat</h1>

<p align="center">
  Chrome extension for AI translation ·
  <a href="https://chromewebstore.google.com/detail/translate-cat/aibehclppnalahklmeiccpcgikeibogh">Install from Chrome Web Store</a>
</p>

## Features

- **YouTube subtitles** — translates captions in real time
- **Selection translation** — select text on any page, click the cat icon

| Provider             | Type         |
| -------------------- | ------------ |
| OpenAI               | apikey       |
| Anthropic            | apikey       |
| Google Gemini        | apikey       |
| [opencode Zen](https://opencode.ai) | apikey       |
| ChatGPT subscription | subscription |

## Install

```bash
bun install
bun run build
```

Load `dist/` via `chrome://extensions` → Developer mode → Load unpacked.

## Setup

Open the popup, set provider, model, API key (or sign in with ChatGPT), and target language.

- YouTube: enable the toggle on a video with captions
- Elsewhere: select text, click the cat icon

API keys and ChatGPT tokens stay local, never synced.

## Development

| Command         | Description                     |
| --------------- | ------------------------------- |
| `bun run dev`   | Watch rebuild                   |
| `bun run check` | typecheck + lint + test + build |
