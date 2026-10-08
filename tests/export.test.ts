// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { customSong, duration, type Song } from '../src/data'
import {
  asForScore,
  asText,
  decodeShare,
  encodeShare,
  forScoreFileName,
  formatTarget,
  headline,
  poolOrder,
  today,
} from '../src/export'
import { createContext, entry, generate, type SetlistEntry } from '../src/scorer'
import { data } from './fixtures'

const ctx = createContext(data, { halfLifeMonths: 12 })
const list = generate(ctx, { targetSeconds: 7200, bufferSeconds: 30 })
const meta = { targetSeconds: 7200, bufferSeconds: 30, date: '2026-10-08' }

describe('text export', () => {
  it('formats the target the German way', () => {
    expect(formatTarget(3600)).toBe('1 h')
    expect(formatTarget(5400)).toBe('1,5 h')
    expect(formatTarget(10800)).toBe('3 h')
  })

  it('writes the headline from the real numbers', () => {
    expect(headline(list, meta)).toMatch(
      /^Saitenhieb · 2 h · \d+ Songs · \d+ min \(\+Puffer \d+ min\)$/,
    )
  })

  it('numbers every song and gives its length', () => {
    const lines = asText(list, meta).split('\n')
    expect(lines[1]).toBe('')
    expect(lines).toHaveLength(list.length + 2)
    expect(lines[2]).toMatch(/^01\. .+ – .+ {2}\(\d+:\d\d\)$/)
    expect(lines[list.length + 1]!.startsWith(String(list.length).padStart(2, '0'))).toBe(true)
  })

  it('leaves out the dash when a song has no artist', () => {
    const text = asText([entry(customSong('Pause', null, 60), { custom: true })], meta)
    expect(text.split('\n')[2]).toBe('01. Pause  (1:00)')
  })

  it('dates the file name', () => {
    expect(forScoreFileName(meta)).toBe('Saitenhieb_2h_2026-10-08.4ss')
    expect(forScoreFileName({ ...meta, targetSeconds: 5400 })).toBe(
      'Saitenhieb_1-5h_2026-10-08.4ss',
    )
    expect(today(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('forScore setlist', () => {
  const xml = asForScore(list, meta)

  it('is well-formed XML with one row per song', () => {
    const parsed = new DOMParser().parseFromString(xml, 'application/xml')
    expect(parsed.querySelector('parsererror')).toBeNull()
    const root = parsed.documentElement
    expect(root.tagName).toBe('forScore')
    expect(root.getAttribute('kind')).toBe('setlist')
    expect(root.getAttribute('version')).toBe('1.0')
    expect(root.getAttribute('title')).toBe('Saitenhieb 2 h 2026-10-08')
    expect(root.children).toHaveLength(list.length)
  })

  it('names the pdf exactly as forScore has it', () => {
    const parsed = new DOMParser().parseFromString(xml, 'application/xml')
    const paths = [...parsed.querySelectorAll('score')].map((node) => node.getAttribute('path'))
    expect(paths).toEqual(list.map((item) => item.song.file))
    // ids are NFD and must not be re-normalised on the way out
    for (const path of paths) expect(path!.normalize('NFD')).toBe(path)
  })

  it('turns a free-text song into a placeholder', () => {
    const mixed: SetlistEntry[] = [
      list[0]!,
      entry(customSong('Zugabe & Co <frei>', 'Wir', 200), { custom: true, pinned: true }),
    ]
    const parsed = new DOMParser().parseFromString(asForScore(mixed, meta), 'application/xml')
    expect(parsed.querySelector('parsererror')).toBeNull()
    expect(parsed.querySelectorAll('score')).toHaveLength(1)
    const placeholder = parsed.querySelector('placeholder')!
    expect(placeholder.getAttribute('title')).toBe('Zugabe & Co <frei>')
  })

  it('escapes quotes and ampersands in a real song title', () => {
    const tricky: Song = {
      id: 'A & B - "Was \'nun\'?" <x>',
      file: 'A & B - "Was \'nun\'?" <x>.pdf',
      title: '"Was \'nun\'?" <x>',
      artist: 'A & B',
      duration: 100,
      plays: 1,
    }
    const parsed = new DOMParser().parseFromString(
      asForScore([entry(tricky)], meta),
      'application/xml',
    )
    expect(parsed.querySelector('parsererror')).toBeNull()
    expect(parsed.querySelector('score')!.getAttribute('path')).toBe(tricky.file)
  })
})

describe('share link', () => {
  const state = { targetSeconds: 7200, bufferSeconds: 45, halfLifeMonths: 18, list }

  it('survives a round trip', () => {
    const back = decodeShare(encodeShare(state, data), data)!
    expect(back.targetSeconds).toBe(7200)
    expect(back.bufferSeconds).toBe(45)
    expect(back.halfLifeMonths).toBe(18)
    expect(back.list.map((item) => item.song.id)).toEqual(list.map((item) => item.song.id))
  })

  it('stays short — one song is at most three characters', () => {
    const hash = encodeShare(state, data)
    const songs = hash.split('~')[4]!
    expect(songs.split('.')).toHaveLength(list.length)
    for (const part of songs.split('.')) expect(part.length).toBeLessThanOrEqual(3)
    expect(hash.length).toBeLessThan(200)
  })

  it('keeps pins and free-text songs', () => {
    const mixed: SetlistEntry[] = [
      entry(list[0]!.song, { pinned: true }),
      entry(customSong('Ständchen für Opa', 'wir alle', 150), { custom: true, pinned: true }),
      entry(list[1]!.song),
    ]
    const back = decodeShare(encodeShare({ ...state, list: mixed }, data), data)!
    expect(back.list.map((item) => item.pinned)).toEqual([true, true, false])
    expect(back.list[1]!.custom).toBe(true)
    expect(back.list[1]!.song.title).toBe('Ständchen für Opa')
    expect(back.list[1]!.song.artist).toBe('wir alle')
    expect(duration(back.list[1]!.song)).toBe(150)
    expect(back.list[2]!.song.id).toBe(list[1]!.song.id)
  })

  it('handles a free-text song with separator characters in its title', () => {
    const odd = entry(customSong('a~b.c|d!e%f', 'x|y', 90), { custom: true })
    const back = decodeShare(encodeShare({ ...state, list: [odd] }, data), data)!
    expect(back.list).toHaveLength(1)
    expect(back.list[0]!.song.title).toBe('a~b.c|d!e%f')
    expect(back.list[0]!.song.artist).toBe('x|y')
  })

  it('refuses a missing, foreign or empty hash', () => {
    expect(decodeShare('', data)).toBeNull()
    expect(decodeShare('#', data)).toBeNull()
    expect(decodeShare('#v2~120~30~12~0.1', data)).toBeNull()
    expect(decodeShare('#v1~120~30~12~', data)).toBeNull()
    expect(decodeShare('#irgendwas', data)).toBeNull()
  })

  it('skips song indices that no longer exist', () => {
    const hash = `#v1~120~30~12~0.zzz.1`
    const back = decodeShare(hash, data)!
    expect(back.list).toHaveLength(2)
    expect(back.list[0]!.song.id).toBe(poolOrder(data)[0]!.id)
  })

  it('orders the pool stably, independent of data.json order', () => {
    const shuffled = { ...data, songs: [...data.songs].reverse() }
    expect(poolOrder(shuffled).map((song) => song.id)).toEqual(
      poolOrder(data).map((song) => song.id),
    )
  })
})
