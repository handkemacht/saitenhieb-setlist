import { describe, expect, it } from 'vitest'
import { customSong, duration, foldText, type Song } from '../src/data'

/** Lower-cased artist, for the "no two in a row" assertions. */
const artistName = (song: Song): string => (song.artist ?? '').toLowerCase()
import {
  alternatives,
  createContext,
  entry,
  estimateLength,
  generate,
  popularAverageDuration,
  rankCandidates,
  replaceAt,
  sameArtist,
  score,
  songSeconds,
  TARGET_TOLERANCE_SECONDS,
  totalSeconds,
  type SetlistEntry,
} from '../src/scorer'
import { CLOSER, data, MIDDLE, OPENER, tinyData } from './fixtures'

const ctx = createContext(data, { halfLifeMonths: 12 })
const HOUR = 3600

/** Rank of a song among all candidates for a slot at position r. */
function rankOf(songId: string, r: number): number {
  const ranked = rankCandidates(ctx, { r })
  return ranked.findIndex((candidate) => candidate.song.id === songId)
}

describe('score', () => {
  it('puts the usual opener on top at r = 0', () => {
    expect(rankOf(OPENER, 0)).toBe(0)
    const top = rankCandidates(ctx, { r: 0, limit: 3 })
    // clearly ahead, not a photo finish
    expect(top[0]!.score).toBeGreaterThan(top[1]!.score * 1.2)
    expect(top[0]!.score).toBeGreaterThan(top[2]!.score * 2)
  })

  it('puts the usual closer on top at r = 1', () => {
    expect(rankOf(CLOSER, 1)).toBe(0)
  })

  it('ranks the mid-set song high around r = 0.6 and low at the edges', () => {
    expect(rankOf(MIDDLE, 0.6)).toBeLessThan(5)
    expect(score(ctx, MIDDLE, 0.6)).toBeGreaterThan(score(ctx, MIDDLE, 0))
    expect(score(ctx, MIDDLE, 0.6)).toBeGreaterThan(score(ctx, MIDDLE, 1))
  })

  it('does not rank the opener first in the middle, nor the closer first at the start', () => {
    expect(rankOf(OPENER, 0.5)).toBeGreaterThan(0)
    expect(rankOf(CLOSER, 0)).toBeGreaterThan(0)
  })

  it('scores a never-played song with 0', () => {
    const unplayed = data.songs.filter((song) => song.plays === 0)
    expect(unplayed.length).toBeGreaterThan(0)
    for (const song of unplayed) expect(score(ctx, song.id, 0.5)).toBe(0)
  })

  it('is never negative and never zero for a played song', () => {
    for (const id of ctx.stats.played) {
      for (const r of [0, 0.25, 0.5, 0.75, 1]) expect(score(ctx, id, r)).toBeGreaterThan(0)
    }
  })

  it('rewards a known transition', () => {
    const small = createContext(tinyData(), { halfLifeMonths: 12, now: '2026-01-01' })
    const plain = score(small, 'B - Second', 0.5)
    const afterA = score(small, 'B - Second', 0.5, 'A - Opener')
    const beforeC = score(small, 'B - Second', 0.5, null, 'C - Third')
    expect(afterA).toBeGreaterThan(plain)
    expect(beforeC).toBeGreaterThan(plain)
    // B followed A in every gig: share 1, so trans = 1 + 2 * 1 = 3
    expect(afterA / plain).toBeCloseTo(3, 10)
  })
})

