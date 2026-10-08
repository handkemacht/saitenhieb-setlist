/**
 * Weighted statistics derived from the gig history. Pure functions, no DOM.
 *
 * Everything here depends on the half-life slider, so nothing is precomputed
 * in data.json — the tables are rebuilt whenever the slider moves.
 */

import type { Gig, SetlistData } from './data'

/** Average length of a month, used to turn a day difference into months. */
const DAYS_PER_MONTH = 30.436875

export const DEFAULT_HALF_LIFE_MONTHS = 12
export const MIN_HALF_LIFE_MONTHS = 3
export const MAX_HALF_LIFE_MONTHS = 36

/** One appearance of a song in a gig. */
export interface Occurrence {
  /** Weight of the gig it appeared in. */
  w: number
  /** Relative position in that gig, 0 = opener, 1 = closer. */
  r: number
}

export interface Stats {
  /** Reference date the weights were computed against. */
  now: Date
  halfLifeMonths: number
  /** Ids of all songs that appear in at least one gig. */
  played: string[]
  /** Weighted popularity: sum of gig weights over all occurrences. */
  pop: Map<string, number>
  occurrences: Map<string, Occurrence[]>
  /** Weighted mean of all occurrence positions, for the density-gap heuristic. */
  meanR: Map<string, number>
  /** after.get(prev).get(s) — weighted count of "s directly followed prev". */
  after: Map<string, Map<string, number>>
  /** Row sums of `after`. */
  afterTotal: Map<string, number>
  /** before.get(next).get(s) — weighted count of "s directly preceded next". */
  before: Map<string, Map<string, number>>
  /** Row sums of `before`. */
  beforeTotal: Map<string, number>
}

export interface StatsOptions {
  halfLifeMonths?: number
  /** Reference "today"; defaults to data.generated. */
  now?: Date | string
}

export function parseDate(value: Date | string): Date {
  if (value instanceof Date) return value
  const date = new Date(`${value}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) throw new Error(`Ungültiges Datum: ${value}`)
  return date
}

/** Age of a gig in (fractional) months, never negative. */
export function ageInMonths(gigDate: Date | string, now: Date | string): number {
  const days = (parseDate(now).getTime() - parseDate(gigDate).getTime()) / 86_400_000
  return Math.max(0, days / DAYS_PER_MONTH)
}

/** Decaying gig weight: 0.5 ** (age / half-life). */
export function gigWeight(gig: Gig, now: Date | string, halfLifeMonths: number): number {
  return 0.5 ** (ageInMonths(gig.date, now) / halfLifeMonths)
}

/** Relative position of slot `i` in a list of `n` songs. */
export function relativePosition(i: number, n: number): number {
  if (n <= 1) return 0.5
  return i / (n - 1)
}

function bump(table: Map<string, Map<string, number>>, key: string, id: string, w: number): void {
  let row = table.get(key)
  if (!row) {
    row = new Map()
    table.set(key, row)
  }
  row.set(id, (row.get(id) ?? 0) + w)
}

function add(totals: Map<string, number>, key: string, w: number): void {
  totals.set(key, (totals.get(key) ?? 0) + w)
}

/** Builds all weighted tables from the gig history. */
export function buildStats(data: SetlistData, options: StatsOptions = {}): Stats {
  const halfLifeMonths = options.halfLifeMonths ?? DEFAULT_HALF_LIFE_MONTHS
  const now = parseDate(options.now ?? data.generated)

  const pop = new Map<string, number>()
  const occurrences = new Map<string, Occurrence[]>()
  const after = new Map<string, Map<string, number>>()
  const afterTotal = new Map<string, number>()
  const before = new Map<string, Map<string, number>>()
  const beforeTotal = new Map<string, number>()

  for (const gig of data.gigs) {
    const w = gigWeight(gig, now, halfLifeMonths)
    const songs = gig.songs
    for (let i = 0; i < songs.length; i++) {
      const id = songs[i]!
      const r = relativePosition(i, songs.length)
      add(pop, id, w)
      const list = occurrences.get(id)
      if (list) list.push({ w, r })
      else occurrences.set(id, [{ w, r }])

      const prev = i > 0 ? songs[i - 1]! : undefined
      if (prev !== undefined) {
        bump(after, prev, id, w)
        add(afterTotal, prev, w)
      }
      const next = i + 1 < songs.length ? songs[i + 1]! : undefined
      if (next !== undefined) {
        bump(before, next, id, w)
        add(beforeTotal, next, w)
      }
    }
  }

  const meanR = new Map<string, number>()
  for (const [id, list] of occurrences) {
    let weight = 0
    let sum = 0
    for (const occurrence of list) {
      weight += occurrence.w
      sum += occurrence.w * occurrence.r
    }
    meanR.set(id, weight > 0 ? sum / weight : 0.5)
  }

  return {
    now,
    halfLifeMonths,
    played: [...occurrences.keys()],
    pop,
    occurrences,
    meanR,
    after,
    afterTotal,
    before,
    beforeTotal,
  }
}

/** Share of `song` among all songs that directly followed `prev`. */
export function afterShare(stats: Stats, prev: string | null | undefined, song: string): number {
  if (!prev) return 0
  const total = stats.afterTotal.get(prev) ?? 0
  if (total <= 0) return 0
  return (stats.after.get(prev)?.get(song) ?? 0) / total
}

/** Share of `song` among all songs that directly preceded `next`. */
export function beforeShare(stats: Stats, next: string | null | undefined, song: string): number {
  if (!next) return 0
  const total = stats.beforeTotal.get(next) ?? 0
  if (total <= 0) return 0
  return (stats.before.get(next)?.get(song) ?? 0) / total
}
