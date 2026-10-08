/**
 * Placeholder bootstrap: loads the data and prints a generated setlist so the
 * build and `npm run preview` work end to end. The real UI replaces this.
 */
import { artistName, formatDuration, loadData } from './data'
import { createContext, DEFAULT_BUFFER_SECONDS, generate, totalSeconds } from './scorer'

const app = document.querySelector<HTMLElement>('#app')!

async function main(): Promise<void> {
  const data = await loadData(`${import.meta.env.BASE_URL}data.json`)
  const ctx = createContext(data, { now: new Date() })
  const list = generate(ctx, { targetSeconds: 7200, bufferSeconds: DEFAULT_BUFFER_SECONDS })
  const minutes = Math.round(totalSeconds(list, DEFAULT_BUFFER_SECONDS) / 60)
  const lines = list.map(
    (item, i) =>
      `${String(i + 1).padStart(2, '0')}. ${artistName(item.song)} – ${item.song.title}` +
      ` (${formatDuration(item.song.duration ?? 225)})`,
  )
  app.textContent = `Saitenhieb · 2 h · ${list.length} Songs · ${minutes} min\n\n${lines.join('\n')}`
  app.style.whiteSpace = 'pre-wrap'
  app.style.fontFamily = 'ui-monospace, monospace'
}

main().catch((error: unknown) => {
  app.textContent = `Fehler: ${String(error)}`
})
