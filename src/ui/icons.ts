/** Inline SVG icons. They inherit currentColor, so a pressed button shows. */

const svg = (path: string, filled = false): string =>
  `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="${
    filled ? 'currentColor' : 'none'
  }" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`

export const icons = {
  pin: svg('<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 14v7"/>'),
  pinFilled: svg('<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 14v7"/>', true),
  more: svg('<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>', true),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  grip: svg('<path d="M8 7h8M8 12h8M8 17h8"/>'),
}
