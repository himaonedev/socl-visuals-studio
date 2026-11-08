// Pure state transition for the pipeline Log disclosure.
interface LegacyLogControls { fold?: HTMLElement | null; log?: HTMLElement | null; button?: HTMLElement | null }
declare var StatusDisclosure: { setLogOpen(ui: LegacyLogControls, open: boolean): boolean; toggleLog(ui: LegacyLogControls): boolean };
(function (root: typeof globalThis) {
  'use strict';

  function setLogOpen({ fold, log, button }: LegacyLogControls, open: boolean): boolean {
    if (!fold || !log || !button) return false;
    fold.hidden = !open;
    log.hidden = !open;
    button.textContent = open ? '▴ Log' : '▾ Log';
    button.setAttribute('aria-expanded', String(open));
    return open;
  }

  function toggleLog(ui: LegacyLogControls): boolean {
    return setLogOpen(ui, !!ui?.fold?.hidden);
  }

  const api = { setLogOpen, toggleLog };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StatusDisclosure = api;
})(typeof self !== 'undefined' ? self : this);
