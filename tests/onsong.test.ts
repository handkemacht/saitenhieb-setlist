import { describe, expect, it } from 'vitest'
import { customSong } from '../src/data'
import {
  asOnSongBinder,
  binderEntries,
  chart,
  onSongFileName,
  setTitle,
  slug,
  stableId,
} from '../src/onsong'
import { createContext, entry, generate, type SetlistEntry } from '../src/scorer'
import { crc32, zip } from '../src/zip'
import { data } from './fixtures'

const ctx = createContext(data, { halfLifeMonths: 12 })
const list = generate(ctx, { targetSeconds: 7200, bufferSeconds: 30 })
const meta = { targetSeconds: 7200, bufferSeconds: 30, date: '2026-10-12' }
const AT = new Date('2026-10-12T19:30:00Z')

/**
 * Reads an archive back through its central directory — the same way an
 * unzipper does, so a wrong offset or length shows up here instead of on an
 * iPad in the rehearsal room.
 */
function unzip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()

  let end = bytes.length - 22
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0) throw new Error('kein End-of-central-directory-Record')
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)

  const files = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`Eintrag ${i} hat keine Signatur`)
    const crc = view.getUint32(at + 16, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const localAt = view.getUint32(at + 42, true)
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))

    if (view.getUint32(localAt, true) !== 0x04034b50) throw new Error(`${name}: lokaler Header fehlt`)
    const localName = view.getUint16(localAt + 26, true)
    const localExtra = view.getUint16(localAt + 28, true)
    const start = localAt + 30 + localName + localExtra
    const payload = bytes.subarray(start, start + size)
    if (crc32(payload) !== crc) throw new Error(`${name}: CRC passt nicht`)
    files.set(name, decoder.decode(payload))
    at += 46 + nameLength + extraLength + commentLength
  }
  return files
}

describe('zip', () => {
  it('matches the reference CRC32', () => {
    // The check value from the zlib test vector.
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('round-trips entries, umlauts included', () => {
    const files = unzip(zip([
      { path: 'a.txt', data: 'hallo' },
      { path: 'ordner/Ständchen für Opa.txt', data: 'Grüße' },
      { path: 'leer.txt', data: '' },
    ], AT))
    expect([...files.keys()]).toEqual(['a.txt', 'ordner/Ständchen für Opa.txt', 'leer.txt'])
    expect(files.get('ordner/Ständchen für Opa.txt')).toBe('Grüße')
    expect(files.get('leer.txt')).toBe('')
  })

  it('writes a readable archive with no entries', () => {
    expect(unzip(zip([], AT)).size).toBe(0)
  })
})

describe('ids and names', () => {
  it('derives the same id from the same song every time', () => {
    expect(stableId('Avicii - Wake me up')).toBe(stableId('Avicii - Wake me up'))
    expect(stableId('Avicii - Wake me up')).not.toBe(stableId('Robbie Williams - Angels'))
    expect(stableId('x')).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-8[0-9A-F]{3}-[0-9A-F]{12}$/)
  })

  it('makes file names safe', () => {
    expect(slug('Die Ärzte Schrei nach Liebe')).toBe('die-arzte-schrei-nach-liebe')
    expect(slug("AC/DC - Highway to Hell")).toBe('ac-dc-highway-to-hell')
    expect(slug('!!!')).toBe('song')
  })

  it('names the file and the set like the forScore export', () => {
    expect(onSongFileName(meta)).toBe('Saitenhieb_2h_2026-10-12.onsongbinder')
    expect(setTitle(meta)).toBe('Saitenhieb 2h 2026-10-12')
  })
})

describe('binder', () => {
  const files = unzip(asOnSongBinder(list, meta, AT))
  const set = JSON.parse(files.get('manifest.json')!)

  it('has a set manifest that references every song in order', () => {
    expect(set['$binder.class']).toBe('Set')
    expect(set.class).toBe('SongSet')
    expect(set.title).toBe('Saitenhieb 2h 2026-10-12')
    expect(set.quantity).toBe(list.length)
    expect(set['$binder.songs']).toHaveLength(list.length)

    const titles = set['$binder.songs'].map((ref: Record<string, string>) => {
      expect(ref['$binder.class']).toBe('Song')
      return JSON.parse(files.get(`${ref['$binder.ref']}/manifest.json`)!).title
    })
    expect(titles).toEqual(list.map((item) => item.song.title))
  })

  it('gives every song a manifest, an attachment and a chart', () => {
    for (const ref of set['$binder.songs']) {
      const folder = ref['$binder.ref'] as string
      const song = JSON.parse(files.get(`${folder}/manifest.json`)!)
      expect(song.ID).toBe(song['$binder.ID'])
      expect(folder).toBe(`songs/${song.ID}`)
      expect(song['$binder.attachments']).toHaveLength(1)

      const attachmentRef = song['$binder.attachments'][0]['$binder.ref'] as string
      const attachment = JSON.parse(files.get(`${folder}/${attachmentRef}/manifest.json`)!)
      expect(attachment['$binder.class']).toBe('SongAttachment')
      expect(attachment.songID).toBe(song.ID)
      // The chart sits next to the attachment manifest, named by "filename".
      expect(attachment.filename).toBe(song.filename)
      expect(files.has(`${folder}/${attachmentRef}/${attachment.filename}`)).toBe(true)
    }
  })

  it('carries the duration in seconds and leaves it null when forScore has none', () => {
    const songs = [...files.entries()]
      .filter(([path]) => /^songs\/[^/]+\/manifest\.json$/.test(path))
      .map(([, text]) => JSON.parse(text))
    const byTitle = new Map(songs.map((song) => [song.title, song]))
    for (const item of list) {
      expect(byTitle.get(item.song.title)!.duration).toBe(item.song.duration)
    }
    expect(songs.some((song) => song.duration !== null)).toBe(true)
  })

  it('points at the forScore file in the chart', () => {
    const text = chart(list[0]!, 1, 'Saitenhieb 2h 2026-10-12')
    expect(text.split('\n')[0]).toBe(list[0]!.song.title)
    expect(text).toContain('Position 1')
    expect(text).toContain(`Noten in forScore: ${list[0]!.song.file}`)
  })

  it('handles free-text songs and two songs with the same title', () => {
    const mixed: SetlistEntry[] = [
      entry(customSong('Pause', null, 120), { custom: true }),
      entry(customSong('Pause', null, 120), { custom: true }),
      entry(list[0]!.song),
    ]
    const archive = unzip(asOnSongBinder(mixed, meta, AT))
    const manifest = JSON.parse(archive.get('manifest.json')!)
    const folders = manifest['$binder.songs'].map((r: Record<string, string>) => r['$binder.ref'])
    expect(new Set(folders).size).toBe(3)
    const free = JSON.parse(archive.get(`${folders[0]}/manifest.json`)!)
    expect(free.artist).toBeNull()
    expect(free.duration).toBe(120)
    const attachment = free['$binder.attachments'][0]['$binder.ref']
    expect(archive.get(`${folders[0]}/${attachment}/${free.filename}`)).toContain(
      'Kein Chart hinterlegt',
    )
  })

  it('produces the same bytes for the same setlist', () => {
    expect(binderEntries(list, meta, AT)).toEqual(binderEntries(list, meta, AT))
  })
})
