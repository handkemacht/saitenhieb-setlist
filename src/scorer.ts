/**
 * One scorer for everything: generating a setlist, filling a gap after a kick
 * and listing alternatives all go through score().
 *
 * Tunable constants (see CLAUDE.md — free to nudge as long as the tests hold):
 *
 *   H_POS                  0.06  width of the position kernel in the middle of
 *                                the list — about two slots in a 28 song set.
 *   H_POS_EDGE             0.015 width at r = 0 and r = 1, about half a slot.
 *                                Opener and closer are an identity, not a
 *                                region: in r, slot 0 and slot 1 are only
 *                                1/(N-1) apart, so a wide kernel cannot tell
 *                                "always opens" from "always plays second".
 *                                With the narrow edge the history separates
 *                                cleanly — "I'm Yours" opens, "Blame it on Me"
 *                                plays second, "Highway to Hell" is second to
 *                                last and "Angels" closes. The width grows
 *                                towards H_POS with sin(pi * r).
 *   LAMBDA                 2     weight of the neighbour (transition) term.
 *   EPSILON_FACTOR         0.01  pos() floor as a fraction of pop(), so a song
 *                                that never played at this position is still a
 *                                candidate instead of a hard zero.
 *   SOFTMAX_TEMPERATURE    0.7   "Neu würfeln" randomness. Scores are divided by
 *                                the slot maximum first, so the temperature means
 *                                the same thing no matter how popular the slot is.
 *   SOFTMAX_CANDIDATES     5     how many top candidates the roll draws from.
 *   POPULAR_SAMPLE         40    songs averaged to estimate the list length.
 *   TARGET_TOLERANCE       120 s how far off the target we accept.
 *   MAX_ADJUST_ITERATIONS  5     add/remove passes after the first fill.
 */

import { artistName, duration, indexSongs, isCustomSongId, type SetlistData, type Song } from './data'
import {
  afterShare,
  beforeShare,
  buildStats,
  relativePosition,
  type Stats,
  type StatsOptions,
} from './stats'

export const H_POS = 0.06
export const H_POS_EDGE = 0.015
export const LAMBDA = 2
export const EPSILON_FACTOR = 0.01
export const SOFTMAX_TEMPERATURE = 0.7
export const SOFTMAX_CANDIDATES = 5
export const ALTERNATIVES = 5
export const POPULAR_SAMPLE = 40
export const TARGET_TOLERANCE_SECONDS = 120
export const MAX_ADJUST_ITERATIONS = 5

export const DEFAULT_BUFFER_SECONDS = 30
export const MIN_BUFFER_SECONDS = 0
export const MAX_BUFFER_SECONDS = 90

/** One line of the setlist. */
export interface SetlistEntry {
  song: Song
  /** Manually placed: never displaced by a roll or an auto-fill. */
  pinned: boolean
  /** Free-text song, carries no statistics. */
  custom: boolean
  /** Auto-filled after a kick — shown as "nachgerückt". */
  filled: boolean
}

/** The tunable weights; overridable so tests can pin them. */
export interface ScoreTuning {
  /** Width of the Gaussian position kernel in the middle of the list. */
  h: number
  /** Width at the very edges, where one slot is an identity, not a region. */
  hEdge: number
  /** Weight of the neighbour term. */
  lambda: number
  /** pos() floor as a fraction of pop(). */
  epsilon: number
}

export const DEFAULT_TUNING: ScoreTuning = {
  h: H_POS,
  hEdge: H_POS_EDGE,
  lambda: LAMBDA,
  epsilon: EPSILON_FACTOR,
}

export interface ScoreContext {
  data: SetlistData
  stats: Stats
  songs: Map<string, Song>
  /** Pool ids in data order, the candidate universe. */
  poolIds: string[]
  tuning: ScoreTuning
}

export interface Candidate {
  song: Song
  score: number
  /** Score as a fraction of the candidate list it was returned in. */
  share: number
}

