import { describe, expect, it } from 'vitest'
import { members, type Song } from '../src/data'
import {
  abilityOf,
  coverage,
  isActive,
  isEligible,
  lineupSummary,
  missingLabel,
  parseRoleCode,
  shakyLabel,
} from '../src/roster'
import { createContext, generate } from '../src/scorer'
import { data } from './fixtures'

const ALL = ['dave', 'martin', 'torsten', 'peter', 'markus']

function song(id: string): Song {
  // Ids come from macOS file names and are NFD ("Die A\u0308rzte").
  const wanted = id.normalize('NFD')
  const found = data.songs.find((item) => item.id.normalize('NFD') === wanted)
  if (!found) throw new Error(`${id} fehlt in public/data.json`)
  return found
}

function withRoles(roles: Record<string, string> | null): Song {
  return { id: 'x', file: '', title: 'x', artist: null, duration: 200, plays: 0, roles }
}

describe('parseRoleCode', () => {
  it('reads the three letters', () => {
    expect(parseRoleCode('G')).toEqual({ guitar: 2, vocals: 0, bass: 0 })
    expect(parseRoleCode('V')).toEqual({ guitar: 0, vocals: 2, bass: 0 })
    expect(parseRoleCode('B')).toEqual({ guitar: 0, vocals: 2 - 2, bass: 2 })
    expect(parseRoleCode('GV')).toEqual({ guitar: 2, vocals: 2, bass: 0 })
  })

  it('treats brackets as "can step in"', () => {
    expect(parseRoleCode('G(V)')).toEqual({ guitar: 2, vocals: 1, bass: 0 })
    expect(parseRoleCode('GV(B)')).toEqual({ guitar: 2, vocals: 2, bass: 1 })
    expect(parseRoleCode('G(B)')).toEqual({ guitar: 2, vocals: 0, bass: 1 })
    expect(parseRoleCode('(V)')).toEqual({ guitar: 0, vocals: 1, bass: 0 })
  })

  it('ignores empty cells and stray notes', () => {
    expect(parseRoleCode('')).toEqual({ guitar: 0, vocals: 0, bass: 0 })
    expect(parseRoleCode(undefined)).toEqual({ guitar: 0, vocals: 0, bass: 0 })
    expect(parseRoleCode(null)).toEqual({ guitar: 0, vocals: 0, bass: 0 })
    // The sheet has one cell reading "GV yomaha" — lower case must not count.
    expect(parseRoleCode('GV yomaha')).toEqual({ guitar: 2, vocals: 2, bass: 0 })
  })

  it('reads the real sheet rows', () => {
    expect(abilityOf(song('ACDC - Highway to Hell'), 'torsten')).toEqual({
      guitar: 0,
      vocals: 2,
      bass: 0,
    })
    expect(abilityOf(song('ACDC - Highway to Hell'), 'dave')).toEqual({
      guitar: 2,
      vocals: 0,
      bass: 1,
    })
  })
})

describe('coverage', () => {
  it('needs vocals and a guitar, not a bass', () => {
    const result = coverage(withRoles({ dave: 'GV', markus: 'B' }), ['dave'])
    expect(result.playable).toBe(true)
    expect(result.levels.bass).toBe(0)
    expect(missingLabel(result)).toBeNull()
  })

  it('rules a song out when nobody present can sing it', () => {
    const result = coverage(withRoles({ dave: 'G', torsten: 'V' }), ['dave'])
    expect(result.playable).toBe(false)
    expect(result.missing).toEqual(['vocals'])
    expect(missingLabel(result)).toBe('kein Gesang')
  })

  it('names both roles when a lone singer is left', () => {
    const result = coverage(withRoles({ dave: 'G', torsten: 'V' }), ['torsten'])
    expect(missingLabel(result)).toBe('kein Gitarre')
    expect(coverage(withRoles({ markus: 'B' }), ['markus']).missing).toEqual(['vocals', 'guitar'])
    expect(missingLabel(coverage(withRoles({ markus: 'B' }), ['markus']))).toBe(
      'weder Gesang noch Gitarre',
    )
  })

  it('accepts a stand-in but says so', () => {
    const result = coverage(withRoles({ martin: 'G(V)' }), ['martin'])
    expect(result.playable).toBe(true)
    expect(result.shaky).toEqual(['vocals'])
    expect(shakyLabel(result)).toBe('Gesang nur als Einspringer')
  })

  it('judges nothing without a sheet row or without a lineup', () => {
    expect(coverage(withRoles(null), ALL).known).toBe(false)
    expect(coverage(withRoles(null), ALL).playable).toBe(true)
    expect(coverage(withRoles({ torsten: 'V' }), []).known).toBe(false)
    expect(coverage(withRoles({ torsten: 'V' }), []).playable).toBe(true)
  })
})

