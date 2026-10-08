/**
 * Reordering by dragging the number on the left.
 *
 * Pointer events, not HTML5 drag and drop: the band uses this on an iPad, and
 * HTML5 dragging never fires on touch.
 *
 * The DOM is deliberately left alone while the finger is down. Moving the
 * dragged element releases its pointer capture, which kills the rest of the
 * gesture — so instead the dragged row and the rows it passes are only shifted
 * with a transform, and the list is rebuilt once, on release.
 */

export interface DragOptions {
  /** Called once, when the finger goes up on a new position. */
  onReorder: (from: number, to: number) => void
}

interface Slot {
  row: HTMLLIElement
  top: number
  height: number
}

export function enableDrag(root: HTMLOListElement, options: DragOptions): void {
  root.addEventListener('pointerdown', (event: PointerEvent) => {
    const handle = (event.target as HTMLElement | null)?.closest('[data-handle]')
    if (!handle) return
    const row = handle.closest('li.song') as HTMLLIElement | null
    if (!row) return

    event.preventDefault()

    const slots: Slot[] = ([...root.querySelectorAll('li.song')] as HTMLLIElement[]).map(
      (node) => {
        const box = node.getBoundingClientRect()
        return { row: node, top: box.top, height: box.height }
      },
    )
    const from = slots.findIndex((slot) => slot.row === row)
    if (from < 0) return

    const startY = event.clientY
    const dragged = slots[from]!
    // How far the other rows move when the dragged row leaves its place.
    const shift = dragged.height + 6
    let to = from

    row.classList.add('dragging')
    // Capture on the list, which never moves, so the gesture survives.
    root.setPointerCapture(event.pointerId)

    const move = (moveEvent: PointerEvent): void => {
      const dy = moveEvent.clientY - startY
      row.style.transform = `translateY(${dy}px)`

      // Where the middle of the dragged row sits now.
      const middle = dragged.top + dragged.height / 2 + dy
      let target = from
      for (const [index, slot] of slots.entries()) {
        if (index === from) continue
        const slotMiddle = slot.top + slot.height / 2
        if (index < from && middle < slotMiddle) {
          target = Math.min(target, index)
        } else if (index > from && middle > slotMiddle) {
          target = Math.max(target, index)
        }
      }
      if (target === to) return
      to = target

      for (const [index, slot] of slots.entries()) {
        if (index === from) continue
        const movesDown = to < from && index >= to && index < from
        const movesUp = to > from && index > from && index <= to
        slot.row.style.transform = movesDown
          ? `translateY(${shift}px)`
          : movesUp
            ? `translateY(${-shift}px)`
            : ''
      }
    }

    const finish = (): void => {
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerup', finish)
      root.removeEventListener('pointercancel', finish)
      try {
        root.releasePointerCapture(event.pointerId)
      } catch {
        // The pointer was already gone; nothing to release.
      }
      row.classList.remove('dragging')
      for (const slot of slots) slot.row.style.transform = ''
      if (to !== from) options.onReorder(from, to)
    }

    root.addEventListener('pointermove', move)
    root.addEventListener('pointerup', finish)
    root.addEventListener('pointercancel', finish)
  })
}