export function createContext(
  data: SetlistData,
  options: StatsOptions & { tuning?: Partial<ScoreTuning> } = {},
): ScoreContext {
  return {
    data,
    stats: buildStats(data, options),
    songs: indexSongs(data.songs),
    poolIds: data.songs.map((song) => song.id),
    tuning: { ...DEFAULT_TUNING, ...options.tuning },
  }
}

export function entry(song: Song, flags: Partial<Omit<SetlistEntry, 'song'>> = {}): SetlistEntry {
  return { song, pinned: false, custom: false, filled: false, ...flags }
}

/** Gaussian kernel, unnormalised (a constant factor would only rescale ε). */
function kernel(u: number): number {
  return Math.exp(-0.5 * u * u)
}

/**
 * Kernel width at `r`. Opener and closer are an identity, not a region: at the
 * edges neighbouring slots are only ~1/N apart in r, so a wide kernel would mix
 * "always plays second" with "always opens". In the middle the exact slot
 * matters much less, so the kernel widens towards h.
 */
function width(r: number, tuning: ScoreTuning): number {
  return tuning.hEdge + (tuning.h - tuning.hEdge) * Math.sin(Math.PI * Math.min(1, Math.max(0, r)))
}

/** Weighted density of a song's past positions around `r`, with an ε floor. */
export function positionScore(
  stats: Stats,
  songId: string,
  r: number,
  tuning: ScoreTuning = DEFAULT_TUNING,
): number {
  const occurrences = stats.occurrences.get(songId)
  if (!occurrences) return 0
  const h = width(r, tuning)
  let density = 0
  for (const occurrence of occurrences) {
    density += occurrence.w * kernel((r - occurrence.r) / h)
  }
  return density + tuning.epsilon * (stats.pop.get(songId) ?? 0)
}

/** Neighbour bonus, 1 when neither neighbour is known. */
export function transitionScore(
  stats: Stats,
  songId: string,
  prev: string | null,
  next: string | null,
  tuning: ScoreTuning = DEFAULT_TUNING,
): number {
  return (
    1 + tuning.lambda * (afterShare(stats, prev, songId) + beforeShare(stats, next, songId))
  )
}

/**
 * Score of `songId` for a slot at relative position `r`, between `prev` and
 * `next` (ids, or null at the list edges / for free-text neighbours).
 */
export function score(
  ctx: ScoreContext,
  songId: string,
  r: number,
  prev: string | null = null,
  next: string | null = null,
): number {
  return (
    positionScore(ctx.stats, songId, r, ctx.tuning) *
    transitionScore(ctx.stats, songId, prev, next, ctx.tuning)
  )
}

/** Artist for the "no two in a row" rule; empty means "unknown, never blocks". */
function artistKey(song: Song | null | undefined): string {
  return song ? artistName(song).trim().toLowerCase() : ''
}

/** True when `needle` appears in `haystack` on word boundaries. */
function containsName(haystack: string, needle: string): boolean {
  const at = haystack.indexOf(needle)
  if (at < 0) return false
  const word = /[\p{L}\p{N}]/u
  const end = at + needle.length
  const openLeft = at === 0 || !word.test(haystack[at - 1]!)
  const openRight = end === haystack.length || !word.test(haystack[end]!)
  return openLeft && openRight
}

/**
 * Whether two artists count as the same for hard rule 2. One name containing
 * the other also counts, so "Rosé feat. Bruno Mars" does not land directly
 * next to "Bruno Mars".
 */
export function sameArtist(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  return containsName(a, b) || containsName(b, a)
}

/** Neighbour id for the scorer — free-text songs carry no statistics. */
function statsId(song: Song | null | undefined): string | null {
  if (!song || isCustomSongId(song.id)) return null
  return song.id
}

export interface RankOptions {
  r: number
  prevSong?: Song | null
  nextSong?: Song | null
  /** Ids already in the list — never offered twice (hard rule 1). */
  exclude?: Iterable<string>
  /** Kicked songs (hard rule 3). */
  blocked?: Iterable<string>
  limit?: number
}

