# Privacy Policy — translate cat

_Last updated: 2026-07-04_

translate cat ("the extension") is a browser extension that translates YouTube
subtitles and selected text using third-party AI providers. This policy
explains what data the extension handles and how.

## What the extension processes

- **Text to be translated.** When you enable YouTube subtitle translation, the
  captions of the current video are sent to the AI provider you configured.
  When you use selection translation, the text you select and trigger is sent
  to that provider. This text is transmitted solely to produce a translation
  and is not stored by the extension after the translation is displayed.
- **Your settings.** Provider choice, model, and target language are stored in
  your browser via `chrome.storage.sync` so they follow your Chrome profile.
- **Your API keys.** API keys are stored locally in `chrome.storage.local` on
  your device only. They are never synced and never sent anywhere except, as an
  authorization header, to the corresponding provider's official API endpoint.

## What we do NOT do

- We do **not** collect, transmit, or store any of your data on servers we
  control. The extension has no backend.
- We do **not** use analytics, tracking, or advertising.
- We do **not** sell or share your data with anyone.

## Third-party providers

Translation requests are sent directly from your browser to the provider you
choose. Your use of these services is governed by their own privacy policies:

- OpenAI — https://openai.com/policies/privacy-policy
- Anthropic — https://www.anthropic.com/legal/privacy
- opencode Zen — https://opencode.ai

## Data retention

The extension keeps translation results only in an in-browser cache to avoid
re-translating the same content, and settings/keys in browser storage as
described above. Removing the extension deletes this local data.

## Contact

For questions about this policy, open an issue at
https://github.com/yuhua99/translate-cat/issues
