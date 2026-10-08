import { describe, expect, it } from 'vitest'
import {
  afterShare,
  ageInMonths,
  beforeShare,
  buildStats,
  gigWeight,
  relativePosition,
} from '../src/stats'
import { foldText } from '../src/data'
import { data, tinyData } from './fixtures'

describe('weighting', () => {
  it('weights a gig from today with 1', () => {
    expect(gigWeight({ id: '1', date: '2026-01-01', songs: [] }, '2026-01-01', 12)).toBeCloseTo(1, 10)
  })

  it('halves the weight after one half-life', () => {
    expect(gigWeight({ id: '1', date: '2025-01-01', songs: [] }, '2026-01-01', 12)).toBeCloseTo(0.5, 2)
    expect(gigWeight({ id: '1', date: '2025-01-01', songs: [] }, '2026-01-01', 6)).toBeCloseTo(0.25, 2)
  })

  it('never ages a future gig', () => {
    expect(ageInMonths('2027-01-01', '2026-01-01')).toBe(0)
    expect(gigWeight({ id: '1', date: '2027-01-01', songs: [] }, '2026-01-01', 12)).toBe(1)
  })

  it('maps slot indices to 0 … 1', () => {
    expect(relativePosition(0, 4)).toBe(0)
    expect(relativePosition(3, 4)).toBe(1)
    expect(relativePosition(1, 4)).toBeCloseTo(1 / 3, 10)
    expect(relativePosition(0, 1)).toBe(0.5)
  })
})

describe('buildStats on the small history', () => {
  const stats = buildStats(tinyData(), { halfLifeMonths: 12, now: '2026-01-01' })
  // Weights of the three gigs: today, ~6 months ago, ~12 months ago.
  const [w3, w2, w1] = tinyData()
    .gigs.map((gig) => gigWeight(gig, '2026-01-01', 12))
    .reverse() as [number, number, number]

  it('only lists songs that were actually played', () => {
    expect(stats.played).not.toContain('F - Unplayed')
    expect(stats.played).toContain('C - Alt')
    expect(stats.pop.get('F - Unplayed')).toBeUndefined()
  })

  it('sums the decayed weights into pop', () => {
    // three gigs: today (1), six months ago (~0.707), twelve months ago (~0.5)
    expect(w3).toBeCloseTo(1, 10)
    expect(w2).toBeCloseTo(0.5 ** 0.5, 2)
    expect(w1).toBeCloseTo(0.5, 2)
    expect(stats.pop.get('A - Opener')).toBeCloseTo(w1 + w2 + w3, 10)
    expect(stats.pop.get('C - Third')).toBeCloseTo(w1 + w2, 10)
  })

  it('records every occurrence with its position', () => {
    expect(stats.occurrences.get('A - Opener')!.map((o) => o.r)).toEqual([0, 0, 0])
    expect(stats.meanR.get('A - Opener')).toBeCloseTo(0, 10)
    expect(stats.meanR.get('D - Closer')).toBeCloseTo(1, 10)
    expect(stats.meanR.get('B - Second')).toBeCloseTo(1 / 3, 10)
  })

  it('counts neighbours in both directions', () => {
    // B follows A in all three gigs, so its share is 1
    expect(afterShare(stats, 'A - Opener', 'B - Second')).toBeCloseTo(1, 10)
    // after B: C - Third twice (older gigs), C - Alt once (newest gig)
    expect(afterShare(stats, 'B - Second', 'C - Third')).toBeCloseTo(
      (w1 + w2) / (w1 + w2 + w3),
      10,
    )
    expect(afterShare(stats, 'B - Second', 'C - Alt')).toBeCloseTo(w3 / (w1 + w2 + w3), 10)
    // before D: C - Third twice, C - Alt once
    expect(beforeShare(stats, 'D - Closer', 'C - Alt')).toBeCloseTo(w3 / (w1 + w2 + w3), 10)
    expect(afterShare(stats, null, 'B - Second')).toBe(0)
    expect(beforeShare(stats, 'A - Opener', 'B - Second')).toBe(0)
  })

  it('reacts to the half-life slider', () => {
    const short = buildStats(tinyData(), { halfLifeMonths: 3, now: '2026-01-01' })
    const long = buildStats(tinyData(), { halfLifeMonths: 36, now: '2026-01-01' })
    // C - Alt only played in the newest gig, C - Third only in the older ones
    const ratio = (s: typeof stats) => s.pop.get('C - Alt')! / s.pop.get('C - Third')!
    expect(ratio(short)).toBeGreaterThan(ratio(long))
  })
})

describe('foldText', () => {
  it('matches a typed NFC string against an NFD id', () => {
    const arzte = data.songs.find((song) => foldText(song.artist ?? '') === 'die arzte')
    expect(arzte).toBeDefined()
    expect(foldText('Die Ärzte')).toBe('die arzte')
    expect(foldText('  ROSÉ  ')).toBe('rose')
    expect(foldText('Ärzte'.normalize('NFD'))).toBe(foldText('Ärzte'.normalize('NFC')))
  })
})

describe('buildStats on the real history', () => {
  const stats = buildStats(data, { halfLifeMonths: 12 })

  it('covers the whole pool minus the never-played songs', () => {
    expect(data.songs).toHaveLength(112)
    expect(data.gigs).toHaveLength(63)
    expect(stats.played).toHaveLength(105)
  })

  it('every id in a gig exists in the pool', () => {
    const pool = new Set(data.songs.map((song) => song.id))
    for (const gig of data.gigs) for (const id of gig.songs) expect(pool.has(id)).toBe(true)
  })

  it('puts the usual opener at the front and the usual closer at the end', () => {
    expect(stats.meanR.get("Jason Mraz - I'm Yours")!).toBeLessThan(0.25)
    expect(stats.meanR.get('Robbie Williams - Angels')!).toBeGreaterThan(0.8)
    expect(stats.meanR.get('Avicii - Wake me up')!).toBeGreaterThan(0.4)
    expect(stats.meanR.get('Avicii - Wake me up')!).toBeLessThan(0.8)
  })

  it('has an artist for every song', () => {
    expect(data.songs.filter((song) => song.artist === null)).toEqual([])
  })

  it('keeps the ids byte-identical to the forScore file names (NFD)', () => {
    // The .4ss export names the file, so ids must never be re-normalised.
    for (const song of data.songs) {
      expect(song.id.normalize('NFD')).toBe(song.id)
      expect(song.file).toBe(`${song.id}.pdf`)
    }
    const accented = data.songs.filter((song) => song.id.normalize('NFC') !== song.id)
    expect(accented.length).toBeGreaterThan(0)
  })

  it('defaults the reference date to data.generated', () => {
    expect(stats.now.toISOString().slice(0, 10)).toBe(data.generated)
  })
})