/**
 * All eligible candidates for a slot, best first. Candidates with the same
 * artist as a direct neighbour are held back and only used when no other
 * candidate scores above zero (hard rule 2).
 */
export function rankCandidates(ctx: ScoreContext, options: RankOptions): Candidate[] {
  const exclude = new Set(options.exclude ?? [])
  const blocked = new Set(options.blocked ?? [])
  const prev = statsId(options.prevSong)
  const next = statsId(options.nextSong)
  const prevArtist = artistKey(options.prevSong)
  const nextArtist = artistKey(options.nextSong)

  const allowed: Candidate[] = []
  const artistClash: Candidate[] = []

  for (const id of ctx.poolIds) {
    if (exclude.has(id) || blocked.has(id)) continue
    const song = ctx.songs.get(id)
    if (!song) continue
    const value = score(ctx, id, options.r, prev, next)
    if (value <= 0) continue
    const candidate: Candidate = { song, score: value, share: 0 }
    const key = artistKey(song)
    if (sameArtist(key, prevArtist) || sameArtist(key, nextArtist)) artistClash.push(candidate)
    else allowed.push(candidate)
  }

  const byScore = (a: Candidate, b: Candidate): number =>
    b.score - a.score || a.song.id.localeCompare(b.song.id)

  const result = allowed.length > 0 ? allowed.sort(byScore) : artistClash.sort(byScore)
  const limited = options.limit === undefined ? result : result.slice(0, options.limit)
  const sum = limited.reduce((total, candidate) => total + candidate.score, 0)
  if (sum > 0) for (const candidate of limited) candidate.share = candidate.score / sum
  return limited
}

/** Draws from the top candidates, softmax over scores normalised by the maximum. */
function softmaxPick(candidates: Candidate[], random: () => number): Candidate | undefined {
  const top = candidates.slice(0, SOFTMAX_CANDIDATES)
  if (top.length === 0) return undefined
  const max = top[0]!.score
  if (!(max > 0)) return top[0]
  const weights = top.map((candidate) => Math.exp(candidate.score / max / SOFTMAX_TEMPERATURE))
  const total = weights.reduce((a, b) => a + b, 0)
  let threshold = random() * total
  for (let i = 0; i < top.length; i++) {
    threshold -= weights[i]!
    if (threshold <= 0) return top[i]
  }
  return top[top.length - 1]
}

export function songSeconds(list: SetlistEntry[]): number {
  return list.reduce((total, item) => total + duration(item.song), 0)
}

export function totalSeconds(list: SetlistEntry[], bufferSeconds: number): number {
  return songSeconds(list) + bufferSeconds * list.length
}

/** Average duration of the most popular songs, the basis for the length estimate. */
export function popularAverageDuration(ctx: ScoreContext, sample = POPULAR_SAMPLE): number {
  const ranked = [...ctx.poolIds]
    .map((id) => ({ id, pop: ctx.stats.pop.get(id) ?? 0 }))
    .filter((item) => item.pop > 0)
    .sort((a, b) => b.pop - a.pop || a.id.localeCompare(b.id))
    .slice(0, sample)
  const songs = ranked.length > 0 ? ranked : ctx.poolIds.slice(0, sample).map((id) => ({ id }))
  const sum = songs.reduce((total, item) => {
    const song = ctx.songs.get(item.id)
    return total + (song ? duration(song) : 0)
  }, 0)
  return songs.length > 0 ? sum / songs.length : 240
}

/** N = round(target / (average duration + buffer)). */
export function estimateLength(
  ctx: ScoreContext,
  targetSeconds: number,
  bufferSeconds: number,
): number {
  const per = popularAverageDuration(ctx) + bufferSeconds
  return Math.max(1, Math.round(targetSeconds / per))
}

