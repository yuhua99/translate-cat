# AGENTS.md

## Invariants

- API keys live in `chrome.storage.local` (`providerSecrets`). Never store them in sync storage or logs.
- Target about 600 LOC per file. When a file exceeds this, split it by purpose.

## UI style

- Reuse the `--lcd-*` custom properties and `.lcd-*` primitives in `public/lcd.css`. Add shared colors, typography, and spacing there instead of repeating literal values.
- Scope CSS injected into host pages under an extension-owned root, including its custom properties. YouTube's own nodes are the exception; reach them with global selectors.

## Verification

`bun run check` will be automatically executed via commit hook.
