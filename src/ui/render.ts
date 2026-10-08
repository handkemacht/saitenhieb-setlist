/** Builds the setlist rows. No state of its own — it renders what it is given. */

import { artistName, duration, formatDuration, hasDuration } from '../data'
import type { SetlistEntry } from '../scorer'
import { icons } from './icons'

export interface RowHandlers {
  onKick: (index: number) => void
  onPin: (index: number) => void
  onSlot: (index: number) => void
  onAppend: () => void
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconButton(label: string, icon: string, pressed?: boolean): HTMLButtonElement {
  const button = element('button')
  button.type = 'button'
  button.innerHTML = icon
  button.title = label
  button.setAttribute('aria-label', label)
  if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed))
  return button
}

function row(item: SetlistEntry, index: number, handlers: RowHandlers): HTMLLIElement {
  const li = element('li', 'song')
  li.dataset.index = String(index)
  if (item.pinned) li.classList.add('pinned')

  const handle = element('button', 'handle', String(index + 1).padStart(2, '0'))
  handle.type = 'button'
  handle.dataset.handle = 'true'
  handle.title = 'Zum Umsortieren ziehen'
  handle.setAttribute('aria-label', `Position ${index + 1}, zum Umsortieren ziehen`)
  li.append(handle)

  const title = element('div', 'title')
  const artist = artistName(item.song)
  if (artist) {
    title.append(element('span', 'artist', `${artist} · `))
  }
  title.append(document.createTextNode(item.song.title))
  li.append(title)

  const meta = element('div', 'meta')
  meta.append(element('span', 'time', formatDuration(duration(item.song))))
  if (!hasDuration(item.song)) {
    meta.append(element('span', 'badge estimate', 'Dauer geschätzt'))
  }
  if (item.custom) {
    meta.append(element('span', 'badge', 'Freitext'))
  } else {
    meta.append(element('span', 'badge', `gespielt ${item.song.plays}×`))
  }
  if (item.filled) meta.append(element('span', 'badge filled', 'nachgerückt'))
  if (item.pinned) meta.append(element('span', 'badge', 'gepinnt'))
  li.append(meta)

  const actions = element('div', 'row-actions')
  const pin = iconButton(
    item.pinned ? 'Pin lösen' : 'Song festpinnen',
    item.pinned ? icons.pinFilled : icons.pin,
    item.pinned,
  )
  pin.addEventListener('click', () => handlers.onPin(index))
  const slot = iconButton('Alternativen und Einfügen', icons.more)
  slot.addEventListener('click', () => handlers.onSlot(index))
  const kick = iconButton('Song rauskicken', icons.close)
  kick.addEventListener('click', () => handlers.onKick(index))
  actions.append(pin, slot, kick)
  li.append(actions)

  return li
}

export function renderList(
  root: HTMLOListElement,
  list: SetlistEntry[],
  handlers: RowHandlers,
): void {
  root.replaceChildren(...list.map((item, index) => row(item, index, handlers)))
}

/** The dashed "add a song at the end" button below the list. */
export function renderAppend(root: HTMLElement, handlers: RowHandlers): void {
  const button = element('button', 'add-row', '+ Song einfügen')
  button.type = 'button'
  button.addEventListener('click', handlers.onAppend)
  root.replaceChildren(button)
}