describe('the real repertoire', () => {
  it('knows the five members from the sheet', () => {
    expect(members(data).map((member) => member.id)).toEqual(ALL)
  })

  it('can play every active song with the full lineup', () => {
    const stuck = data.songs.filter((item) => isActive(item) && !isEligible(item, ALL))
    expect(stuck).toEqual([])
  })

  it('drops the songs only Torsten sings when he is away', () => {
    const without = ALL.filter((id) => id !== 'torsten')
    expect(isEligible(song('ACDC - Highway to Hell'), without)).toBe(false)
    expect(missingLabel(coverage(song('ACDC - Highway to Hell'), without))).toBe('kein Gesang')
    // Not a blanket rule: Westerland has Torsten on vocals too, but Martin sings it as well.
    expect(isEligible(song('Die Ärzte - Westerland'), without)).toBe(true)
  })

  it('keeps a song when a guitarist with an entry is missing', () => {
    // Peter has "GV" on Angels, but Dave sings and Martin plays guitar.
    expect(song('Robbie Williams - Angels').roles).toHaveProperty('peter')
    expect(isEligible(song('Robbie Williams - Angels'), ['dave', 'martin', 'markus'])).toBe(true)
  })

  it('never filters a song the sheet does not list', () => {
    const blind = data.songs.filter((item) => item.roles === null)
    expect(blind.length).toBeGreaterThan(0)
    for (const item of blind) expect(isEligible(item, ['markus'])).toBe(true)
  })

  it('holds retired songs back from the pool but keeps them in the data', () => {
    const retired = data.songs.filter((item) => !isActive(item))
    expect(retired.length).toBeGreaterThan(0)
    for (const item of retired) expect(isEligible(item, ALL)).toBe(false)
    const ctx = createContext(data, { lineup: ALL })
    for (const item of retired) {
      expect(ctx.poolIds).not.toContain(item.id)
      expect(ctx.songs.has(item.id)).toBe(true)
    }
  })

  it('keeps retired songs searchable even without a forScore file', () => {
    // "Raus aus dem Pool" means the generator skips them, not that they vanish:
    // the band still wants to dig one out by hand now and then.
    const hotel = song('The Eagles - Hotel California')
    expect(isActive(hotel)).toBe(false)
    expect(hotel.file).toBe('')
    expect(createContext(data, { lineup: ALL }).poolIds).not.toContain(hotel.id)
  })

  it('shows what each member does on a song', () => {
    expect(lineupSummary(song('ACDC - Highway to Hell'), members(data))).toBe(
      'Dave G(B), Martin G, Torsten V, Peter G, Markus B',
    )
  })
})

describe('generating with a lineup', () => {
  it('only draws songs the lineup can cover', () => {
    const lineup = ['dave', 'martin', 'markus']
    const ctx = createContext(data, { lineup })
    const list = generate(ctx, { targetSeconds: 7200 })
    expect(list.length).toBeGreaterThan(10)
    for (const item of list) expect(isEligible(item.song, lineup)).toBe(true)
  })

  it('still generates for a lineup without the lead singers', () => {
    const ctx = createContext(data, { lineup: ['martin', 'markus'] })
    const list = generate(ctx, { targetSeconds: 3600 })
    expect(list.length).toBeGreaterThan(5)
    for (const item of list) expect(isEligible(item.song, ['martin', 'markus'])).toBe(true)
  })

  it('scores from the whole history, not only from the lineup pool', () => {
    // The weights come from every gig — a thinner lineup must not change them.
    const full = createContext(data, { lineup: ALL })
    const thin = createContext(data, { lineup: ['martin'] })
    expect(thin.stats.pop.get('ACDC - Highway to Hell')).toBe(
      full.stats.pop.get('ACDC - Highway to Hell'),
    )
    expect(thin.poolIds.length).toBeLessThan(full.poolIds.length)
  })
})
