let counter = 0
const enhanced = new WeakSet<HTMLSelectElement>()

export function enhanceSelect(select: HTMLSelectElement): void {
  if (enhanced.has(select)) return
  const parent = select.parentNode
  if (!parent) return
  enhanced.add(select)

  const id = `tc-dd-${++counter}`

  const wrapper = document.createElement('div')
  wrapper.className = 'tc-dropdown'

  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'tc-dropdown__trigger'
  trigger.setAttribute('role', 'combobox')
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-controls', `${id}-list`)

  const labelEl = document.createElement('span')
  labelEl.className = 'tc-dropdown__label'

  const chevron = document.createElement('span')
  chevron.className = 'tc-dropdown__chevron'
  chevron.setAttribute('aria-hidden', 'true')
  chevron.textContent = '▾'

  trigger.append(labelEl, chevron)

  const list = document.createElement('div')
  list.className = 'tc-dropdown__list'
  list.id = `${id}-list`
  list.setAttribute('role', 'listbox')
  list.hidden = true

  parent.insertBefore(wrapper, select)
  wrapper.append(select, trigger, list)
  select.classList.add('tc-dropdown__native')
  select.setAttribute('tabindex', '-1')
  select.setAttribute('aria-hidden', 'true')

  let activeIndex = -1

  const syncLabel = (): void => {
    const opt = select.options[select.selectedIndex]
    labelEl.textContent = opt ? (opt.textContent ?? '') : ''
  }

  const rebuildList = (): void => {
    const items = Array.from(select.options).map((opt, i) => {
      const item = document.createElement('div')
      item.className = 'tc-dropdown__option'
      item.setAttribute('role', 'option')
      item.id = `${id}-opt-${i}`
      item.textContent = opt.textContent
      item.dataset.index = String(i)
      const isSelected = i === select.selectedIndex
      item.setAttribute('aria-selected', isSelected ? 'true' : 'false')
      if (isSelected) item.classList.add('is-selected')
      return item
    })
    list.replaceChildren(...items)
    activeIndex = -1
  }

  const setActive = (i: number): void => {
    const items = list.children
    const prev = activeIndex >= 0 ? (items[activeIndex] as HTMLElement | undefined) : undefined
    if (prev) prev.classList.remove('is-active')
    if (i < 0 || i >= items.length) {
      activeIndex = -1
      trigger.removeAttribute('aria-activedescendant')
      return
    }
    const el = items[i] as HTMLElement
    el.classList.add('is-active')
    el.scrollIntoView({ block: 'nearest' })
    trigger.setAttribute('aria-activedescendant', el.id)
    activeIndex = i
  }

  const onOutside = (event: Event): void => {
    if (!wrapper.contains(event.target as Node)) close()
  }

  const open = (): void => {
    if (!list.hidden) return
    rebuildList()
    list.hidden = false
    const triggerRect = trigger.getBoundingClientRect()
    const spaceBelow = window.innerHeight - triggerRect.bottom - 8
    list.classList.toggle('is-up', list.offsetHeight > spaceBelow)
    trigger.setAttribute('aria-expanded', 'true')
    setActive(Math.max(select.selectedIndex, 0))
    document.addEventListener('pointerdown', onOutside, true)
  }

  const close = (): void => {
    if (list.hidden) return
    list.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    trigger.removeAttribute('aria-activedescendant')
    activeIndex = -1
    document.removeEventListener('pointerdown', onOutside, true)
  }

  const commit = (i: number): void => {
    const opt = select.options[i]
    if (!opt) return
    if (select.value !== opt.value) {
      select.value = opt.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      select.dispatchEvent(new Event('input', { bubbles: true }))
    }
    syncLabel()
    close()
    trigger.focus()
  }

  trigger.addEventListener('click', () => {
    if (list.hidden) open()
    else close()
  })

  trigger.addEventListener('keydown', (event) => {
    if (list.hidden) {
      if (
        event.key === 'Enter' ||
        event.key === ' ' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp'
      ) {
        event.preventDefault()
        open()
      }
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActive(Math.min(activeIndex + 1, list.children.length - 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive(Math.max(activeIndex - 1, 0))
        break
      case 'Home':
        event.preventDefault()
        setActive(0)
        break
      case 'End':
        event.preventDefault()
        setActive(list.children.length - 1)
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        if (activeIndex >= 0) commit(activeIndex)
        break
      case 'Escape':
        event.preventDefault()
        close()
        trigger.focus()
        break
      case 'Tab':
        close()
        break
    }
  })

  list.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest(
      '.tc-dropdown__option',
    ) as HTMLElement | null
    if (!target) return
    commit(Number(target.dataset.index))
  })

  list.addEventListener('mousemove', (event) => {
    const target = (event.target as HTMLElement).closest(
      '.tc-dropdown__option',
    ) as HTMLElement | null
    if (!target) return
    const i = Number(target.dataset.index)
    if (i !== activeIndex) setActive(i)
  })

  const observer = new MutationObserver(() => {
    queueMicrotask(() => {
      syncLabel()
      if (!list.hidden) rebuildList()
    })
  })
  observer.observe(select, { childList: true, subtree: true, attributes: true })

  select.addEventListener('change', () => {
    syncLabel()
  })

  syncLabel()
}
