/**
 * Exports: clipboard text, forScore setlist, share link, print.
 *
 * Everything here is a pure function apart from the three thin wrappers at the
 * bottom that actually touch the clipboard, a download or the printer.
 */

import {
  artistName,
  customSong,
  duration,
  formatDuration,
  isCustomSongId,
  type SetlistData,
  type Song,
} from './data'
import {
  DEFAULT_BUFFER_SECONDS,
  entry,
  songSeconds,
  totalSeconds,
  type SetlistEntry,
} from './scorer'
import { DEFAULT_HALF_LIFE_MONTHS } from './stats'

/** Label for a target length: 5400 -> "1,5 h". */
export function formatTarget(targetSeconds: number): string {
  const hours = targetSeconds / 3600
  return `${String(hours).replace('.', ',')} h`
}

export interface ExportMeta {
  targetSeconds: number
  bufferSeconds: number
  date?: string
}

/** Today as YYYY-MM-DD. */
export function today(now = new Date()): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
}

/** "Saitenhieb · 2 h · 28 Songs · 107 min (+Puffer 121 min)" */
export function headline(list: SetlistEntry[], meta: ExportMeta): string {
  const pure = Math.round(songSeconds(list) / 60)
  const padded = Math.round(totalSeconds(list, meta.bufferSeconds) / 60)
  return (
    `Saitenhieb · ${formatTarget(meta.targetSeconds)} · ${list.length} Songs · ` +
    `${pure} min (+Puffer ${padded} min)`
  )
}

/** The clipboard text: headline, then one numbered line per song. */
export function asText(list: SetlistEntry[], meta: ExportMeta): string {
  const lines = list.map((item, index) => {
    const artist = artistName(item.song)
    const name = artist ? `${artist} – ${item.song.title}` : item.song.title
    return `${String(index + 1).padStart(2, '0')}. ${name}  (${formatDuration(duration(item.song))})`
  })
  return [headline(list, meta), '', ...lines].join('\n')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * forScore Open Setlist Format. Pool songs name their file, free-text songs
 * become a placeholder. See https://forscore.co/developers-file-types/
 */
export function asForScore(list: SetlistEntry[], meta: ExportMeta): string {
  const title = `Saitenhieb ${formatTarget(meta.targetSeconds)} ${meta.date ?? today()}`
  const rows = list.map((item) =>
    item.custom || !item.song.file
      ? `  <placeholder title="${escapeXml(item.song.title)}"/>`
      : `  <score path="${escapeXml(item.song.file)}" title="${escapeXml(item.song.id)}"/>`,
  )
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<forScore kind="setlist" version="1.0" title="${escapeXml(title)}">`,
    ...rows,
    '</forScore>',
    '',
  ].join('\n')
}

/** "Saitenhieb_2h_2026-10-08.4ss" */
export function forScoreFileName(meta: ExportMeta): string {
  const hours = formatTarget(meta.targetSeconds).replace(/[ ,]/g, (match) =>
    match === ',' ? '-' : '',
  )
  return `Saitenhieb_${hours}_${meta.date ?? today()}.4ss`
}

// --- share link ------------------------------------------------------------

/**
 * Hash layout, all parts separated by "~":
 *   v1 ~ <target in minutes> ~ <buffer s> ~ <half-life months> ~ <songs>
 * Songs are separated by "." and are either an index into the alphabetical
 * pool (base36) or a free-text song as "t:<title>|<artist>|<seconds>".
 * A trailing "!" marks a pinned entry.
 */
const HASH_VERSION = 'v1'

export interface ShareState {
  targetSeconds: number
  bufferSeconds: number
  halfLifeMonths: number
  list: SetlistEntry[]
}

/** The pool in a stable alphabetical order — the index is the share-link id. */
export function poolOrder(data: SetlistData): Song[] {
  return [...data.songs].sort((a, b) => a.id.localeCompare(b.id, 'de'))
}

function encodeField(value: string): string {
  return encodeURIComponent(value).replace(/[.~!]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)
}

export function encodeShare(state: ShareState, data: SetlistData): string {
  const index = new Map(poolOrder(data).map((song, i) => [song.id, i]))
  const parts = state.list.map((item) => {
    const position = index.get(item.song.id)
    const body =
      position === undefined || item.custom
        ? `t:${encodeField(item.song.title)}|${encodeField(artistName(item.song))}|${duration(item.song)}`
        : position.toString(36)
    return item.pinned ? `${body}!` : body
  })
  return [
    HASH_VERSION,
    Math.round(state.targetSeconds / 60),
    state.bufferSeconds,
    state.halfLifeMonths,
    parts.join('.'),
  ].join('~')
}

/** Reads a hash back. Returns null when it is missing, foreign or unusable. */
export function decodeShare(hash: string, data: SetlistData): ShareState | null {
  const raw = hash.replace(/^#/, '')
  if (!raw) return null
  const [version, minutes, buffer, halfLife, songs] = raw.split('~')
  if (version !== HASH_VERSION || !songs) return null

  const pool = poolOrder(data)
  const list: SetlistEntry[] = []
  for (const part of songs.split('.')) {
    const pinned = part.endsWith('!')
    const body = pinned ? part.slice(0, -1) : part
    if (!body) continue
    if (body.startsWith('t:')) {
      const [title = '', artist = '', seconds = ''] = body.slice(2).split('|')
      const song = customSong(
        decodeURIComponent(title),
        decodeURIComponent(artist) || null,
        Number(seconds) || 225,
      )
      list.push(entry(song, { pinned, custom: true }))
    } else {
      const song = pool[Number.parseInt(body, 36)]
      if (song) list.push(entry(song, { pinned }))
    }
  }
  if (list.length === 0) return null

  return {
    targetSeconds: (Number(minutes) || 120) * 60,
    bufferSeconds: Number.isFinite(Number(buffer)) ? Number(buffer) : DEFAULT_BUFFER_SECONDS,
    halfLifeMonths: Number(halfLife) || DEFAULT_HALF_LIFE_MONTHS,
    list,
  }
}

// --- the three side effects ------------------------------------------------

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  // Safari without clipboard permission: fall back to a hidden textarea.
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.append(field)
  field.select()
  document.execCommand('copy')
  field.remove()
}

export function download(content: string, fileName: string): void {
  const blob = new Blob([content], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

export function print(): void {
  window.print()
}

export { isCustomSongId }
