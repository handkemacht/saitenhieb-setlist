/**
 * Bootstrap, state and wiring. All decisions live in scorer.ts — this file only
 * keeps the current list, feeds the sliders into it and paints the result.
 */

import { artistName, loadData, members, type Song } from './data'
import {
  asForScore,
  asText,
  copyText,
  decodeShare,
  download,
  encodeShare,
  forScoreFileName,
  formatTarget,
  headline,
  print,
  today,
} from './export'
import {
  alternatives,
  createContext,
  DEFAULT_BUFFER_SECONDS,
  entry,
  generate,
  replaceAt,
  songSeconds,
  totalSeconds,
  type SetlistEntry,
} from './scorer'
import { asOnSongBinder, BINDER_MIME, onSongFileName } from './onsong'
import {
  coverage,
  isActive,
  isEligible,
  missingLabel,
  shakyLabel,
} from './roster'
import { DEFAULT_HALF_LIFE_MONTHS } from './stats'
import { enableDrag } from './ui/drag'
import { renderAppend, renderList, type RowHandlers } from './ui/render'
import { openSlotSheet } from './ui/sheet'

/** Playing time: the slider covers the usual gigs, the number field every case. */
const MIN_TARGET_MINUTES = 10
const MAX_TARGET_MINUTES = 420
const TARGET_NUDGE_MINUTES = 5
const DEFAULT_TARGET_MINUTES = 120

/** Colour bands for the clock: green within 2 minutes, yellow within 5. */
const CLOCK_OK_SECONDS = 120
const CLOCK_WARN_SECONDS = 300

interface State {
  targetSeconds: number
  bufferSeconds: number
  halfLifeMonths: number
  list: SetlistEntry[]
  blocked: Set<string>
  /** Member ids at the gig. Empty means "do not filter by lineup". */
  lineup: Set<string>
}

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Element #${id} fehlt`)
  return node as T
}

function toast(message: string): void {
  const node = $('toast')
  node.textContent = message
  node.classList.add('show')
  window.setTimeout(() => node.classList.remove('show'), 1800)
}

function minutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`
}

async function main(): Promise<void> {
  const data = await loadData(`${import.meta.env.BASE_URL}data.json`)

  const roster = members(data)
  /** Songs the band still plays — the ceiling the lineup filter cuts into. */
  const activeCount = data.songs.filter(isActive).length

  const state: State = {
    targetSeconds: DEFAULT_TARGET_MINUTES * 60,
    bufferSeconds: DEFAULT_BUFFER_SECONDS,
    halfLifeMonths: DEFAULT_HALF_LIFE_MONTHS,
    list: [],
    blocked: new Set(),
    // Everybody is there until someone is clicked away.
    lineup: new Set(roster.map((member) => member.id)),
  }

  /** The lineup in sheet order, for the share link and the export headline. */
  const lineupIds = (): string[] =>
    roster.filter((member) => state.lineup.has(member.id)).map((member) => member.id)
  const lineupNames = (): string[] =>
    roster.filter((member) => state.lineup.has(member.id)).map((member) => member.name)

  // Weights decay against today, not against the day the data was exported.
  const buildCtx = (): ReturnType<typeof createContext> =>
    createContext(data, {
      halfLifeMonths: state.halfLifeMonths,
      now: new Date(),
      lineup: state.lineup,
    })
  let ctx = buildCtx()
  const rebuildContext = (): void => {
    ctx = buildCtx()
  }

  /** Takes over a shared state; returns false when the hash carries none. */
  const applyShared = (hash: string): boolean => {
    const shared = decodeShare(hash, data)
    if (!shared) return false
    state.targetSeconds = shared.targetSeconds
    state.bufferSeconds = shared.bufferSeconds
    state.halfLifeMonths = shared.halfLifeMonths
    state.list = shared.list
    state.lineup = new Set(shared.lineup)
    rebuildContext()
    return true
  }

  applyShared(location.hash)

  // --- painting ------------------------------------------------------------


  const handlers: RowHandlers = {
    onKick: (index) => {
      const kicked = state.list[index]
      if (!kicked) return
      if (!kicked.custom) state.blocked.add(kicked.song.id)
      state.list = replaceAt(ctx, state.list, index, { blocked: state.blocked })
      paint()
      toast(`„${kicked.song.title}" rausgekickt`)
    },
    onPin: (index) => {
      const item = state.list[index]
      if (!item) return
      state.list = state.list.map((other, i) =>
        i === index ? { ...other, pinned: !other.pinned } : other,
      )
      paint()
    },
    onSlot: (index) => openSheet(index),
    onAppend: () => openSheet(state.list.length),
  }

  const listRoot = $<HTMLOListElement>('list')
  enableDrag(listRoot, {
    onReorder: (from, to) => {
      const moved = state.list[from]
      if (!moved) return
      const next = [...state.list]
      next.splice(from, 1)
      next.splice(to, 0, moved)
      state.list = next
      paint()
    },
  })

  function openSheet(index: number): void {
    const current = state.list[index]
    openSlotSheet({
      current: current?.song ?? null,
      position: index + 1,
      // The song sitting in the slot is not an alternative to itself.
      alternatives: current
        ? alternatives(ctx, state.list, index, {
            blocked: new Set([...state.blocked, current.song.id]),
          })
        : [],
      pool: data.songs,
      used: new Set(state.list.map((item) => item.song.id)),
      note: songNote,
      onPick: (action) => {
        const fresh = entry(action.song, { pinned: true, custom: action.custom ?? false })
        const next = [...state.list]
        if (action.kind === 'replace') next[index] = fresh
        else next.splice(index, 0, fresh)
        state.list = next
        paint()
      },
    })
  }

  /** "kein Gesang" / "ausgemustert" — what holds a song back, or null. */
  function songNote(song: Song): string | null {
    if (!isActive(song)) return 'ausgemustert'
    const result = coverage(song, state.lineup)
    return missingLabel(result) ?? shakyLabel(result)
  }

  /** The warning badge on a row: only a real blocker, not a stand-in hint. */
  function rowWarning(item: SetlistEntry): string | null {
    if (item.custom) return null
    if (!isActive(item.song)) return 'ausgemustert'
    return missingLabel(coverage(item.song, state.lineup))
  }

  function paintLineup(): void {
    const chips = roster.map((member) => {
      const on = state.lineup.has(member.id)
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = member.name
      button.classList.toggle('on', on)
      button.setAttribute('aria-pressed', String(on))
      button.addEventListener('click', () => toggleMember(member.id))
      return button
    })
    $('lineup-chips').replaceChildren(...chips)
    $('lineup-hint').textContent =
      state.lineup.size === 0
        ? 'Niemand ausgewählt – es wird nicht nach Besetzung gefiltert.'
        : `${state.lineup.size} von ${roster.length} dabei · ` +
          `${ctx.poolIds.length} von ${activeCount} Songs spielbar`
  }

  /** Active songs this lineup cannot cover, most played first. */
  function lineupOut(): Song[] {
    if (state.lineup.size === 0) return []
    return data.songs
      .filter((song) => isActive(song) && !coverage(song, state.lineup).playable)
      .sort((a, b) => b.plays - a.plays || a.id.localeCompare(b.id, 'de'))
  }

  function paintLineupOut(): void {
    const out = lineupOut()
    const section = $<HTMLDetailsElement>('lineup-out')
    section.hidden = out.length === 0
    $('lineup-out-head').textContent =
      out.length === 1
        ? 'Besetzung schließt 1 Song aus'
        : `Besetzung schließt ${out.length} Songs aus`
    const chips = out.map((song) => {
      const chip = document.createElement('span')
      const artist = artistName(song)
      const reason = missingLabel(coverage(song, state.lineup))
      chip.textContent = `${artist ? `${artist} · ` : ''}${song.title} – ${reason}`
      return chip
    })
    $('lineup-out-chips').replaceChildren(...chips)
  }

  /**
   * Swaps out every entry the lineup can no longer play. Pinned and free-text
   * entries stay — a pin is the user's decision and beats the sheet.
   */
  function pruneForLineup(): number {
    let list = state.list
    let dropped = 0
    let i = 0
    while (i < list.length) {
      const item = list[i]!
      if (item.pinned || item.custom || isEligible(item.song, state.lineup)) {
        i++
        continue
      }
      dropped++
      const before = list.length
      list = replaceAt(ctx, list, i, { blocked: state.blocked })
      // replaceAt shortens the list when nothing fits; then re-check this slot.
      if (list.length === before) i++
    }
    state.list = list
    return dropped
  }

  function toggleMember(id: string): void {
    if (state.lineup.has(id)) state.lineup.delete(id)
    else state.lineup.add(id)
    rebuildContext()
    const dropped = pruneForLineup()
    paint()
    if (dropped > 0) {
      toast(dropped === 1 ? '1 Song ersetzt – passt nicht zur Besetzung' : `${dropped} Songs ersetzt`)
    }
  }

  function paintClock(): void {
    const pure = songSeconds(state.list)
    const padded = totalSeconds(state.list, state.bufferSeconds)
    const off = padded - state.targetSeconds
    const clock = $('clock')
    clock.classList.remove('ok', 'warn', 'bad')
    clock.classList.add(
      Math.abs(off) <= CLOCK_OK_SECONDS ? 'ok' : Math.abs(off) <= CLOCK_WARN_SECONDS ? 'warn' : 'bad',
    )
    const empty = state.list.length === 0
    const sign = off >= 0 ? '+' : '−'
    $('clock-total').textContent = empty ? '–' : minutes(padded)
    $('clock-detail').textContent = empty
      ? ''
      : `${state.list.length} Songs · Songzeit ${minutes(pure)}`
    $('clock-goal').textContent = `Ziel ${formatTarget(state.targetSeconds)}`
    $('clock-delta').textContent = empty ? '' : `${sign}${Math.abs(Math.round(off / 60))} min`
  }

  function paintBlocked(): void {
    const section = $('blocked')
    section.hidden = state.blocked.size === 0
    const chips = [...state.blocked].map((id) => {
      const song = ctx.songs.get(id)
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = song ? `${artistName(song)} · ${song.title} ✕` : `${id} ✕`
      button.addEventListener('click', () => {
        state.blocked.delete(id)
        paint()
        toast('Wieder zugelassen')
      })
      return button
    })
    $('blocked-chips').replaceChildren(...chips)
  }

  function currentHash(): string {
    return state.list.length > 0
      ? `#${encodeShare({ ...state, list: state.list, lineup: lineupIds() }, data)}`
      : ''
  }

  /** Puts the playing time controls back in step with the state. */
  function syncTarget(): void {
    const total = Math.round(state.targetSeconds / 60)
    $('target-value').textContent = formatTarget(state.targetSeconds)
    // The slider only spans the usual gig lengths, the field goes further.
    const low = Number(targetRange.min)
    const high = Number(targetRange.max)
    targetRange.value = String(Math.min(high, Math.max(low, total)))
    if (document.activeElement !== targetMinutes) targetMinutes.value = String(total)
  }

  /** Puts the sliders and the playing time back in step with the state. */
  function syncControls(): void {
    buffer.value = String(state.bufferSeconds)
    halflife.value = String(state.halfLifeMonths)
    showBuffer()
    showHalfLife()
    syncTarget()
  }

  function paint(): void {
    renderList(listRoot, state.list, handlers, { warning: rowWarning })
    renderAppend($('append'), handlers)
    paintClock()
    paintBlocked()
    paintLineup()
    paintLineupOut()
    syncTarget()
    $('print-head').textContent =
      state.list.length > 0 ? `${headline(state.list, meta())} · ${today()}` : ''
    // Keep the hash in step so a reload or a shared link restores this list.
    const hash = currentHash()
    if (hash !== location.hash) history.replaceState(null, '', hash || location.pathname)
  }

  function meta(): { targetSeconds: number; bufferSeconds: number; lineup: string[] } {
    return {
      targetSeconds: state.targetSeconds,
      bufferSeconds: state.bufferSeconds,
      // Only worth naming when somebody is missing.
      lineup: state.lineup.size < roster.length ? lineupNames() : [],
    }
  }

  /** Generates a list; `roll` picks randomly instead of taking the best. */
  function build(roll: boolean): void {
    state.list = generate(ctx, {
      targetSeconds: state.targetSeconds,
      bufferSeconds: state.bufferSeconds,
      blocked: state.blocked,
      random: roll ? Math.random : null,
      keep: state.list.filter((item) => item.pinned),
    })
    paint()
  }

  // --- controls ------------------------------------------------------------

  $('generate').addEventListener('click', () => build(false))
  $('reroll').addEventListener('click', () => build(true))

  const targetRange = $<HTMLInputElement>('target-range')
  const targetMinutes = $<HTMLInputElement>('target-minutes')

  /** Sets the playing time; `rebuild` regenerates an existing list. */
  function setTarget(minutes: number, rebuild: boolean): void {
    if (!Number.isFinite(minutes)) {
      syncTarget()
      return
    }
    const clamped = Math.min(MAX_TARGET_MINUTES, Math.max(MIN_TARGET_MINUTES, Math.round(minutes)))
    state.targetSeconds = clamped * 60
    syncTarget()
    if (rebuild && state.list.length > 0) build(false)
    else paintClock()
  }

  // Dragging only moves the goal line; the list is rebuilt once the drag ends.
  targetRange.addEventListener('input', () => setTarget(Number(targetRange.value), false))
  targetRange.addEventListener('change', () => setTarget(Number(targetRange.value), true))
  targetMinutes.addEventListener('change', () => setTarget(Number(targetMinutes.value), true))
  $('target-minus').addEventListener('click', () =>
    setTarget(Math.round(state.targetSeconds / 60) - TARGET_NUDGE_MINUTES, true),
  )
  $('target-plus').addEventListener('click', () =>
    setTarget(Math.round(state.targetSeconds / 60) + TARGET_NUDGE_MINUTES, true),
  )

  const buffer = $<HTMLInputElement>('buffer')
  buffer.value = String(state.bufferSeconds)
  const showBuffer = (): void => {
    $('buffer-value').textContent = `${buffer.value} s`
  }
  buffer.addEventListener('input', () => {
    state.bufferSeconds = Number(buffer.value)
    showBuffer()
    paintClock()
  })
  buffer.addEventListener('change', () => {
    if (state.list.length > 0) build(false)
  })
  showBuffer()

  const halflife = $<HTMLInputElement>('halflife')
  halflife.value = String(state.halfLifeMonths)
  const showHalfLife = (): void => {
    $('halflife-value').textContent = `${halflife.value} Monate`
  }
  halflife.addEventListener('input', showHalfLife)
  halflife.addEventListener('change', () => {
    state.halfLifeMonths = Number(halflife.value)
    rebuildContext()
    if (state.list.length > 0) build(false)
  })
  showHalfLife()

  // --- exports -------------------------------------------------------------

  const guard = (action: () => void | Promise<void>) => async (): Promise<void> => {
    if (state.list.length === 0) {
      toast('Erst eine Setlist generieren')
      return
    }
    await action()
  }

  $('copy').addEventListener(
    'click',
    guard(async () => {
      await copyText(asText(state.list, meta()))
      toast('Setlist kopiert')
    }),
  )

  $('forscore').addEventListener(
    'click',
    guard(() => {
      const info = { ...meta(), date: today() }
      download(asForScore(state.list, info), forScoreFileName(info))
      toast('forScore-Setlist geladen')
    }),
  )

  $('onsong').addEventListener(
    'click',
    guard(() => {
      const info = { ...meta(), date: today() }
      download(asOnSongBinder(state.list, info), onSongFileName(info), BINDER_MIME)
      toast('OnSong-Binder geladen')
    }),
  )

  $('share').addEventListener(
    'click',
    guard(async () => {
      await copyText(location.href)
      toast('Link kopiert')
    }),
  )

  $('print').addEventListener('click', guard(print))

  // --- go ------------------------------------------------------------------

  $('source').textContent =
    `${activeCount} Songs · ${data.gigs.length} Gigs bis ` +
    new Date(`${data.gigs[data.gigs.length - 1]?.date ?? data.generated}T12:00:00Z`)
      .toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })

  // A pasted link only changes the hash, which does not reload the page.
  window.addEventListener('hashchange', () => {
    if (location.hash && location.hash !== currentHash() && applyShared(location.hash)) {
      syncControls()
      paint()
      toast('Geteilte Setlist geladen')
    }
  })

  syncControls()
  if (state.list.length > 0) paint()
  else build(false)
}

main().catch((error: unknown) => {
  const app = document.getElementById('app')
  if (app) {
    app.textContent = `Konnte nicht starten: ${String(error)}`
  }
  console.error(error)
})
