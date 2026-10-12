/**
 * OnSong® Binder export (.onsongbinder).
 *
 * A binder is a ZIP whose folders are named after object identifiers, each
 * holding a manifest.json. A set looks like this:
 *
 *     manifest.json                                  the set
 *     songs/<song id>/manifest.json                  one per song, in order
 *     songs/<song id>/<slug>.txt                     the chart
 *     songs/<song id>/attachments/<id>/manifest.json
 *
 * Spec: https://onsongapp.com/developers/onsong-binder/
 *
 * What this export can and cannot do: the band's charts are PDFs that live in
 * forScore, and this app only ever sees titles, artists and durations. A binder
 * therefore carries the running order and one short text chart per song naming
 * the forScore file — not the notes themselves. Importing it creates new songs
 * in the OnSong library rather than pointing at ones already there; OnSong has
 * no documented way to reference a song by title.
 *
 * Only the fields that carry meaning are written. The reference binder from
 * OnSong also stores fonts, margins and colours with every song; those are
 * display defaults the app fills in itself.
 */

import { artistName, duration, formatDuration, hasDuration } from './data'
import { targetSlug, today, type ExportMeta } from './export'
import type { SetlistEntry } from './scorer'
import { zip, type ZipEntry } from './zip'

/** The OnSong release that introduced the binder format. */
const BINDER_VERSION = 2026

/** The MIME type the spec gives the format. */
export const BINDER_MIME = 'application/onsong-binder'

/**
 * A UUID derived from the song id instead of a random one, so exporting the
 * same setlist twice produces the same identifiers. Not a real v5 UUID — it
 * only has to be stable and unique within one binder.
 */
export function stableId(seed: string): string {
  const words = [0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f]
  const hashes = words.map((start) => {
    let hash = start
    for (let i = 0; i < seed.length; i++) {
      hash ^= seed.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    return hash >>> 0
  })
  const hex = hashes.map((value) => value.toString(16).padStart(8, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    // Version 4 and the RFC 4122 variant, so OnSong sees a well-formed UUID.
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ]
    .join('-')
    .toUpperCase()
}

/** "Avicii - Wake me up" -> "avicii-wake-me-up", safe inside a ZIP. */
export function slug(value: string): string {
  const folded = value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return folded || 'song'
}

/**
 * The chart OnSong shows for one song: title and artist on the first two
 * lines, then metadata, then a pointer at the real notes. OnSong reads a
 * leading "Name: value" block as song metadata.
 */
export function chart(item: SetlistEntry, position: number, setTitle: string): string {
  const artist = artistName(item.song)
  const lines = [item.song.title]
  if (artist) lines.push(artist)
  if (hasDuration(item.song)) lines.push(`Duration: ${formatDuration(duration(item.song))}`)
  lines.push('')
  lines.push(`${setTitle} · Position ${position}`)
  lines.push(
    item.song.file
      ? `Noten in forScore: ${item.song.file}`
      : 'Kein Chart hinterlegt – Noten bitte selbst anhängen.',
  )
  return `${lines.join('\n')}\n`
}

function songManifest(
  item: SetlistEntry,
  songId: string,
  attachmentId: string,
  fileName: string,
  assembled: string,
): unknown {
  return {
    '$binder.ID': songId,
    '$binder.class': 'Song',
    '$binder.assembledOn': assembled,
    '$binder.attachments': [
      { '$binder.class': 'SongAttachment', '$binder.ref': `attachments/${attachmentId}` },
    ],
    ID: songId,
    class: 'Song',
    title: item.song.title,
    artist: artistName(item.song) || null,
    // Seconds, the same unit the reference binder uses. Null when forScore has
    // none, so OnSong shows no length rather than a made-up one.
    duration: hasDuration(item.song) ? duration(item.song) : null,
    filename: fileName,
    usefile: false,
    imported: true,
    libraryStatus: 0,
    version: BINDER_VERSION,
    created: assembled,
    modified: assembled,
  }
}

function attachmentManifest(
  attachmentId: string,
  songId: string,
  fileName: string,
  assembled: string,
  epoch: number,
): unknown {
  return {
    '$binder.ID': attachmentId,
    '$binder.class': 'SongAttachment',
    '$binder.assembledOn': assembled,
    ID: attachmentId,
    songID: songId,
    filename: fileName,
    mimetype: 'text/plain',
    created: epoch,
    modified: epoch,
  }
}

/** "Saitenhieb 2h 2026-10-12" — the same name the .4ss export uses. */
export function setTitle(meta: ExportMeta): string {
  return `Saitenhieb ${targetSlug(meta.targetSeconds)} ${meta.date ?? today()}`
}

/** The files that make up the binder, in archive order. */
export function binderEntries(
  list: SetlistEntry[],
  meta: ExportMeta,
  now = new Date(),
): ZipEntry[] {
  const assembled = `${now.toISOString().slice(0, 19)}Z`
  const epoch = Math.floor(now.getTime() / 1000)
  const title = setTitle(meta)
  const entries: ZipEntry[] = []
  const refs: unknown[] = []
  const used = new Set<string>()

  list.forEach((item, index) => {
    // Two free-text songs can share a title; keep the folder names apart.
    let songId = stableId(item.song.id)
    while (used.has(songId)) songId = stableId(`${songId}/${index}`)
    used.add(songId)
    const attachmentId = stableId(`attachment:${songId}`)
    const fileName = `${slug(`${artistName(item.song)} ${item.song.title}`)}.txt`
    const folder = `songs/${songId}`

    refs.push({ '$binder.class': 'Song', '$binder.ref': folder })
    entries.push({
      path: `${folder}/manifest.json`,
      data: JSON.stringify(songManifest(item, songId, attachmentId, fileName, assembled), null, 1),
    })
    entries.push({
      path: `${folder}/attachments/${attachmentId}/manifest.json`,
      data: JSON.stringify(
        attachmentManifest(attachmentId, songId, fileName, assembled, epoch),
        null,
        1,
      ),
    })
    // The chart itself sits next to the attachment manifest, not next to the
    // song's — that is where the reference binder puts it.
    entries.push({
      path: `${folder}/attachments/${attachmentId}/${fileName}`,
      data: chart(item, index + 1, title),
    })
  })

  const setId = stableId(`set:${title}:${list.map((item) => item.song.id).join('|')}`)
  entries.unshift({
    path: 'manifest.json',
    data: JSON.stringify(
      {
        '$binder.ID': setId,
        '$binder.class': 'Set',
        '$binder.assembledOn': assembled,
        '$binder.songs': refs,
        ID: setId,
        class: 'SongSet',
        title,
        name: title,
        datetime: assembled,
        quantity: list.length,
        orderMethod: 'orderIndex',
        orderIndex: 0,
      },
      null,
      1,
    ),
  })
  return entries
}

export function asOnSongBinder(
  list: SetlistEntry[],
  meta: ExportMeta,
  now = new Date(),
): Uint8Array<ArrayBuffer> {
  return zip(binderEntries(list, meta, now), now)
}

/** "Saitenhieb_2h_2026-10-12.onsongbinder" */
export function onSongFileName(meta: ExportMeta): string {
  return `Saitenhieb_${targetSlug(meta.targetSeconds)}_${meta.date ?? today()}.onsongbinder`
}
