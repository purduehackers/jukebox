// Single-axis pointer & keyboard drag-and-drop reordering for /admin queues.
// Uses layout midpoints, pointer capture, CSS drop markers, moveBefore() + before() fallback,
// and FLIP animations. DOM drag attributes/transforms live outside React props so 1s clock ticks
// never wipe an active drag.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type {
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { applyMove, dropAnchor, moveAnchor } from './derive.ts';
import type { Direction } from './derive.ts';

export interface LayoutItemBox {
  id: string;
  offsetTop: number;
  offsetHeight: number;
}

export interface DropMarkerRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const EDGE_SPEED_PX_PER_SEC = 360;
const MAX_SPEED_PX_PER_SEC = 900;
const FLIP_DURATION_MS = 200;
const FLIP_EASING = 'cubic-bezier(0.2, 0, 0, 1)';

/**
 * Determine which sortable item `pointerY` falls before, using layout midpoints
 * (`offsetTop + offsetHeight / 2`) with container `clientTop` and `scrollTop` accounted for.
 * Returns `null` when the drop target is after all items.
 */
export function findDropBeforeId(
  pointerY: number,
  containerTop: number,
  containerClientTop: number,
  containerScrollTop: number,
  containerClientHeight: number,
  items: readonly LayoutItemBox[],
): string | null {
  if (items.length === 0) return null;
  const contentOrigin = containerTop + containerClientTop;
  const clampedY = Math.min(Math.max(pointerY, contentOrigin), contentOrigin + Math.max(0, containerClientHeight));
  const contentY = clampedY - contentOrigin + containerScrollTop;
  for (const item of items) {
    const midpoint = item.offsetTop + item.offsetHeight / 2;
    if (contentY < midpoint) return item.id;
  }
  return null;
}

/**
 * Compute vertical auto-scroll velocity (px/s) when `pointerY` enters the top or bottom edge zone.
 * Edge zone is `min(itemHeight, span / 3)` so zones never overlap, and speed increases past the edge up to a cap.
 */
export function computeAutoScrollVelocity(
  pointerY: number,
  viewportStart: number,
  viewportEnd: number,
  itemHeight: number,
): number {
  const span = Math.max(0, viewportEnd - viewportStart);
  if (span <= 0) return 0;
  const zone = Math.min(Math.max(1, itemHeight), span / 3);
  if (pointerY < viewportStart + zone) {
    const ratio = (viewportStart + zone - pointerY) / zone;
    return -Math.min(MAX_SPEED_PX_PER_SEC, ratio * EDGE_SPEED_PX_PER_SEC);
  }
  if (pointerY > viewportEnd - zone) {
    const ratio = (pointerY - (viewportEnd - zone)) / zone;
    return Math.min(MAX_SPEED_PX_PER_SEC, ratio * EDGE_SPEED_PX_PER_SEC);
  }
  return 0;
}

/**
 * Compute the fixed viewport rect for the drop marker centered in the gap between `prevRect` and `nextRect`.
 */
export function computeDropMarker(
  listRect: { left: number; width: number },
  prevRect: { bottom: number } | null,
  nextRect: { top: number } | null,
  lineHeightPx = 2,
): DropMarkerRect | null {
  if (!prevRect && !nextRect) return null;
  let y: number;
  if (prevRect && nextRect) {
    y = (prevRect.bottom + nextRect.top) / 2 - lineHeightPx / 2;
  } else if (nextRect) {
    y = nextRect.top - lineHeightPx / 2;
  } else {
    y = prevRect!.bottom - lineHeightPx / 2;
  }
  return { x: listRect.left, y, w: listRect.width, h: lineHeightPx };
}

/**
 * Atomically move `item` before `referenceNode` (or to the end when `null`) using `moveBefore()`
 * when supported, falling back to `before()` / `append()`. Returns `true` if native `moveBefore()` ran.
 */
