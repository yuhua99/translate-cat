# Changelog

All notable changes to this project will be documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] - 2026-09-03

### Added

- Streamed selected-text translations as they arrive, with immediate cancellation when the bubble closes or the selection changes.
- Added the Gemini 3.8 Flash model to the provider list.

### Changed

- Changed the default provider to ChatGPT.
- Replaced the selection bubble's dotted drag handle with a title bar carrying the pixel cat logo.
- Disabled model thinking by default on supported models, making translations faster and cheaper.
- Trimmed the opencode Zen model list to the supported models.
- Delegated word-or-phrase detection for selected text to the model, so phrases in languages without spaces are translated instead of explained.

### Fixed

- Cleared stale save status messages when settings change, so they no longer block the save button.
- Sized popup buttons and inputs to their content, keeping localized labels aligned.
- Aligned the selection bubble with the retro LCD styling and clamped it to the viewport when dragging.
- Removed the extra padding at the end of popup dropdown rows.
- Kept text selection readable on inverted status messages.
- Cancelled in-flight translations more reliably when switching providers.

## [0.3.1] - 2026-08-28

### Added

- Localized the UI in eight languages.

### Changed

- Displayed the original subtitles while translations are pending.
- Refined popup and ChatGPT sign-in page styles.
- Matched the tooltip styling to YouTube's native controls.

### Fixed

- Retried AI subtitle activation until captions are ready.
- Kept the AI Translate toggle in sync with the active session.
- Prevented stale AI activation and translation results.
- Built content scripts as IIFEs for Chrome compatibility.

### Docs

- Clarified provider types in the README.

## [0.3.0] - 2026-08-27

### Added

- ChatGPT subscription as a translation provider: sign in with a device code instead of an API key.
- Localized Chrome Web Store name and description.

### Changed

- Redesigned the popup and ChatGPT sign-in page as a retro LCD device, with a unified pixel cat icon.

### Fixed

- Disabled the YouTube AI translation toggle when the selected provider has no credentials.

### Docs

- Documented ChatGPT sign-in tokens and related OpenAI host access in the privacy policy.

## [0.2.5] - 2026-08-20

### Docs

- Added the project's GitHub homepage to the extension listing.
- Clarified privacy disclosures for Chrome Web Store review, including third-party AI providers and the context-menu permission.

## [0.2.4] - 2026-08-19

### Added

- A **Translate with translate cat** right-click menu for selected text, including when the selection icon is disabled.

### Changed

- Selected-text translation now uses dedicated prompts: single words receive learner dictionary-style explanations, while phrases are translated without extra explanations.
- Internal dead-code cleanup with no user-facing behavior change.

### Docs

- Documented the Google Gemini provider in the README and privacy policy.

## [0.2.3] - 2026-08-11

### Added

- Support for the 5.6 Luna model.

## [0.2.2] - 2026-07-07

### Changed

- Adjusted the translation icon position and updated the available model list.

### Docs

- Updated the README.

## [0.2.1] - 2026-07-05

### Added

- Google Gemini as a translation provider.

### Docs

- Added a privacy policy.

## [0.2.0] - 2026-07-04

### Added

- Translation for selected text, with a popup setting to enable it.
- A way to cancel in-progress translation requests.
- Refined popup controls, including themed dropdowns, an icon header, and a save button that appears when settings change.

### Changed

- Renamed the extension to Translate Cat.
- Preserved translations when YouTube recaptures identical captions.

### Fixed

- Restored saved API keys when testing a provider.
- Kept the translation toggle in sync with saved settings and prevented transient caption-control states from disabling it.
- More reliably restored AI subtitles after YouTube navigation and when captions become available.
- Improved caption capture, translation retrying, translation-cache reliability, and subtitle sizing.

### Docs

- Updated the README.

## [0.1.4] - 2026-05-07

### Changed

- Moved the translation toggle into YouTube's player options.

### Fixed

- Prevented a scheduling race that could interrupt subtitle translation.

## [0.1.3] - 2026-05-05

### Added

- Extension options in the popup.

## [0.1.2] - 2026-05-05

### Fixed

- Fixed release packaging.

## [0.1.1] - 2026-05-05

### Fixed

- Improved handling of missing or invalid translated text.

## [0.1.0] - 2026-05-05

### Added

- AI-translated subtitle overlays for YouTube captions, including automatically generated subtitles.
- Context-aware translation and a progress indicator while subtitles are translated.
- Provider setup and testing in the popup, including support for the OpenCode Go provider.
- Popup controls for YouTube captions, including automatic caption activation when translation is enabled.

### Docs

- Added and updated the project README.
