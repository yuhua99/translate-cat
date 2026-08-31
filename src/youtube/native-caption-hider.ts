const STYLE_ID = 'simple-translator-hide-native-captions'

export function hideNativeCaptions(): void {
  if (document.getElementById(STYLE_ID)) return

  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = `
    .caption-window,
    .ytp-caption-window-rollup {
      visibility: hidden !important;
      opacity: 0 !important;
    }
  `
  document.documentElement.append(style)
}

export function showNativeCaptions(): void {
  document.getElementById(STYLE_ID)?.remove()
}
