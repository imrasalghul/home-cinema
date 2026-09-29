import { useEffect } from 'react';

export type Direction = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';
export type Box = { left: number; right: number; top: number; bottom: number };

export function isTvBrowser(userAgent: string) {
  return /Smart[- ]?TV|HbbTV|NetCast|Viera|BRAVIA|Web0S|WebOS.*TV|Google\s?TV|Android TV|Android.*(?:SHIELD|\bTV\b)|\bAFT\w+|VIDAA|Hisense|NetTV|Opera TV|OMI\/|AppleTV|tvOS|Roku/i.test(userAgent);
}

export function remoteKey(key: string, code: number): string {
  if (['Back', 'GoBack', 'BrowserBack'].includes(key) || [10009, 461].includes(code)) return 'Escape';
  if (['Select', 'Accept', 'OK'].includes(key)) return 'Enter';
  if (['Left', 'Right', 'Up', 'Down'].includes(key)) return `Arrow${key}`;
  if (key && key !== 'Unidentified') return key;
  return ({ 13: 'Enter', 27: 'Escape', 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 415: 'MediaPlay', 19: 'MediaPause', 10252: 'MediaPlayPause' } as Record<number, string>)[code] || key;
}

// Prefer the same row/column, including cards outside a scroll container's viewport.
export function nextInDirection<T>(origin: Box, items: Array<{ item: T; box: Box }>, direction: Direction): T | undefined {
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight';
  const forward = direction === 'ArrowRight' || direction === 'ArrowDown' ? 1 : -1;
  const center = (box: Box) => horizontal ? (box.left + box.right) / 2 : (box.top + box.bottom) / 2;
  const cross = (box: Box) => horizontal ? (box.top + box.bottom) / 2 : (box.left + box.right) / 2;
  let best: { item: T; rank: number; distance: number } | undefined;
  for (const candidate of items) {
    const ahead = (center(candidate.box) - center(origin)) * forward;
    if (ahead <= 1) continue;
    const overlap = horizontal ? Math.min(origin.bottom, candidate.box.bottom) - Math.max(origin.top, candidate.box.top) : Math.min(origin.right, candidate.box.right) - Math.max(origin.left, candidate.box.left);
    const rank = overlap > 1 ? 0 : 1;
    const distance = ahead + Math.abs(cross(candidate.box) - cross(origin)) * 2;
    if (!best || rank < best.rank || rank === best.rank && distance < best.distance) best = { item: candidate.item, rank, distance };
  }
  return best?.item;
}

const targets = 'button,a[href],input,select,textarea,[tabindex],[role="slider"],[role="menuitem"],[role="menuitemradio"],[role="radio"]';
function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('[hidden],[inert],[aria-hidden="true"],[data-tv-skip]') || element.matches(':disabled,[aria-disabled="true"],input[type="hidden"]')) return false;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return true;
}
function candidates(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(targets)).filter(element => visible(element) &&
    (element.tabIndex >= 0 || element.matches('[role="menuitem"],[role="menuitemradio"],[role="radio"]')) &&
    !element.matches('[role="region"][tabindex]'));
}