export interface GenerateOptions {
  targetSeconds: number
  bufferSeconds?: number
  /** Kicked songs, excluded from every automatic pick. */
  blocked?: Iterable<string>
  /** Omit for the deterministic argmax pick; pass Math.random for "Neu würfeln". */
  random?: (() => number) | null
  /** Pinned entries that keep their position. */
  keep?: SetlistEntry[]
}

/** Position a slot is scored for; the closer slot is forced to r = 1. */
function slotPosition(i: number, n: number): number {
  return i === n - 1 ? 1 : relativePosition(i, n)
}

/** Fills `n` slots left to right, keeping pinned entries where they are. */
function fillSlots(
  ctx: ScoreContext,
  n: number,
  keep: SetlistEntry[],
  blocked: Set<string>,
  random: (() => number) | null,
): SetlistEntry[] {
  const slots: Array<SetlistEntry | undefined> = new Array(n).fill(undefined)
  const used = new Set<string>()

  // Pinned entries first, so they are also known as `next` while filling.
  let cursor = 0
  for (const item of keep) {
    while (cursor < n && slots[cursor] !== undefined) cursor++
    if (cursor >= n) break
    slots[cursor] = item
    used.add(item.song.id)
    cursor++
  }

  const fill = (i: number): void => {
    if (slots[i] !== undefined) return
    const candidates = rankCandidates(ctx, {
      r: slotPosition(i, n),
      prevSong: slots[i - 1]?.song ?? null,
      nextSong: slots[i + 1]?.song ?? null,
      exclude: used,
      blocked,
      limit: random ? SOFTMAX_CANDIDATES : 1,
    })
    const pick = random ? softmaxPick(candidates, random) : candidates[0]
    if (!pick) return
    slots[i] = entry(pick.song)
    used.add(pick.song.id)
  }

  // Opener and closer first: otherwise a middle slot eats the band's closer,
  // whose position density peaks just short of r = 1 as well.
  fill(0)
  fill(n - 1)
  for (let i = 1; i < n - 1; i++) fill(i)

  return slots.filter((slot): slot is SetlistEntry => slot !== undefined)
}

/** Score of the entry at `index` for the slot it currently sits in. */
function scoreOfSlot(ctx: ScoreContext, list: SetlistEntry[], index: number): number {
  const item = list[index]
  if (!item || item.custom) return 0
  return score(
    ctx,
    item.song.id,
    slotPosition(index, list.length),
    statsId(list[index - 1]?.song),
    statsId(list[index + 1]?.song),
  )
}

/** Typical position of an entry, used to find the widest gap in the running order. */
function entryMeanR(ctx: ScoreContext, list: SetlistEntry[], index: number): number {
  const item = list[index]!
  return ctx.stats.meanR.get(item.song.id) ?? relativePosition(index, list.length)
}

/** Insertion point where two neighbouring songs are furthest apart position-wise. */
function widestGap(ctx: ScoreContext, list: SetlistEntry[]): number {
  if (list.length < 2) return list.length
  let best = 1
  let bestGap = -1
  for (let i = 1; i < list.length; i++) {
    const gap = Math.abs(entryMeanR(ctx, list, i) - entryMeanR(ctx, list, i - 1))
    if (gap > bestGap) {
      bestGap = gap
      best = i
    }
  }
  return best
}

/** Removes the weakest non-pinned entry from the middle of the list. */
function dropWeakest(ctx: ScoreContext, list: SetlistEntry[]): boolean {
  let worst = -1
  let worstScore = Infinity
  for (let i = 1; i < list.length - 1; i++) {
    if (list[i]!.pinned) continue
    const value = scoreOfSlot(ctx, list, i)
    if (value < worstScore) {
      worstScore = value
      worst = i
    }
  }
  if (worst < 0) return false
  list.splice(worst, 1)
  return true
}

