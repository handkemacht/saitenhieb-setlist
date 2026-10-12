/**
 * Who is at the gig decides which songs can be drawn.
 *
 * data/roster.csv (the band's "ZUM FILTERN" sheet) carries one code per member
 * and song in columns T–X:
 *
 *     G   guitar        V   vocals        B   bass
 *
 * Letters in brackets mean the member can step in but is not first choice:
 * "G(V)" plays guitar and sings if it has to be, "GV(B)" can also take over the
 * bass. An empty cell or "/" means the member does nothing on that song; the
 * parser in scripts/merge_roster.py drops those, so a missing key and an empty
 * code mean the same thing here. Mario plays cajon and is not in the sheet.
 *
 * A song is playable when the present members cover REQUIRED_ROLES — vocals and
 * guitar. Bass stays optional on purpose: songs like "Shape of my heart" never
 * had one, and a missing bass does not stop the band from playing a song.
 *
 * Two kinds of song are never filtered out:
 *   - songs with no sheet entry (`roles: null`) — no information, no verdict
 *   - every song when the lineup is empty — the filter is then simply off
 */

import type { Song } from './data'

export type Role = 'vocals' | 'guitar' | 'bass'

/** 0 = not at all, 1 = can step in (bracketed), 2 = regular. */
export type Level = 0 | 1 | 2

export type Ability = Record<Role, Level>

/** The roles a lineup has to cover for a song to be drawn. */
export const REQUIRED_ROLES: readonly Role[] = ['vocals', 'guitar']

export const ROLE_NAMES: Record<Role, string> = {
  vocals: 'Gesang',
  guitar: 'Gitarre',
  bass: 'Bass',
}

const NO_ABILITY: Ability = { vocals: 0, guitar: 0, bass: 0 }

const LETTERS: Record<string, Role> = { G: 'guitar', V: 'vocals', B: 'bass' }

/** "GV(B)" -> guitar 2, vocals 2, bass 1. Unknown characters are ignored. */
export function parseRoleCode(code: string | undefined | null): Ability {
  const ability: Ability = { ...NO_ABILITY }
  if (!code) return ability
  let depth = 0
  for (const char of code) {
    if (char === '(' || char === '[') depth++
    else if (char === ')' || char === ']') depth = Math.max(0, depth - 1)
    else {
      const role = LETTERS[char]
      // Only upper case counts: the sheet has stray notes like "GV yomaha".
      if (role) ability[role] = Math.max(ability[role], depth > 0 ? 1 : 2) as Level
    }
  }
  return ability
}

/** What `memberId` does on `song` — all zeroes when the sheet says nothing. */
export function abilityOf(song: Song, memberId: string): Ability {
  return parseRoleCode(song.roles?.[memberId])
}

/** True when the sheet has a row for this song. */
export function hasRoster(song: Song): boolean {
  return song.roles != null
}

/** False for songs the band has retired ("NOCH AKTIV?" = 0 in the sheet). */
export function isActive(song: Song): boolean {
  return song.active !== false
}

export interface Coverage {
  /** False when there is nothing to judge — no sheet row, or an empty lineup. */
  known: boolean
  /** Best level reached for every role, across the present members. */
  levels: Ability
  /** Required roles nobody present covers at all. */
  missing: Role[]
  /** Required roles only a stand-in covers. */
  shaky: Role[]
  playable: boolean
}

const UNKNOWN: Coverage = {
  known: false,
  levels: { ...NO_ABILITY },
  missing: [],
  shaky: [],
  playable: true,
}

/** How well `lineup` (member ids) covers the roles `song` needs. */
export function coverage(song: Song, lineup: Iterable<string>): Coverage {
  const present = [...lineup]
  if (!hasRoster(song) || present.length === 0) return { ...UNKNOWN }

  const levels: Ability = { ...NO_ABILITY }
  for (const memberId of present) {
    const ability = abilityOf(song, memberId)
    for (const role of Object.keys(levels) as Role[]) {
      levels[role] = Math.max(levels[role], ability[role]) as Level
    }
  }

  const missing = REQUIRED_ROLES.filter((role) => levels[role] === 0)
  const shaky = REQUIRED_ROLES.filter((role) => levels[role] === 1)
  return { known: true, levels, missing, shaky, playable: missing.length === 0 }
}

/** Candidate test for the generator: in the repertoire and covered by the lineup. */
export function isEligible(song: Song, lineup: Iterable<string>): boolean {
  return isActive(song) && coverage(song, lineup).playable
}

/** "kein Gesang", "weder Gesang noch Gitarre" — null when nothing is missing. */
export function missingLabel(result: Coverage): string | null {
  const names = result.missing.map((role) => ROLE_NAMES[role])
  if (names.length === 0) return null
  if (names.length === 1) return `kein ${names[0]}`
  return `weder ${names.slice(0, -1).join(', ')} noch ${names[names.length - 1]}`
}

/** "Gesang nur als Einspringer" — null when every required role is solid. */
export function shakyLabel(result: Coverage): string | null {
  const names = result.shaky.map((role) => ROLE_NAMES[role])
  if (names.length === 0) return null
  return `${names.join(' und ')} nur als Einspringer`
}

/** Short per-member summary for the UI: "Dave G·V, Markus B". */
export function lineupSummary(song: Song, members: readonly { id: string; name: string }[]): string {
  const parts: string[] = []
  for (const member of members) {
    const code = song.roles?.[member.id]
    if (code) parts.push(`${member.name} ${code}`)
  }
  return parts.join(', ')
}