describe('rankCandidates', () => {
  it('never offers an excluded or blocked song', () => {
    const ranked = rankCandidates(ctx, { r: 0, exclude: [OPENER], blocked: ['Uncle Kracker - Follow Me'] })
    const ids = ranked.map((candidate) => candidate.song.id)
    expect(ids).not.toContain(OPENER)
    expect(ids).not.toContain('Uncle Kracker - Follow Me')
  })

  it('keeps the same artist away from a direct neighbour', () => {
    const small = createContext(tinyData(), { halfLifeMonths: 12, now: '2026-01-01' })
    const alt = small.songs.get('C - Alt')!
    const ranked = rankCandidates(small, { r: 0.5, prevSong: alt, exclude: ['C - Alt'] })
    expect(ranked.map((candidate) => candidate.song.id)).not.toContain('C - Third')
    expect(ranked.map((candidate) => candidate.song.id)).toContain('B - Second')
  })

  it('breaks the artist rule only when nothing else is left', () => {
    const small = createContext(tinyData(), { halfLifeMonths: 12, now: '2026-01-01' })
    const alt = small.songs.get('C - Alt')!
    const ranked = rankCandidates(small, {
      r: 0.5,
      prevSong: alt,
      exclude: ['C - Alt', 'A - Opener', 'B - Second', 'D - Closer'],
    })
    expect(ranked.map((candidate) => candidate.song.id)).toEqual(['C - Third'])
  })

  it('counts a feat. artist as the same artist', () => {
    const brunoMars = ctx.songs.get('Bruno Mars - Locked Out Of Heaven')!
    // Never hand-type an accented id — ids are NFD, a typed literal is NFC.
    const feature = data.songs.find((song) => foldText(song.id).includes('feat. bruno mars'))!.id
    expect(sameArtist(foldText('Rosé feat. Bruno Mars'), 'bruno mars')).toBe(true)
    // but not a name that merely shares a word
    expect(sameArtist('the mamas & the papas', 'the police')).toBe(false)
    const ranked = rankCandidates(ctx, { r: 0.3, prevSong: brunoMars })
    expect(ranked.map((candidate) => candidate.song.id)).not.toContain(feature)
    const free = rankCandidates(ctx, { r: 0.3 })
    expect(free.map((candidate) => candidate.song.id)).toContain(feature)
  })

  it('reports a share that sums to 1', () => {
    const ranked = rankCandidates(ctx, { r: 0.4, limit: 5 })
    expect(ranked).toHaveLength(5)
    expect(ranked.reduce((sum, candidate) => sum + candidate.share, 0)).toBeCloseTo(1, 10)
    expect(ranked[0]!.share).toBeGreaterThan(ranked[4]!.share)
  })

  it('ignores a free-text neighbour for the transition term, but not for the artist rule', () => {
    const r = 0.5
    const plain = rankCandidates(ctx, { r, limit: 1 })[0]!
    const ghost = rankCandidates(ctx, { r, prevSong: customSong('Irgendwas', 'Niemand'), limit: 1 })[0]!
    expect(ghost.song.id).toBe(plain.song.id)
    const blockArtist = customSong('Irgendwas', plain.song.artist ?? 'Niemand')
    const dodged = rankCandidates(ctx, { r, prevSong: blockArtist, limit: 1 })[0]!
    expect(dodged.song.id).not.toBe(plain.song.id)
  })
})

