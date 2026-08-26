# Privacy Policy — translate cat

_Last updated: 2026-08-27_

translate cat ("the extension") is a browser extension that translates YouTube
subtitles and selected text using third-party AI providers. This policy
explains what data the extension handles and how.

## What the extension processes

- **Text to be translated.** When you enable YouTube subtitle translation, the
  captions of the current video are sent to the third-party AI provider you
  selected. When you use selection translation, the text you select and trigger
  is sent to that provider. This text is transmitted solely to produce a
  translation and is not stored by the extension after the translation is
  displayed.
- **Context menus.** The `contextMenus` permission lets the extension add a
  right-click menu item for translating selected text. It is used only to
  trigger selection translation.
- **Your settings.** Provider choice, model, and target language are stored in
  your browser via `chrome.storage.sync` so they follow your Chrome profile.
- **Your API keys.** API keys are stored locally in `chrome.storage.local` on
  your device only. They are never synced and never sent anywhere except, as an
  authorization header, to the corresponding provider's official API endpoint.
- **ChatGPT sign-in tokens.** If you choose the ChatGPT subscription provider,
  the extension uses OpenAI's device-code sign-in. Access and refresh tokens
  are stored locally in `chrome.storage.local` on your device only. They are
  never synced. They are sent only to OpenAI: `auth.openai.com` to sign in and
  refresh tokens, and `chatgpt.com` to request translations. The extension
  does not read your ChatGPT cookies or browsing session. Signing out deletes
  the stored tokens.

## What we do NOT do

- We do **not** collect, transmit, or store any of your data on servers we
  control. The extension has no backend.
- We do **not** use analytics, tracking, or advertising.
- We do **not** sell or share your data with anyone.

## Third-party providers

Translation requests are sent directly from your browser to the provider you
choose. Your use of these services is governed by their own privacy policies:

- OpenAI / ChatGPT — https://openai.com/policies/privacy-policy
- Anthropic — https://www.anthropic.com/legal/privacy
- Google Gemini — https://generativelanguage.googleapis.com
- opencode Zen — https://opencode.ai

## Data retention

The extension keeps translation results only in an in-browser cache to avoid
re-translating the same content, and settings, API keys, and ChatGPT tokens in
browser storage as described above. Removing the extension deletes this local
data.

## Contact

For questions about this policy, open an issue at
https://github.com/yuhua99/translate-cat/issues
