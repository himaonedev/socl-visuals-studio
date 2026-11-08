// Generated from frontend/legacy-src/status-disclosure.ts by scripts/backend.cjs. Edit the TypeScript source.
(function (root) {
    'use strict';
    function setLogOpen({ fold, log, button }, open) {
        if (!fold || !log || !button)
            return false;
        fold.hidden = !open;
        log.hidden = !open;
        button.textContent = open ? '▴ Log' : '▾ Log';
        button.setAttribute('aria-expanded', String(open));
        return open;
    }
    function toggleLog(ui) {
        return setLogOpen(ui, !!ui?.fold?.hidden);
    }
    const api = { setLogOpen, toggleLog };
    if (typeof module !== 'undefined' && module.exports)
        module.exports = api;
    else
        root.StatusDisclosure = api;
})(typeof self !== 'undefined' ? self : this);