describe('generate', () => {
  it('estimates a plausible length', () => {
    expect(estimateLength(ctx, 2 * HOUR, 30)).toBeGreaterThan(20)
    expect(estimateLength(ctx, 2 * HOUR, 30)).toBeLessThan(36)
    expect(estimateLength(ctx, HOUR, 30)).toBeLessThan(estimateLength(ctx, 3 * HOUR, 30))
    expect(estimateLength(ctx, 2 * HOUR, 90)).toBeLessThan(estimateLength(ctx, 2 * HOUR, 0))
  })

  it('gets as close to every target as whole songs allow', () => {
    // You can never land closer than half a song, so that is the hard bound;
    // most targets are hit inside the +/- 2 minute tolerance outright.
    const grain = (popularAverageDuration(ctx) + 30) / 2
    const offsets = [1, 1.5, 2, 2.5, 3].map((hours) => {
      const target = hours * HOUR
      const list = generate(ctx, { targetSeconds: target, bufferSeconds: 30 })
      const off = totalSeconds(list, 30) - target
      expect(Math.abs(off), `${hours} h: ${off} s daneben`).toBeLessThanOrEqual(
        Math.max(TARGET_TOLERANCE_SECONDS, grain),
      )
      return Math.abs(off)
    })
    const inside = offsets.filter((off) => off <= TARGET_TOLERANCE_SECONDS)
    expect(inside.length, `${offsets.join(', ')} s`).toBeGreaterThanOrEqual(4)
  })

  it('never ends on the worse side of a target it cannot hit', () => {
    // 3 h sits between 42 and 43 songs; the loop must return the closer one.
    const target = 3 * HOUR
    const list = generate(ctx, { targetSeconds: target, bufferSeconds: 30 })
    const off = Math.abs(totalSeconds(list, 30) - target)
    const longer = totalSeconds(list, 30) + 254 - target
    expect(off).toBeLessThan(Math.abs(longer))
  })

  it('is deterministic without a random source', () => {
    const a = generate(ctx, { targetSeconds: 2 * HOUR })
    const b = generate(ctx, { targetSeconds: 2 * HOUR })
    expect(a.map((item) => item.song.id)).toEqual(b.map((item) => item.song.id))
  })

  it('opens and closes with the band favourites', () => {
    const list = generate(ctx, { targetSeconds: 2 * HOUR, bufferSeconds: 30 })
    expect(list[0]!.song.id).toBe(OPENER)
    expect(list[list.length - 1]!.song.id).toBe(CLOSER)
  })

  it('never repeats a song and never stacks an artist', () => {
    const list = generate(ctx, { targetSeconds: 3 * HOUR, bufferSeconds: 30 })
    const ids = list.map((item) => item.song.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (let i = 1; i < list.length; i++) {
      expect(artistName(list[i]!.song)).not.toBe(artistName(list[i - 1]!.song))
    }
  })

  it('leaves out blocked songs', () => {
    const blocked = [OPENER, CLOSER, MIDDLE]
    const list = generate(ctx, { targetSeconds: 2 * HOUR, blocked })
    for (const id of blocked) expect(list.map((item) => item.song.id)).not.toContain(id)
  })

  it('keeps pinned entries at their position', () => {
    const pinned = ctx.songs.get('ABBA - Waterloo')!
    const keep: SetlistEntry[] = [
      entry(ctx.songs.get(CLOSER)!, { pinned: true }),
      entry(pinned, { pinned: true }),
    ]
    const list = generate(ctx, { targetSeconds: 2 * HOUR, keep })
    expect(list[0]!.song.id).toBe(CLOSER)
    expect(list[1]!.song.id).toBe('ABBA - Waterloo')
    expect(list.filter((item) => item.pinned)).toHaveLength(2)
  })

  it('rolls different lists but keeps the same rules', () => {
    let random = 1
    const next = () => {
      random = (random * 1103515245 + 12345) % 2147483648
      return random / 2147483648
    }
    const base = generate(ctx, { targetSeconds: 2 * HOUR }).map((item) => item.song.id)
    const rolls = [0, 1, 2].map(() => generate(ctx, { targetSeconds: 2 * HOUR, random: next }))
    for (const roll of rolls) {
      const ids = roll.map((item) => item.song.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(Math.abs(totalSeconds(roll, 30) - 2 * HOUR)).toBeLessThanOrEqual(
        TARGET_TOLERANCE_SECONDS,
      )
      for (let i = 1; i < roll.length; i++) {
        expect(artistName(roll[i]!.song)).not.toBe(artistName(roll[i - 1]!.song))
      }
    }
    // at least one roll differs from the deterministic list
    expect(rolls.some((roll) => roll.map((item) => item.song.id).join('|') !== base.join('|'))).toBe(
      true,
    )
  })

  it('counts songs without a duration with the fallback', () => {
    const noDuration = data.songs.find((song) => song.duration === null)!
    expect(duration(noDuration)).toBe(225)
    const list = [entry(noDuration)]
    expect(songSeconds(list)).toBe(225)
    expect(totalSeconds(list, 30)).toBe(255)
  })
})

describe('kick and fill', () => {
  const list = generate(ctx, { targetSeconds: 2 * HOUR, bufferSeconds: 30 })

  it('fills the gap with a different song and keeps the length', () => {
    const index = 5
    const kicked = list[index]!.song.id
    const next = replaceAt(ctx, list, index, { blocked: [kicked] })
    expect(next).toHaveLength(list.length)
    expect(next[index]!.song.id).not.toBe(kicked)
    expect(next[index]!.filled).toBe(true)
    const ids = next.map((item) => item.song.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('respects the neighbours of exactly that slot', () => {
    const index = 5
    const next = replaceAt(ctx, list, index, { blocked: [list[index]!.song.id] })
    expect(artistName(next[index]!.song)).not.toBe(artistName(next[index - 1]!.song))
    expect(artistName(next[index]!.song)).not.toBe(artistName(next[index + 1]!.song))
  })

  it('offers five alternatives with a share, the first one being what moves up', () => {
    const index = 8
    const options = alternatives(ctx, list, index, { blocked: [list[index]!.song.id] })
    expect(options).toHaveLength(5)
    expect(options.reduce((sum, option) => sum + option.share, 0)).toBeCloseTo(1, 10)
    const next = replaceAt(ctx, list, index, { blocked: [list[index]!.song.id] })
    expect(next[index]!.song.id).toBe(options[0]!.song.id)
    // alternatives are never songs that are already in the list
    const others = new Set(list.filter((_, i) => i !== index).map((item) => item.song.id))
    for (const option of options) expect(others.has(option.song.id)).toBe(false)
  })

  it('takes a chosen alternative instead of the top pick', () => {
    const index = 8
    const options = alternatives(ctx, list, index, { blocked: [list[index]!.song.id] })
    const next = replaceAt(ctx, list, index, { replacement: options[2]!.song })
    expect(next[index]!.song.id).toBe(options[2]!.song.id)
  })

  it('moves the next real closer up when the closer is kicked', () => {
    const short = [
      entry(ctx.songs.get(OPENER)!),
      entry(ctx.songs.get(MIDDLE)!),
      entry(ctx.songs.get(CLOSER)!),
    ]
    const next = replaceAt(ctx, short, 2, { blocked: [CLOSER] })
    // a song the band really ends on, not some mid-set song
    expect(ctx.stats.meanR.get(next[2]!.song.id)!).toBeGreaterThan(0.8)
  })

  it('ranks the band closers at r = 1 by how late they actually play', () => {
    const top = rankCandidates(ctx, { r: 1, limit: 3 }).map((candidate) => candidate.song.id)
    expect(top[0]).toBe(CLOSER)
    for (const id of top) expect(ctx.stats.meanR.get(id)!).toBeGreaterThan(0.8)
  })

  it('tells the closer apart from the song before it', () => {
    // "Highway to Hell" is almost always second to last, "Angels" the closer.
    // A kernel that is wide at the edge would mix the two up.
    const last = 'ACDC - Highway to Hell'
    const closerSlot = rankCandidates(ctx, { r: 1, exclude: [CLOSER] })
    const beforeSlot = rankCandidates(ctx, { r: 27 / 28, exclude: [CLOSER] })
    const rank = (ranked: typeof closerSlot, id: string) =>
      ranked.findIndex((candidate) => candidate.song.id === id)
    expect(rank(beforeSlot, last)).toBeLessThan(rank(closerSlot, last))
    expect(beforeSlot[0]!.song.id).toBe(last)
  })

  it('shortens the list when nothing fits any more', () => {
    const blocked = data.songs.map((song) => song.id)
    const next = replaceAt(ctx, list, 3, { blocked })
    expect(next).toHaveLength(list.length - 1)
  })
})