/** Adds one more song at the widest position gap. */
function addAtGap(ctx: ScoreContext, list: SetlistEntry[], blocked: Set<string>): boolean {
  const index = widestGap(ctx, list)
  const prev = list[index - 1]
  const next = list[index]
  const left = prev ? entryMeanR(ctx, list, index - 1) : 0
  const right = next ? entryMeanR(ctx, list, index) : 1
  const candidates = rankCandidates(ctx, {
    r: (left + right) / 2,
    prevSong: prev?.song ?? null,
    nextSong: next?.song ?? null,
    exclude: list.map((item) => item.song.id),
    blocked,
    limit: 1,
  })
  const pick = candidates[0]
  if (!pick) return false
  list.splice(index, 0, entry(pick.song))
  return true
}

/**
 * Generates a setlist for `targetSeconds`: estimate the length, fill every slot
 * with the best candidate, then add or drop songs until the total is within
 * TARGET_TOLERANCE_SECONDS of the target.
 */
export function generate(ctx: ScoreContext, options: GenerateOptions): SetlistEntry[] {
  const bufferSeconds = options.bufferSeconds ?? DEFAULT_BUFFER_SECONDS
  const blocked = new Set(options.blocked ?? [])
  const keep = (options.keep ?? []).filter((item) => item.pinned)
  const n = Math.max(estimateLength(ctx, options.targetSeconds, bufferSeconds), keep.length)

  const list = fillSlots(ctx, n, keep, blocked, options.random ?? null)

  // Add or drop whole songs until the total fits. A drop followed by an add is
  // not a no-op: it swaps a weak long song for one that fits better, which is
  // often what actually lands the list inside the tolerance. So let the loop
  // run its five passes and keep the closest list it ever saw — with ~4 minute
  // songs and a +/- 2 minute window there are targets no song count can hit,
  // and ending on the worse side of the window would be the wrong answer.
  const offBy = (candidate: SetlistEntry[]): number =>
    Math.abs(totalSeconds(candidate, bufferSeconds) - options.targetSeconds)
  let best = [...list]
  let bestOff = offBy(list)

  for (let iteration = 0; iteration < MAX_ADJUST_ITERATIONS; iteration++) {
    if (bestOff <= TARGET_TOLERANCE_SECONDS) break
    const tooLong = totalSeconds(list, bufferSeconds) > options.targetSeconds
    const changed = tooLong ? dropWeakest(ctx, list) : addAtGap(ctx, list, blocked)
    if (!changed) break
    const off = offBy(list)
    if (off < bestOff) {
      best = [...list]
      bestOff = off
    }
  }

  return best
}

export interface SlotOptions {
  blocked?: Iterable<string>
  limit?: number
}

/** Top candidates for slot `index` of `list`, with their score share. */
export function alternatives(
  ctx: ScoreContext,
  list: SetlistEntry[],
  index: number,
  options: SlotOptions = {},
): Candidate[] {
  const exclude = list
    .map((item, i) => (i === index ? null : item.song.id))
    .filter((id): id is string => id !== null)
  return rankCandidates(ctx, {
    r: slotPosition(index, list.length),
    prevSong: list[index - 1]?.song ?? null,
    nextSong: list[index + 1]?.song ?? null,
    exclude,
    blocked: options.blocked,
    limit: options.limit ?? ALTERNATIVES,
  })
}

/**
 * Kicks the entry at `index` and moves the best candidate for exactly that slot
 * up into it. Returns a new list; when nothing fits, the list gets shorter.
 * `replacement` forces a specific song (picked from the alternatives).
 */
export function replaceAt(
  ctx: ScoreContext,
  list: SetlistEntry[],
  index: number,
  options: SlotOptions & { replacement?: Song } = {},
): SetlistEntry[] {
  if (index < 0 || index >= list.length) return [...list]
  const next = [...list]
  const pick = options.replacement ?? alternatives(ctx, list, index, { ...options, limit: 1 })[0]?.song
  if (!pick) {
    next.splice(index, 1)
    return next
  }
  next[index] = entry(pick, { filled: true })
  return next
}
