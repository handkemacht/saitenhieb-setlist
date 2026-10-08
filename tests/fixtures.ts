import raw from '../public/data.json'
import type { SetlistData } from '../src/data'

/** The real history, exactly as the browser loads it. */
export const data = raw as SetlistData

export const OPENER = "Jason Mraz - I'm Yours"
export const CLOSER = 'Robbie Williams - Angels'
export const MIDDLE = 'Avicii - Wake me up'

/** Small hand-made history for the pure unit tests. */
export function tinyData(): SetlistData {
  const song = (id: string, artist: string, seconds: number | null, plays: number) => ({
    id,
    file: `${id}.pdf`,
    title: id.split(' - ')[1] ?? id,
    artist,
    duration: seconds,
    plays,
  })
  return {
    generated: '2026-01-01',
    source: 'test',
    songs: [
      song('A - Opener', 'A', 200, 3),
      song('B - Second', 'B', 200, 3),
      song('C - Third', 'C', 200, 3),
      song('D - Closer', 'D', 200, 3),
      song('C - Alt', 'C', 200, 1),
      song('F - Unplayed', 'F', null, 0),
    ],
    gigs: [
      { id: '001', date: '2025-01-01', songs: ['A - Opener', 'B - Second', 'C - Third', 'D - Closer'] },
      { id: '002', date: '2025-07-01', songs: ['A - Opener', 'B - Second', 'C - Third', 'D - Closer'] },
      { id: '003', date: '2026-01-01', songs: ['A - Opener', 'B - Second', 'C - Alt', 'D - Closer'] },
    ],
  }
}
