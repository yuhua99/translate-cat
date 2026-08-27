export function localizePage(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    const message = chrome.i18n.getMessage(element.dataset.i18n ?? '')
    if (message) element.textContent = message
  })
  const attributes = [
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-aria-label', 'aria-label'],
    ['data-i18n-alt', 'alt'],
    ['data-i18n-title', 'title'],
  ] as const
  for (const [dataAttribute, attribute] of attributes) {
    document.querySelectorAll<HTMLElement>(`[${dataAttribute}]`).forEach((element) => {
      const key = element.getAttribute(dataAttribute)
      const message = key ? chrome.i18n.getMessage(key) : ''
      if (message) element.setAttribute(attribute, message)
    })
  }
}
