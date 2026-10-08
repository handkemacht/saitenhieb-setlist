/**
 * The bottom sheet for one slot: the five best alternatives with their score
 * share, a search over the pool, and a free-text song. Each result can either
 * replace the song in that slot or be inserted in front of it.
 */

import {
  artistName,
  CUSTOM_SONG_DURATION,
  customSong,
  duration,
  formatDuration,
  type Song,
} from '../data'
import type { Candidate } from '../scorer'
import { searchSongs } from './search'

export type SlotAction =
  | { kind: 'replace'; song: Song; custom?: boolean }
  | { kind: 'insert'; song: Song; custom?: boolean }

export interface SheetOptions {
  /** Headline — the song currently in the slot, or null when appending. */
  current: Song | null
  position: number
  alternatives: Candidate[]
  pool: Song[]
  /** Ids already in the list; they are shown but marked. */
  used: Set<string>
  onPick: (action: SlotAction) => void
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag)
  if (className) created.className = className
  if (text !== undefined) created.textContent = text
  return created
}

function label(song: Song): string {
  const artist = artistName(song)
  return artist ? `${artist} · ${song.title}` : song.title
}

export function openSlotSheet(options: SheetOptions): void {
  const dialog = node('dialog', 'sheet')

  const head = node('div', 'sheet-head')
  head.append(
    node(
      'strong',
      undefined,
      options.current
        ? `${String(options.position).padStart(2, '0')} · ${label(options.current)}`
        : `Song an Position ${options.position} einfügen`,
    ),
  )
  const close = node('button', 'ghost', 'Fertig')
  close.type = 'button'
  close.addEventListener('click', () => dialog.close())
  head.append(close)

  const body = node('div', 'sheet-body')

  const pick = (action: SlotAction): void => {
    options.onPick(action)
    dialog.close()
  }

  /** One tappable result row; tapping replaces, the side button inserts. */
  const option = (song: Song, share?: number): HTMLElement => {
    const wrapper = node('div')
    wrapper.style.display = 'grid'
    wrapper.style.gridTemplateColumns = '1fr auto'
    wrapper.style.gap = '6px'

    const main = node('button', 'option')
    main.type = 'button'
    const text = node('span')
    text.append(document.createTextNode(label(song)))
    const sub = node('span', 'sub')
    sub.textContent = [
      formatDuration(duration(song)),
      song.plays > 0 ? `gespielt ${song.plays}×` : 'noch nie gespielt',
      options.used.has(song.id) ? 'schon in der Liste' : '',
    ]
      .filter(Boolean)
      .join(' · ')
    text.append(sub)
    main.append(text)
    main.append(node('span', 'share', share === undefined ? '' : `${Math.round(share * 100)} %`))
    main.disabled = options.used.has(song.id)
    main.addEventListener('click', () => pick({ kind: 'replace', song }))

    const insert = node('button', undefined, '+')
    insert.type = 'button'
    insert.title = 'Davor einfügen'
    insert.setAttribute('aria-label', `${label(song)} davor einfügen`)
    insert.style.minWidth = 'var(--tap)'
    insert.disabled = options.used.has(song.id)
    insert.addEventListener('click', () => pick({ kind: 'insert', song }))

    wrapper.append(main, insert)
    return wrapper
  }

  if (options.current && options.alternatives.length > 0) {
    body.append(node('h3', undefined, 'Alternativen für diesen Platz'))
    for (const candidate of options.alternatives) {
      body.append(option(candidate.song, candidate.share))
    }
  }

  body.append(node('h3', undefined, 'Im Song-Pool suchen'))
  const field = node('input')
  field.type = 'search'
  field.placeholder = 'Titel oder Artist …'
  field.autocomplete = 'off'
  body.append(field)
  const results = node('div')
  results.style.marginTop = '6px'
  body.append(results)

  const renderResults = (): void => {
    // With an empty field, offer songs that are not in the list yet — the most
    // played ones are all in it already and would just be a wall of grey.
    const haystack = field.value.trim()
      ? options.pool
      : options.pool.filter((song) => !options.used.has(song.id))
    const hits = searchSongs(haystack, field.value, 10)
    results.replaceChildren(
      ...(hits.length > 0
        ? hits.map((hit) => option(hit.song))
        : [node('p', 'empty', 'Nichts gefunden.')]),
    )
  }
  field.addEventListener('input', renderResults)
  renderResults()

  body.append(node('h3', undefined, 'Oder als Freitext'))
  const free = node('div', 'free-text')
  const title = node('input')
  title.type = 'text'
  title.placeholder = 'Titel'
  const artistInput = node('input')
  artistInput.type = 'text'
  artistInput.placeholder = 'Artist (optional)'
  const seconds = node('input')
  seconds.type = 'number'
  seconds.min = '10'
  seconds.max = '1800'
  seconds.step = '5'
  seconds.value = String(CUSTOM_SONG_DURATION)
  seconds.setAttribute('aria-label', 'Dauer in Sekunden')
  const secondsLabel = node('label')
  secondsLabel.append(document.createTextNode('Dauer (Sekunden)'), seconds)

  const buttons = node('div', 'buttons')
  const make = (): Song | null => {
    const name = title.value.trim()
    if (!name) {
      title.focus()
      return null
    }
    return customSong(name, artistInput.value.trim() || null, Number(seconds.value) || CUSTOM_SONG_DURATION)
  }
  const replaceButton = node('button', undefined, 'Ersetzen')
  replaceButton.type = 'button'
  replaceButton.disabled = options.current === null
  replaceButton.addEventListener('click', () => {
    const song = make()
    if (song) pick({ kind: 'replace', song, custom: true })
  })
  const insertButton = node('button', 'primary', 'Einfügen')
  insertButton.type = 'button'
  insertButton.addEventListener('click', () => {
    const song = make()
    if (song) pick({ kind: 'insert', song, custom: true })
  })
  buttons.append(replaceButton, insertButton)
  free.append(title, artistInput, secondsLabel, buttons)
  body.append(free)

  dialog.append(head, body)
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
}
