/**
 * Token search over the song pool. Hand-written on purpose — all it has to do
 * is find a song from a few typed letters, in whatever order.
 *
 * Every token has to match somewhere in "artist title". A token that starts a
 * word scores higher than one found in the middle, the title counts more than
 * the artist, and the play count breaks ties, so the song the band plays most
 * comes first when two match equally well.
 */

import { artistName, foldText, type Song } from '../data'

const START_OF_WORD = 3
const INSIDE_WORD = 1
const TITLE_FACTOR = 2

/** Splits a query into folded tokens. */
export function tokenize(query: string): string[] {
  return foldText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0)
}

/** Score of one token against one field, 0 when it does not occur. */
function tokenScore(haystack: string, token: string): number {
  const at = haystack.indexOf(token)
  if (at < 0) return 0
  const startsWord = at === 0 || !/[\p{L}\p{N}]/u.test(haystack[at - 1]!)
  return startsWord ? START_OF_WORD : INSIDE_WORD
}

export interface SearchHit {
  song: Song
  score: number
}

/**
 * Pool songs matching `query`, best first. An empty query returns the most
 * played songs, so the insert sheet is never empty.
 */
export function searchSongs(songs: Song[], query: string, limit = 12): SearchHit[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) {
    return [...songs]
      .sort((a, b) => b.plays - a.plays || a.id.localeCompare(b.id, 'de'))
      .slice(0, limit)
      .map((song) => ({ song, score: 0 }))
  }

  const hits: SearchHit[] = []
  for (const song of songs) {
    const title = foldText(song.title)
    const artist = foldText(artistName(song))
    let score = 0
    let matchedAll = true
    for (const token of tokens) {
      const inTitle = tokenScore(title, token) * TITLE_FACTOR
      const inArtist = tokenScore(artist, token)
      const best = Math.max(inTitle, inArtist)
      if (best === 0) {
        matchedAll = false
        break
      }
      score += best
    }
    if (matchedAll) hits.push({ song, score })
  }

  return hits
    .sort((a, b) => b.score - a.score || b.song.plays - a.song.plays || a.song.id.localeCompare(b.song.id, 'de'))
    .slice(0, limit)
}
