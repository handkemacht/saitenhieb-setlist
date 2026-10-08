/**
 * Prints generated setlists for eyeballing — not part of the test suite.
 *   npm run demo
 */
import { readFileSync } from 'node:fs'
import { artistName, formatDuration, type SetlistData } from '../src/data'
import {
  alternatives,
  createContext,
  generate,
  replaceAt,
  songSeconds,
  totalSeconds,
} from '../src/scorer'

const data = JSON.parse(
  readFileSync(new URL('../public/data.json', import.meta.url), 'utf8'),
) as SetlistData

const ctx = createContext(data, { halfLifeMonths: 12 })
const BUFFER = 30

const show = (list: ReturnType<typeof generate>, label: string) => {
  const pure = songSeconds(list)
  const withBuffer = totalSeconds(list, BUFFER)
  console.log(`\n### ${label} — ${list.length} Songs, ${Math.round(pure / 60)} min (+Puffer ${Math.round(withBuffer / 60)} min)`)
  console.log(
    list
      .map((e, i) => {
        const played = ctx.stats.pop.get(e.song.id) !== undefined ? `${e.song.plays}x` : '—'
        return `${String(i + 1).padStart(2, '0')}. ${(artistName(e.song) + ' – ' + e.song.title).padEnd(52)}${formatDuration(e.song.duration ?? 225).padStart(5)}  ${played}`
      })
      .join('\n'),
  )
}

for (const hours of [1, 2, 3]) {
  show(generate(ctx, { targetSeconds: hours * 3600, bufferSeconds: BUFFER }), `${hours} h`)
}

// Half-life effect
for (const halfLifeMonths of [3, 36]) {
  const c = createContext(data, { halfLifeMonths })
  const list = generate(c, { targetSeconds: 2 * 3600, bufferSeconds: BUFFER })
  console.log(`\n### Halbwertszeit ${halfLifeMonths} Monate, 2 h — erste 8:`)
  console.log(list.slice(0, 8).map((e, i) => `${i + 1}. ${e.song.title}`).join(', '))
}

// Kick + alternatives
const list = generate(ctx, { targetSeconds: 2 * 3600, bufferSeconds: BUFFER })
const index = 6
console.log(`\n### Slot ${index + 1} rausgekickt: "${list[index]!.song.title}"`)
console.log(`    Nachbarn: ${list[index - 1]!.song.title} / ${list[index + 1]!.song.title}`)
for (const option of alternatives(ctx, list, index, { blocked: [list[index]!.song.id] })) {
  console.log(`    ${(option.share * 100).toFixed(0).padStart(3)}%  ${artistName(option.song)} – ${option.song.title}`)
}
const after = replaceAt(ctx, list, index, { blocked: [list[index]!.song.id] })
console.log(`    nachgerückt: ${after[index]!.song.title} (Liste bleibt ${after.length} Songs)`)

// Reroll variance
let seed = 7
const rng = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
console.log('\n### Neu würfeln, 2 h — Abweichung zur deterministischen Liste:')
const base = new Set(list.map((e) => e.song.id))
for (let i = 0; i < 3; i++) {
  const roll = generate(ctx, { targetSeconds: 2 * 3600, bufferSeconds: BUFFER, random: rng })
  const same = roll.filter((e) => base.has(e.song.id)).length
  console.log(
    `    Wurf ${i + 1}: ${roll.length} Songs, ${roll.length - same} neu, ${Math.round(totalSeconds(roll, BUFFER) / 60)} min · ${roll[0]!.song.title} … ${roll[roll.length - 1]!.song.title}`,
  )
}