export function installTvNavigation() {
  const option = new URLSearchParams(location.search).get('tv');
  let preference: string | null = null;
  try {
    if (option === '1' || option === '0') localStorage.setItem('home-cinema.tv', option);
    preference = localStorage.getItem('home-cinema.tv');
  } catch { /* TV browsers can disable storage. */ }
  if ((option || preference) === '0' || !((option || preference) === '1' || isTvBrowser(navigator.userAgent))) return () => {};
  const html = document.documentElement;
  html.dataset.tvNavigation = 'true';
  let previousScope: ParentNode = document;
  const restore = new Map<ParentNode, HTMLElement>();
  let lastFocus: HTMLElement | null = null;
  let frame = 0;
  const scope = (): ParentNode => {
    const fullscreen = document.fullscreenElement;
    const root = fullscreen || document;
    const dialogs = Array.from(root.querySelectorAll<HTMLElement>('[aria-modal="true"],[data-tv-scope]')).filter(visible);
    return dialogs.at(-1) || root;
  };
  const focus = (element?: HTMLElement) => {
    if (!element) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    lastFocus = element;
  };
  const repairFocus = () => {
    frame = 0;
    const root = scope();
    const active = document.activeElement as HTMLElement | null;
    if (root !== previousScope) {
      if (root !== document && !restore.has(root) && lastFocus && !(root as Element).contains(lastFocus)) restore.set(root, lastFocus);
      const closing = previousScope !== document && (!(previousScope as Element).isConnected || !visible(previousScope as HTMLElement));
      const returning = closing ? restore.get(previousScope) : undefined;
      if (closing) restore.delete(previousScope);
      previousScope = root;
      if (returning && visible(returning) && (root === document || (root as Element).contains(returning))) { focus(returning); return; }
    }
    if (!active || !visible(active) || active === document.body || root !== document && !(root as Element).contains(active)) focus(candidates(root)[0]);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(repairFocus); };
  const remember = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement)) return;
    const root = scope();
    // React autofocus can run before the mutation observer sees a new dialog.
    if (root !== previousScope && root !== document && !restore.has(root) && lastFocus && !(root as Element).contains(lastFocus)) restore.set(root, lastFocus);
    lastFocus = event.target;
  };
  const consume = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const onKey = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const key = remoteKey(event.key, event.keyCode);
    const active = document.activeElement as HTMLElement | null;
    const root = scope();
    if (key === 'Escape') {
      // Let the player's menus dismiss themselves before closing their containing dialog.
      if (active?.closest('[role="menu"],[role="listbox"],[data-popup-open]')) {
        if (event.key !== 'Escape') { consume(event); active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }
        return;
      }
      if (document.fullscreenElement) { consume(event); void document.exitFullscreen().catch(() => {}); return; }
      const close = root !== document ? (root as Element).querySelector<HTMLElement>('[data-tv-close]') : null;
      if (close && visible(close)) { consume(event); if (!event.repeat) close.click(); return; }
      const search = document.querySelector<HTMLElement>('.header-search-toggle[aria-expanded="true"]');
      if (search) { consume(event); search.click(); focus(search); return; }
      const back = Array.from(document.querySelectorAll<HTMLElement>('.back-link')).find(visible);
      if (back) { consume(event); if (!event.repeat) back.click(); return; }
      return; // At the top level the TV/browser owns Back (including exiting the app).
    }
    if (key.startsWith('Media')) {
      const container = active?.closest('[data-tv-player]') || Array.from(document.querySelectorAll<HTMLElement>('[data-tv-player]')).filter(visible).at(-1);
      if (container) { consume(event); if (!event.repeat) container.dispatchEvent(new CustomEvent('tv-media-key', { detail: key })); }
      return;
    }
    if (key === 'Enter') {
      if (!active || active === document.body) { consume(event); repairFocus(); return; }
      // Native controls own Enter so selects and the TV's on-screen keyboard continue working.
      if (active.matches('input,select,textarea,[contenteditable="true"]')) return;
      if (active.matches('button,a[href],[role="button"],[role="menuitem"],[role="menuitemradio"],[role="radio"]')) { consume(event); if (!event.repeat) active.click(); }
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;
    const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
    if (active?.closest('[role="menu"],[role="listbox"]')) return;
    if (active?.matches('textarea,[contenteditable="true"]')) return;
    if (active?.matches('input:not([type="range"])') && horizontal) return;
    if (active?.matches('select') && !horizontal) return;
    if (active?.matches('[role="slider"],input[type="range"]') && (active.getAttribute('aria-orientation') === 'vertical' ? !horizontal : horizontal)) return;
    consume(event);
    const options = candidates(root);
    if (!active || !options.includes(active)) { focus(options[0]); return; }
    focus(nextInDirection(active.getBoundingClientRect(), options.filter(el => el !== active).map(item => ({ item, box: item.getBoundingClientRect() })), key as Direction));
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('focusin', remember);
  document.addEventListener('fullscreenchange', schedule);
  // Standard-mapped Bluetooth controllers use the same focus/navigation path.
  let held = '';
  let repeatAt = 0;
  const gamepadTimer = window.setInterval(() => {
    let key = '';
    try {
      for (const pad of navigator.getGamepads?.() || []) {
        if (!pad || pad.mapping !== 'standard') continue;
        key = pad.buttons[12]?.pressed || pad.axes[1] < -.6 ? 'ArrowUp' : pad.buttons[13]?.pressed || pad.axes[1] > .6 ? 'ArrowDown' : pad.buttons[14]?.pressed || pad.axes[0] < -.6 ? 'ArrowLeft' : pad.buttons[15]?.pressed || pad.axes[0] > .6 ? 'ArrowRight' : pad.buttons[0]?.pressed ? 'Enter' : pad.buttons[1]?.pressed ? 'Escape' : '';
        if (key) break;
      }
    } catch { return; }
    const now = performance.now();
    if (key && (key !== held || key.startsWith('Arrow') && now >= repeatAt)) {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      repeatAt = now + (key !== held ? 350 : 150);
    }
    held = key;
  }, 50);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  schedule();
  return () => {
    delete html.dataset.tvNavigation;
    cancelAnimationFrame(frame); observer.disconnect();
    window.clearInterval(gamepadTimer);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('focusin', remember);
    document.removeEventListener('fullscreenchange', schedule);
  };
}

export function useTvNavigation() { useEffect(installTvNavigation, []); }
