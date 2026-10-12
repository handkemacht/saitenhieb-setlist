/**
 * Types and loading for public/data.json (written by scripts/parse_forscore.py).
 * Gigs carry date and song order only — never names.
 */

export interface Song {
  /** forScore file name without .pdf — stable identifier. */
  id: string
  /** forScore file name, used by the .4ss export. Empty for free-text songs. */
  file: string
  title: string
  /** null when the forScore title carries no separator. */
  artist: string | null
  /** Seconds, or null when the duration is not maintained in forScore. */
  duration: number | null
  /** Unweighted play count, for display only. */
  plays: number
  /**
   * False for songs the band has retired ("NOCH AKTIV?" = 0 in the sheet).
   * Retired songs stay searchable but are never drawn. Undefined counts as true.
   */
  active?: boolean
  /**
   * Member id -> what that member does on this song ("GV(B)"), from the band's
   * sheet. null when the sheet has no row for the song, undefined in test data.
   * See roster.ts for the codes.
   */
  roles?: Record<string, string> | null
}

/** One band member who can be at a gig. Mario plays cajon and is not listed. */
export interface Member {
  id: string
  name: string
}

export interface Gig {
  id: string
  /** ISO date, YYYY-MM-DD. */
  date: string
  /** Song ids in playing order. */
  songs: string[]
}

export interface SetlistData {
  generated: string
  source: string
  /** File name of the roster export the song data was merged with. */
  roster?: string
  /** Selectable members, in sheet order. Empty in test data. */
  members?: Member[]
  songs: Song[]
  gigs: Gig[]
}

/** Songs without a maintained duration are counted with this value. */
export const FALLBACK_DURATION = 225

/** Default duration offered for a free-text song (3:45). */
export const CUSTOM_SONG_DURATION = 225

/**
 * Lower-cased, accent-free form for comparing text the user typed against the
 * data. Song ids come straight from macOS file names and are therefore NFD
 * ("Die A\u0308rzte"), while an iPhone keyboard produces NFC ("Die Ärzte") —
 * without folding, a search for "Ärzte" would find nothing. Ids themselves are
 * never normalised: the .4ss export has to name the file exactly.
 */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
}

/** Artist, or an empty string when forScore has none. */
export function artistName(song: Song): string {
  return song.artist ?? ''
}

export function duration(song: Song): number {
  return song.duration ?? FALLBACK_DURATION
}

export function hasDuration(song: Song): boolean {
  return song.duration !== null
}

/** "3:42" — also used by the text export. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

/** Builds an id -> song lookup. */
export function indexSongs(songs: Song[]): Map<string, Song> {
  return new Map(songs.map((song) => [song.id, song]))
}

/** Members of the band, or an empty list when the data carries none. */
export function members(data: SetlistData): Member[] {
  return data.members ?? []
}

/** Creates a song object for a free-text entry that is not in the pool. */
export function customSong(
  title: string,
  artist: string | null = null,
  seconds = CUSTOM_SONG_DURATION,
): Song {
  return {
    id: `t:${title}|${artist ?? ''}|${seconds}`,
    file: '',
    title,
    artist,
    duration: seconds,
    plays: 0,
    // A free-text song carries no sheet row, so no lineup rule applies to it.
    roles: null,
  }
}

export function isCustomSongId(id: string): boolean {
  return id.startsWith('t:')
}

export async function loadData(url = 'data.json'): Promise<SetlistData> {
  const response = await fetch(url, { cache: 'no-cache' })
  if (!response.ok) throw new Error(`data.json konnte nicht geladen werden (${response.status})`)
  return (await response.json()) as SetlistData
}