export function moveNodeBefore(container: Element, item: Element, referenceNode: Element | null): boolean {
  if (item === referenceNode) return true;
  if (typeof Element !== 'undefined' && 'moveBefore' in Element.prototype) {
    const movable = container as Element & { moveBefore(node: Node, child: Node | null): void };
    movable.moveBefore(item, referenceNode);
    return true;
  }
  if (referenceNode) referenceNode.before(item);
  else container.append(item);
  return false;
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

interface ScrollSnapshot {
  x: number;
  y: number;
  listLeft: number;
  listTop: number;
}

interface PendingFlip {
  movedId: string;
  beforeRects: Map<string, DOMRect>;
  beforeScroll: ScrollSnapshot;
  draggedFromRect?: DOMRect;
  scaleFrom?: number;
  focusTarget?: HTMLElement | null;
}

interface KeyboardGrabState {
  entryId: string;
  title: string;
  originAfterEntryId: string | null;
  currentAfterEntryId: string | null;
}

interface ActiveDrag {
  pointerId: number;
  entryId: string;
  title: string;
  handleEl: HTMLButtonElement;
  itemEl: HTMLLIElement;
  rootEl: Element | null;
  grabOffsetY: number;
  pointerX: number;
  pointerY: number;
  itemHeight: number;
  insertBeforeId: string | null;
  rafId: number;
  lastFrameTime: number;
  cleanup: () => void;
}

export interface UseQueueReorderOptions<T extends { id: string; title: string }> {
  queue: 'master' | 'request';
  items: readonly T[];
  listRef: RefObject<HTMLUListElement | null>;
  onCommitMove: (entryId: string, afterEntryId: string | null, title: string) => void;
  onStartInteraction?: () => void;
  onAnnounce: (message: string, delayMs?: number) => void;
}

export interface QueueReorderResult<T extends { id: string; title: string }> {
  displayItems: readonly T[];
  grabbedId: string | null;
  handlePointerDown: (event: ReactPointerEvent<HTMLButtonElement>, entryId: string) => void;
  handleKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>, entryId: string) => void;
  handleBlur: (event: ReactFocusEvent<HTMLButtonElement>, entryId: string) => void;
  handleClick: (event: ReactMouseEvent<HTMLButtonElement>, entryId: string) => void;
  handleListFocus: (event: ReactFocusEvent<HTMLUListElement>) => void;
  moveByButton: (entryId: string, direction: Direction, clickedButton?: HTMLElement | null) => void;
  cancelKeyboardGrab: (options?: { silent?: boolean }) => void;
}

const entryRows = (list: HTMLUListElement): HTMLLIElement[] =>
  Array.from(list.children).filter(
    (el): el is HTMLLIElement => el instanceof HTMLLIElement && Boolean(el.dataset.entry),
  );

const sortableRows = (list: HTMLUListElement): HTMLLIElement[] =>
  Array.from(list.children).filter(
    (el): el is HTMLLIElement => el instanceof HTMLLIElement && el.dataset.sortable === 'true',
  );

const rowById = (list: HTMLUListElement, entryId: string): HTMLLIElement | null =>
  entryRows(list).find((el) => el.dataset.entry === entryId) ?? null;

const captureScroll = (list: HTMLUListElement): ScrollSnapshot => ({
  x: typeof window !== 'undefined' ? window.scrollX : 0,
  y: typeof window !== 'undefined' ? window.scrollY : 0,
  listLeft: list.scrollLeft,
  listTop: list.scrollTop,
});

const captureRects = (list: HTMLUListElement): Map<string, DOMRect> => {
  const rects = new Map<string, DOMRect>();
  for (const row of entryRows(list)) {
    const id = row.dataset.entry;
    if (id) rects.set(id, row.getBoundingClientRect());
  }
  return rects;
};

const clearDropMarker = (list: HTMLUListElement) => {
  list.removeAttribute('data-drop');
  list.style.removeProperty('--drop-x');
  list.style.removeProperty('--drop-y');
  list.style.removeProperty('--drop-w');
  list.style.removeProperty('--drop-h');
};

const finishAllAnimations = (el: Element) => {
  if (typeof el.getAnimations !== 'function') return;
  for (const anim of el.getAnimations()) {
    try {
      anim.finish();
    } catch {
      anim.cancel();
    }
  }
};

