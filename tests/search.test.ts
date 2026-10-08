import { describe, expect, it } from 'vitest'
import { searchSongs, tokenize } from '../src/ui/search'
import { data } from './fixtures'

const find = (query: string, limit = 12): string[] =>
  searchSongs(data.songs, query, limit).map((hit) => hit.song.id)

describe('tokenize', () => {
  it('folds and splits on anything that is not a letter or digit', () => {
    expect(tokenize('  Die  Ärzte - Junge! ')).toEqual(['die', 'arzte', 'junge'])
    expect(tokenize('500 Miles')).toEqual(['500', 'miles'])
    expect(tokenize('   ')).toEqual([])
  })
})

describe('searchSongs', () => {
  it('finds a song by a piece of its title', () => {
    expect(find('wake')[0]).toBe('Avicii - Wake me up')
    expect(find('brightside')[0]).toBe('The Killers - Mr. Brightside')
  })

  it('finds a song by its artist', () => {
    expect(find('haddaway')[0]).toBe('Haddaway - What is love')
  })

  it('takes tokens in any order and across both fields', () => {
    const wanted = 'Avicii - Wake me up'
    expect(find('avicii wake')[0]).toBe(wanted)
    expect(find('wake avicii')[0]).toBe(wanted)
    expect(find('up avi')[0]).toBe(wanted)
  })

  it('matches a typed NFC umlaut against the NFD id', () => {
    const hits = find('Ärzte')
    expect(hits.length).toBeGreaterThan(0)
    for (const id of hits) expect(id.normalize('NFC')).toContain('Ärzte')
    expect(find('arzte')).toEqual(hits)
  })

  it('prefers the title over the artist and the played song over the rare one', () => {
    // "George" is an artist for both Ezra and Michael — the more played wins
    const george = find('george', 2)
    expect(george[0]).toBe('George Ezra - Blame it on Me')
  })

  it('returns nothing when one token does not match', () => {
    expect(find('wake me gurke')).toEqual([])
    expect(find('zzzzz')).toEqual([])
  })

  it('offers the most played songs for an empty query', () => {
    const top = searchSongs(data.songs, '', 3)
    expect(top).toHaveLength(3)
    const plays = top.map((hit) => hit.song.plays)
    expect(plays).toEqual([...plays].sort((a, b) => b - a))
    expect(plays[0]).toBeGreaterThan(50)
  })

  it('honours the limit', () => {
    expect(find('e', 5)).toHaveLength(5)
  })
})
