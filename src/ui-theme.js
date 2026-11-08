// Generated from frontend/legacy-src/ui-theme.ts by scripts/backend.cjs. Edit the TypeScript source.
// Lime-Glass v3 — theme + OS attribute wiring.
// Loaded only by the v3 index.html (classic has no toggle). Runs before
// renderer.js so the first paint already uses the saved theme (no flash).
(() => {
    const root = document.documentElement;
    // data-os hook for platform-specific CSS (safe-areas, font tweaks).
    const plat = (navigator.platform || '').toLowerCase();
    root.dataset.os = plat.includes('mac') ? 'mac' : plat.includes('win') ? 'win' : 'linux';
    const KEY = 'soclUiTheme'; // 'dark' (default) | 'light'
    let theme = 'dark';
    try {
        if (localStorage.getItem(KEY) === 'light')
            theme = 'light';
    }
    catch { }
    const apply = () => {
        if (theme === 'light')
            root.dataset.theme = 'light';
        else
            delete root.dataset.theme;
        const btn = document.getElementById('themeToggle');
        if (btn) {
            btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
            btn.classList.toggle('is-light', theme === 'light');
        }
    };
    apply();
    const setupControls = () => {
        apply();
        document.getElementById('themeToggle')?.addEventListener('click', (e) => {
            theme = theme === 'light' ? 'dark' : 'light';
            try {
                localStorage.setItem(KEY, theme);
            }
            catch { }
            apply();
            // Mouse click: drop focus, or the app's F/Esc/Space shortcuts count as
            // keyboard use and draw a focus ring on this button. Keyboard keeps it.
            if (e.detail > 0 && e.currentTarget instanceof HTMLElement)
                e.currentTarget.blur();
        });
    };
    if (document.readyState === 'loading')
        window.addEventListener('DOMContentLoaded', setupControls, { once: true });
    else
        setupControls();
})();