export function useQueueReorder<T extends { id: string; title: string }>(
  options: UseQueueReorderOptions<T>,
): QueueReorderResult<T> {
  const { queue, items, listRef, onCommitMove, onStartInteraction, onAnnounce } = options;

  const [, bumpLayout] = useReducer((c: number) => c + 1, 0);
  const [keyboardGrab, setKeyboardGrab] = useReducer(
    (_prev: KeyboardGrabState | null, next: KeyboardGrabState | null) => next,
    null,
  );

  const itemsRef = useRef(items);
  itemsRef.current = items;

  const keyboardGrabRef = useRef(keyboardGrab);
  keyboardGrabRef.current = keyboardGrab;

  const callbacksRef = useRef({ onCommitMove, onStartInteraction, onAnnounce });
  callbacksRef.current = { onCommitMove, onStartInteraction, onAnnounce };

  const activeDragRef = useRef<ActiveDrag | null>(null);
  const pendingFlipRef = useRef<PendingFlip | null>(null);
  const settleTokensRef = useRef(new Map<string, number>());
  const settleSeqRef = useRef(0);
  const movingFocusRef = useRef(false);
  const clickGuardTimerRef = useRef<number | null>(null);
  const pointerClickGuardRef = useRef(false);
  const keyClickGuardRef = useRef(false);

  const displayItems = useMemo(() => {
    if (!keyboardGrab) return items;
    return applyMove(items, keyboardGrab.entryId, keyboardGrab.currentAfterEntryId);
  }, [items, keyboardGrab]);

  const displayItemsRef = useRef(displayItems);
  displayItemsRef.current = displayItems;

  const nextSettleToken = useCallback((entryId: string): number => {
    const next = ++settleSeqRef.current;
    settleTokensRef.current.set(entryId, next);
    return next;
  }, []);

  const animateReturnToSlot = useCallback(
    (
      itemEl: HTMLLIElement,
      entryId: string,
      fromRect: DOMRect,
      beforeScroll: ScrollSnapshot,
      list: HTMLUListElement,
      scaleFrom?: number,
    ) => {
      if (prefersReducedMotion() || typeof itemEl.animate !== 'function') {
        itemEl.removeAttribute('data-settling');
        if (typeof itemEl.scrollIntoView === 'function') {
          itemEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        return;
      }
      const token = nextSettleToken(entryId);
      itemEl.setAttribute('data-settling', 'true');
      if (typeof itemEl.scrollIntoView === 'function') {
        itemEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      finishAllAnimations(itemEl);
      const toRect = itemEl.getBoundingClientRect();
      const scrollDx = (window.scrollX - beforeScroll.x) + (list.scrollLeft - beforeScroll.listLeft);
      const scrollDy = (window.scrollY - beforeScroll.y) + (list.scrollTop - beforeScroll.listTop);
      const dx = fromRect.left + fromRect.width / 2 - scrollDx - (toRect.left + toRect.width / 2);
      const dy = fromRect.top + fromRect.height / 2 - scrollDy - (toRect.top + toRect.height / 2);
      const fromFrame: Keyframe = scaleFrom
        ? { translate: `${dx}px ${dy}px`, scale: String(scaleFrom) }
        : { translate: `${dx}px ${dy}px` };
      const toFrame: Keyframe = scaleFrom ? { translate: '0 0', scale: '1' } : { translate: '0 0' };
      const anim = itemEl.animate([fromFrame, toFrame], {
        duration: FLIP_DURATION_MS,
        easing: FLIP_EASING,
      });
      const done = () => {
        if (settleTokensRef.current.get(entryId) === token && activeDragRef.current?.entryId !== entryId) {
          itemEl.removeAttribute('data-settling');
        }
      };
      anim.finished.then(done, done);
    },
    [nextSettleToken],
  );

  // Run pending FLIP animations immediately after React commits the reordered DOM.
  useLayoutEffect(() => {
    const flip = pendingFlipRef.current;
    if (!flip) return;
    pendingFlipRef.current = null;
    const list = listRef.current;
    if (!list) return;

    const rows = entryRows(list);
    const movedEl = rows.find((el) => el.dataset.entry === flip.movedId) ?? null;

    for (const el of rows) finishAllAnimations(el);

    if (movedEl && typeof movedEl.scrollIntoView === 'function') {
      movedEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (flip.focusTarget && flip.focusTarget.isConnected) {
      movingFocusRef.current = true;
      flip.focusTarget.focus({ preventScroll: true });
      movingFocusRef.current = false;
    }

    if (prefersReducedMotion()) {
      if (movedEl) movedEl.removeAttribute('data-settling');
      return;
    }

    const scrollDx = (window.scrollX - flip.beforeScroll.x) + (list.scrollLeft - flip.beforeScroll.listLeft);
    const scrollDy = (window.scrollY - flip.beforeScroll.y) + (list.scrollTop - flip.beforeScroll.listTop);

    for (const el of rows) {
      const id = el.dataset.entry;
      if (!id || typeof el.animate !== 'function') continue;
      const isMoved = id === flip.movedId;
      const fromRect = isMoved && flip.draggedFromRect ? flip.draggedFromRect : flip.beforeRects.get(id);
      if (!fromRect) continue;
      const toRect = el.getBoundingClientRect();
      const dx = fromRect.left + fromRect.width / 2 - scrollDx - (toRect.left + toRect.width / 2);
      const dy = fromRect.top + fromRect.height / 2 - scrollDy - (toRect.top + toRect.height / 2);
      const hasScale = isMoved && flip.scaleFrom !== undefined;

      if (!isMoved && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;

      if (isMoved) {
        const token = nextSettleToken(id);
        el.setAttribute('data-settling', 'true');
        const fromFrame: Keyframe = hasScale
          ? { translate: `${dx}px ${dy}px`, scale: String(flip.scaleFrom) }
          : { translate: `${dx}px ${dy}px` };
        const toFrame: Keyframe = hasScale ? { translate: '0 0', scale: '1' } : { translate: '0 0' };
        const anim = el.animate([fromFrame, toFrame], {
          duration: FLIP_DURATION_MS,
          easing: FLIP_EASING,
        });
        const done = () => {
          if (settleTokensRef.current.get(id) === token && activeDragRef.current?.entryId !== id) {
            el.removeAttribute('data-settling');
          }
        };
        anim.finished.then(done, done);
      } else {
        el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], {
          duration: FLIP_DURATION_MS,
          easing: FLIP_EASING,
        });
      }
    }
  });

  // Abort active drag or keyboard grab if the item vanishes from the queue (e.g. concurrent remove or starts playing).
  useEffect(() => {
    const drag = activeDragRef.current;
    if (drag && !items.some((item) => item.id === drag.entryId)) {
      drag.cleanup();
    }
    if (keyboardGrab && !items.some((item) => item.id === keyboardGrab.entryId)) {
      setKeyboardGrab(null);
    }
  }, [items, keyboardGrab]);

  // Clean up active listeners and timers on unmount.
  useEffect(() => {
    return () => {
      activeDragRef.current?.cleanup();
      if (clickGuardTimerRef.current !== null) {
        window.clearTimeout(clickGuardTimerRef.current);
      }
    };
  }, []);

  const armClickGuardClear = useCallback((kind: 'pointer' | 'key') => {
    if (kind === 'pointer') pointerClickGuardRef.current = true;
    else keyClickGuardRef.current = true;
    if (clickGuardTimerRef.current !== null) window.clearTimeout(clickGuardTimerRef.current);
    clickGuardTimerRef.current = window.setTimeout(() => {
      pointerClickGuardRef.current = false;
      keyClickGuardRef.current = false;
      clickGuardTimerRef.current = null;
    }, 60);
  }, []);

  const cancelKeyboardGrab = useCallback(
    (opts: { silent?: boolean } = {}) => {
      const grab = keyboardGrabRef.current;
      if (!grab) return;
      const list = listRef.current;
      const current = displayItemsRef.current;
      const restored = applyMove(current, grab.entryId, grab.originAfterEntryId);
      const restoredIdx = restored.findIndex((i) => i.id === grab.entryId);

      if (list && grab.currentAfterEntryId !== grab.originAfterEntryId) {
        const itemEl = rowById(list, grab.entryId);
        if (itemEl) {
          const beforeRects = captureRects(list);
          const beforeScroll = captureScroll(list);
          const nextId = restored[restoredIdx + 1]?.id ?? null;
          const refNode = nextId ? rowById(list, nextId) : null;
          const handleEl = itemEl.querySelector<HTMLButtonElement>('[data-adm-drag-handle]');
          const restoreFocus = document.activeElement === handleEl;

          movingFocusRef.current = true;
          const usedNative = moveNodeBefore(list, itemEl, refNode);
          if (restoreFocus && handleEl) handleEl.focus({ preventScroll: true });
          movingFocusRef.current = false;

          pendingFlipRef.current = {
            movedId: grab.entryId,
            beforeRects,
            beforeScroll,
            focusTarget: restoreFocus ? handleEl : null,
          };

          if (!opts.silent && restoredIdx >= 0) {
            callbacksRef.current.onAnnounce(
              `Reordering cancelled. “${grab.title}” returned to position ${restoredIdx + 1} of ${restored.length}.`,
              usedNative ? 100 : 500,
            );
          }
          setKeyboardGrab(null);
          return;
        }
      }

      if (!opts.silent && restoredIdx >= 0) {
        callbacksRef.current.onAnnounce(
          `Reordering cancelled. “${grab.title}” stayed at position ${restoredIdx + 1} of ${restored.length}.`,
        );
      }
      setKeyboardGrab(null);
    },
    [listRef],
  );

  const commitKeyboardGrab = useCallback(
    (grab: KeyboardGrabState, keepFocus: boolean) => {
      const current = displayItemsRef.current;
      const finalIdx = current.findIndex((i) => i.id === grab.entryId);
      const moved = grab.currentAfterEntryId !== grab.originAfterEntryId;
      if (moved) {
        callbacksRef.current.onCommitMove(grab.entryId, grab.currentAfterEntryId, grab.title);
        if (finalIdx >= 0) {
          callbacksRef.current.onAnnounce(
            `Dropped “${grab.title}” at position ${finalIdx + 1} of ${current.length}.`,
          );
        }
      }
      setKeyboardGrab(null);
      if (keepFocus && listRef.current) {
        const handleEl = rowById(listRef.current, grab.entryId)?.querySelector<HTMLButtonElement>(
          '[data-adm-drag-handle]',
        );
        if (handleEl && document.activeElement !== handleEl) {
          handleEl.focus({ preventScroll: true });
        }
      }
    },
    [listRef],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>, entryId: string) => {
      if (event.button !== 0) return;
      if (itemsRef.current.length < 2) return;
      if (activeDragRef.current) return;

      const list = listRef.current;
      if (!list) return;
      const itemEl = rowById(list, entryId);
      if (!itemEl || itemEl.dataset.sortable !== 'true') return;
      const itemObj = itemsRef.current.find((i) => i.id === entryId);
      if (!itemObj) return;

      event.preventDefault();
      armClickGuardClear('pointer');
      if (keyboardGrabRef.current) cancelKeyboardGrab({ silent: true });
      callbacksRef.current.onStartInteraction?.();

      nextSettleToken(entryId);
      itemEl.removeAttribute('data-settling');
      finishAllAnimations(itemEl);

      const itemRect = itemEl.getBoundingClientRect();
      const handleEl = event.currentTarget;
      try {
        handleEl.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointer events in tests may not map to an active pointer.
      }

      const rootEl = list.closest('.adm-root');
      itemEl.setAttribute('data-dragging', 'true');
      itemEl.style.translate = '0 0px';
      document.documentElement.classList.add('adm-dragging');
      rootEl?.classList.add('adm-dragging');

      const drag: ActiveDrag = {
        pointerId: event.pointerId,
        entryId,
        title: itemObj.title,
        handleEl,
        itemEl,
        rootEl,
        grabOffsetY: event.clientY - itemRect.top,
        pointerX: event.clientX,
        pointerY: event.clientY,
        itemHeight: itemRect.height,
        insertBeforeId: null,
        rafId: 0,
        lastFrameTime: 0,
        cleanup: () => undefined,
      };
      activeDragRef.current = drag;

      const updateDragPosition = () => {
        if (activeDragRef.current !== drag) return;
        const currentList = listRef.current;
        if (!currentList) return;
        const listRect = currentList.getBoundingClientRect();
        const slotTop = listRect.top + currentList.clientTop + drag.itemEl.offsetTop - currentList.scrollTop;
        const ty = drag.pointerY - drag.grabOffsetY - slotTop;
        drag.itemEl.style.translate = `0 ${ty}px`;

        const rows = sortableRows(currentList);
        const sortableIds = rows.map((el) => el.dataset.entry!).filter(Boolean);
        const layoutItems = rows.map((el) => ({
          id: el.dataset.entry!,
          offsetTop: el.offsetTop,
          offsetHeight: el.offsetHeight,
        }));
        const insertBeforeId = findDropBeforeId(
          drag.pointerY,
          listRect.top,
          currentList.clientTop,
          currentList.scrollTop,
          currentList.clientHeight,
          layoutItems,
        );
        drag.insertBeforeId = insertBeforeId;

        const anchor = dropAnchor(sortableIds, drag.entryId, insertBeforeId);
        if (!anchor) {
          clearDropMarker(currentList);
          return;
        }
        let prevEl: HTMLLIElement | null = null;
        let nextEl: HTMLLIElement | null = null;
        if (insertBeforeId === null) {
          prevEl = rows[rows.length - 1] ?? null;
        } else {
          const nextIdx = rows.findIndex((el) => el.dataset.entry === insertBeforeId);
          nextEl = nextIdx >= 0 ? rows[nextIdx]! : null;
          prevEl = nextIdx > 0 ? rows[nextIdx - 1]! : null;
        }
        const marker = computeDropMarker(
          listRect,
          prevEl ? prevEl.getBoundingClientRect() : null,
          nextEl ? nextEl.getBoundingClientRect() : null,
          2,
        );
        if (!marker) {
          clearDropMarker(currentList);
          return;
        }
        currentList.setAttribute('data-drop', 'true');
        currentList.style.setProperty('--drop-x', `${marker.x}px`);
        currentList.style.setProperty('--drop-y', `${marker.y}px`);
        currentList.style.setProperty('--drop-w', `${marker.w}px`);
        currentList.style.setProperty('--drop-h', `${marker.h}px`);
      };

      const stepAutoScroll = (now: number) => {
        if (activeDragRef.current !== drag) return;
        const currentList = listRef.current;
        if (!currentList) return;
        const dt = drag.lastFrameTime ? Math.min(0.05, (now - drag.lastFrameTime) / 1000) : 0;
        drag.lastFrameTime = now;

        let scrolled = false;
        if (dt > 0) {
          const overflowY = getComputedStyle(currentList).overflowY;
          if (currentList.scrollHeight > currentList.clientHeight + 1 && /(auto|scroll)/.test(overflowY)) {
            const listRect = currentList.getBoundingClientRect();
            const vList = computeAutoScrollVelocity(drag.pointerY, listRect.top, listRect.bottom, drag.itemHeight);
            if (vList !== 0) {
              const beforeTop = currentList.scrollTop;
              currentList.scrollTop += vList * dt;
              if (currentList.scrollTop !== beforeTop) scrolled = true;
            }
          }
          if (document.documentElement.scrollHeight > window.innerHeight + 1) {
            const vWin = computeAutoScrollVelocity(drag.pointerY, 0, window.innerHeight, drag.itemHeight);
            if (vWin !== 0) {
              const beforeY = window.scrollY;
              window.scrollBy(0, vWin * dt);
              if (window.scrollY !== beforeY) scrolled = true;
            }
          }
        }
        if (scrolled) updateDragPosition();
        drag.rafId = window.requestAnimationFrame(stepAutoScroll);
      };

      const teardown = () => {
        if (activeDragRef.current === drag) activeDragRef.current = null;
        if (drag.rafId) {
          window.cancelAnimationFrame(drag.rafId);
          drag.rafId = 0;
        }
        document.removeEventListener('pointermove', onDocPointerMove);
        document.removeEventListener('pointerup', onDocPointerUp);
        document.removeEventListener('pointercancel', onDocPointerCancel);
        document.removeEventListener('keydown', onDocKeyDown, true);
        document.removeEventListener('scroll', onDocScroll, true);
        drag.handleEl.removeEventListener('lostpointercapture', onLostPointerCapture);

        try {
          if (drag.handleEl.hasPointerCapture(drag.pointerId)) {
            drag.handleEl.releasePointerCapture(drag.pointerId);
          }
        } catch {
          // Capture may already have been released.
        }

        document.documentElement.classList.remove('adm-dragging');
        drag.rootEl?.classList.remove('adm-dragging');
        drag.itemEl.removeAttribute('data-dragging');
        drag.itemEl.style.translate = '';
        clearDropMarker(list);
      };
      drag.cleanup = teardown;

      const cancelToSlot = (announceCancel: boolean) => {
        if (activeDragRef.current !== drag) return;
        const fromRect = drag.itemEl.getBoundingClientRect();
        const beforeScroll = captureScroll(list);
        const rows = sortableRows(list);
        const currentIndex = rows.findIndex((el) => el.dataset.entry === drag.entryId);
        teardown();
        animateReturnToSlot(drag.itemEl, drag.entryId, fromRect, beforeScroll, list, 1.02);
        if (announceCancel && currentIndex >= 0) {
          callbacksRef.current.onAnnounce(
            `Reordering cancelled. “${drag.title}” stayed at position ${currentIndex + 1} of ${rows.length}.`,
          );
        }
      };

      const onDocPointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== drag.pointerId) return;
        drag.pointerX = moveEvent.clientX;
        drag.pointerY = moveEvent.clientY;
        updateDragPosition();
      };

      const onDocScroll = () => {
        updateDragPosition();
      };

      const onDocKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== 'Escape') return;
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        cancelToSlot(true);
      };

      const onDocPointerCancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== drag.pointerId) return;
        cancelToSlot(false);
      };

      const onLostPointerCapture = (captureEvent: PointerEvent) => {
        if (captureEvent.pointerId !== drag.pointerId) return;
        cancelToSlot(false);
      };

      const onDocPointerUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== drag.pointerId) return;
        drag.pointerX = upEvent.clientX;
        drag.pointerY = upEvent.clientY;
        updateDragPosition();
        armClickGuardClear('pointer');

        const rows = sortableRows(list);
        const sortableIds = rows.map((el) => el.dataset.entry!).filter(Boolean);
        const anchor = dropAnchor(sortableIds, drag.entryId, drag.insertBeforeId);
        if (!anchor) {
          cancelToSlot(false);
          return;
        }

        const draggedFromRect = drag.itemEl.getBoundingClientRect();
        const beforeRects = captureRects(list);
        const beforeScroll = captureScroll(list);
        const referenceNode = drag.insertBeforeId ? rowById(list, drag.insertBeforeId) : null;

        teardown();
        drag.itemEl.setAttribute('data-settling', 'true');
        moveNodeBefore(list, drag.itemEl, referenceNode);

        const nextRows = sortableRows(list);
        const newIndex = nextRows.findIndex((el) => el.dataset.entry === drag.entryId);

        pendingFlipRef.current = {
          movedId: drag.entryId,
          beforeRects,
          beforeScroll,
          draggedFromRect,
          scaleFrom: 1.02,
        };
        bumpLayout();

        callbacksRef.current.onCommitMove(drag.entryId, anchor.afterEntryId, drag.title);
        if (newIndex >= 0) {
          callbacksRef.current.onAnnounce(
            `Moved “${drag.title}” to position ${newIndex + 1} of ${nextRows.length}.`,
          );
        }
      };

      updateDragPosition();
      document.addEventListener('pointermove', onDocPointerMove);
      document.addEventListener('pointerup', onDocPointerUp);
      document.addEventListener('pointercancel', onDocPointerCancel);
      document.addEventListener('keydown', onDocKeyDown, true);
      document.addEventListener('scroll', onDocScroll, true);
      handleEl.addEventListener('lostpointercapture', onLostPointerCapture);
      drag.rafId = window.requestAnimationFrame(stepAutoScroll);
    },
    [animateReturnToSlot, armClickGuardClear, cancelKeyboardGrab, listRef, nextSettleToken],
  );

  const toggleKeyboardGrab = useCallback(
    (entryId: string) => {
      const current = displayItemsRef.current;
      if (current.length < 2) return;
      const grab = keyboardGrabRef.current;
      if (grab && grab.entryId === entryId) {
        commitKeyboardGrab(grab, true);
        return;
      }
      if (grab && grab.entryId !== entryId) {
        commitKeyboardGrab(grab, false);
      }
      const index = current.findIndex((item) => item.id === entryId);
      const item = index >= 0 ? current[index] : undefined;
      if (!item) return;
      callbacksRef.current.onStartInteraction?.();
      const originAfterEntryId = index === 0 ? null : current[index - 1]!.id;
      setKeyboardGrab({
        entryId: item.id,
        title: item.title,
        originAfterEntryId,
        currentAfterEntryId: originAfterEntryId,
      });
      callbacksRef.current.onAnnounce(
        `Grabbed “${item.title}”, position ${index + 1} of ${current.length}. Use Up and Down arrow keys to move, Space or Enter to drop, Escape to cancel.`,
      );
    },
    [commitKeyboardGrab],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, entryId: string) => {
      if (event.key === ' ' || event.key === 'Enter') {
        if (itemsRef.current.length < 2) return;
        event.preventDefault();
        armClickGuardClear('key');
        toggleKeyboardGrab(entryId);
        return;
      }

      const grab = keyboardGrabRef.current;
      if (!grab || grab.entryId !== entryId) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelKeyboardGrab();
        return;
      }

      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return;
      }

      event.preventDefault();
      const direction: Direction = event.key === 'ArrowUp' ? 'up' : 'down';
      const current = displayItemsRef.current;
      const index = current.findIndex((i) => i.id === entryId);
      const ids = current.map((i) => i.id);
      const anchor = moveAnchor(ids, index, direction);
      if (!anchor) return;

      const list = listRef.current;
      const nextIndex = direction === 'up' ? index - 1 : index + 1;
      const itemObj = current[index]!;
      let usedNative = true;

      if (list) {
        const itemEl = rowById(list, entryId);
        const handleEl = event.currentTarget;
        if (itemEl) {
          const beforeRects = captureRects(list);
          const beforeScroll = captureScroll(list);
          const refId = direction === 'up' ? ids[index - 1]! : (ids[index + 2] ?? null);
          const referenceNode = refId ? rowById(list, refId) : null;

          movingFocusRef.current = true;
          usedNative = moveNodeBefore(list, itemEl, referenceNode);
          if (!usedNative || document.activeElement !== handleEl) {
            handleEl.focus({ preventScroll: true });
          }
          movingFocusRef.current = false;

          pendingFlipRef.current = {
            movedId: entryId,
            beforeRects,
            beforeScroll,
            focusTarget: handleEl,
          };
        }
      }

      setKeyboardGrab({ ...grab, currentAfterEntryId: anchor.afterEntryId });
      callbacksRef.current.onAnnounce(
        `Moved “${itemObj.title}” ${direction} to position ${nextIndex + 1} of ${current.length}.`,
        usedNative ? 100 : 500,
      );
    },
    [armClickGuardClear, cancelKeyboardGrab, listRef, toggleKeyboardGrab],
  );

  const handleClick = useCallback(
    (_event: ReactMouseEvent<HTMLButtonElement>, entryId: string) => {
      if (pointerClickGuardRef.current) {
        pointerClickGuardRef.current = false;
        return;
      }
      if (keyClickGuardRef.current) {
        keyClickGuardRef.current = false;
        return;
      }
      // Virtual click from assistive tech without pointerdown or keydown.
      toggleKeyboardGrab(entryId);
    },
    [toggleKeyboardGrab],
  );

  const handleBlur = useCallback(
    (_event: ReactFocusEvent<HTMLButtonElement>, entryId: string) => {
      if (movingFocusRef.current) return;
      const grab = keyboardGrabRef.current;
      if (!grab || grab.entryId !== entryId) return;
      commitKeyboardGrab(grab, false);
    },
    [commitKeyboardGrab],
  );

  const handleListFocus = useCallback((event: ReactFocusEvent<HTMLUListElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    let isFocusVisible = false;
    try {
      isFocusVisible = target.matches(':focus-visible');
    } catch {
      return;
    }
    if (!isFocusVisible) return;
    const row = target.closest<HTMLElement>('.adm-row');
    if (!row) return;
    if (typeof row.getAnimations === 'function' && row.getAnimations().length > 0) return;
    if (typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, []);

  const moveByButton = useCallback(
    (entryId: string, direction: Direction, clickedButton?: HTMLElement | null) => {
      if (keyboardGrabRef.current) cancelKeyboardGrab({ silent: true });
      const current = displayItemsRef.current;
      const index = current.findIndex((item) => item.id === entryId);
      const ids = current.map((item) => item.id);
      const anchor = moveAnchor(ids, index, direction);
      if (!anchor || index < 0) return;

      const nextIndex = direction === 'up' ? index - 1 : index + 1;
      const itemObj = current[index]!;
      const list = listRef.current;
      let usedNative = true;

      if (list) {
        const itemEl = rowById(list, entryId);
        if (itemEl) {
          const hadFocus = Boolean(clickedButton && document.activeElement === clickedButton);
          const hitBoundary =
            (direction === 'up' && nextIndex === 0) ||
            (direction === 'down' && nextIndex === current.length - 1);
          const nextDir: Direction = hitBoundary ? (direction === 'up' ? 'down' : 'up') : direction;
          const focusTarget = hadFocus
            ? itemEl.querySelector<HTMLElement>(
                `[data-adm-move-queue="${queue}"][data-adm-move-id="${CSS.escape(entryId)}"][data-adm-move-dir="${nextDir}"]`,
              )
            : null;

          const beforeRects = captureRects(list);
          const beforeScroll = captureScroll(list);
          const refId = direction === 'up' ? ids[index - 1]! : (ids[index + 2] ?? null);
          const referenceNode = refId ? rowById(list, refId) : null;

          usedNative = moveNodeBefore(list, itemEl, referenceNode);
          if (focusTarget) focusTarget.focus({ preventScroll: true });

          pendingFlipRef.current = {
            movedId: entryId,
            beforeRects,
            beforeScroll,
            focusTarget,
          };
          bumpLayout();
        }
      }

      callbacksRef.current.onCommitMove(entryId, anchor.afterEntryId, itemObj.title);
      callbacksRef.current.onAnnounce(
        `Moved “${itemObj.title}” ${direction} to position ${nextIndex + 1} of ${current.length}.`,
        usedNative ? 100 : 500,
      );
    },
    [cancelKeyboardGrab, listRef, queue],
  );

  return {
    displayItems,
    grabbedId: keyboardGrab?.entryId ?? null,
    handlePointerDown,
    handleKeyDown,
    handleBlur,
    handleClick,
    handleListFocus,
    moveByButton,
    cancelKeyboardGrab,
  };
}
