/**
 * Bootstrap, state and wiring. All decisions live in scorer.ts — this file only
 * keeps the current list, feeds the sliders into it and paints the result.
 */

import { artistName, loadData } from './data'
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
import { DEFAULT_HALF_LIFE_MONTHS } from './stats'
import { enableDrag } from './ui/drag'
import { renderAppend, renderList, type RowHandlers } from './ui/render'
import { openSlotSheet } from './ui/sheet'

/** Selectable playing times. */
const TARGETS = [3600, 5400, 7200, 9000, 10_800]

/** Colour bands for the clock: green within 2 minutes, yellow within 5. */
const CLOCK_OK_SECONDS = 120
const CLOCK_WARN_SECONDS = 300

interface State {
  targetSeconds: number
  bufferSeconds: number
  halfLifeMonths: number
  list: SetlistEntry[]
  blocked: Set<string>
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

  const state: State = {
    targetSeconds: 7200,
    bufferSeconds: DEFAULT_BUFFER_SECONDS,
    halfLifeMonths: DEFAULT_HALF_LIFE_MONTHS,
    list: [],
    blocked: new Set(),
  }

  // Weights decay against today, not against the day the data was exported.
  let ctx = createContext(data, { halfLifeMonths: state.halfLifeMonths, now: new Date() })
  const rebuildContext = (): void => {
    ctx = createContext(data, { halfLifeMonths: state.halfLifeMonths, now: new Date() })
  }

  /** Takes over a shared state; returns false when the hash carries none. */
  const applyShared = (hash: string): boolean => {
    const shared = decodeShare(hash, data)
    if (!shared) return false
    state.targetSeconds = shared.targetSeconds
    state.bufferSeconds = shared.bufferSeconds
    state.halfLifeMonths = shared.halfLifeMonths
    state.list = shared.list
    rebuildContext()
    return true
  }

  applyShared(location.hash)

  // --- painting ------------------------------------------------------------

  const targetButtons = TARGETS.map((seconds) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = formatTarget(seconds)
    button.addEventListener('click', () => {
      state.targetSeconds = seconds
      build(false)
    })
    return button
  })
  $('targets').replaceChildren(...targetButtons)

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
    return state.list.length > 0 ? `#${encodeShare({ ...state, list: state.list }, data)}` : ''
  }

  /** Puts the sliders and the target buttons back in step with the state. */
  function syncControls(): void {
    buffer.value = String(state.bufferSeconds)
    halflife.value = String(state.halfLifeMonths)
    showBuffer()
    showHalfLife()
  }

  function paint(): void {
    renderList(listRoot, state.list, handlers)
    renderAppend($('append'), handlers)
    paintClock()
    paintBlocked()
    for (const [index, button] of targetButtons.entries()) {
      button.setAttribute('aria-pressed', String(TARGETS[index] === state.targetSeconds))
    }
    $('print-head').textContent =
      state.list.length > 0 ? `${headline(state.list, meta())} · ${today()}` : ''
    // Keep the hash in step so a reload or a shared link restores this list.
    const hash = currentHash()
    if (hash !== location.hash) history.replaceState(null, '', hash || location.pathname)
  }

  function meta(): { targetSeconds: number; bufferSeconds: number } {
    return { targetSeconds: state.targetSeconds, bufferSeconds: state.bufferSeconds }
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
    `${data.songs.length} Songs · ${data.gigs.length} Gigs bis ` +
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
