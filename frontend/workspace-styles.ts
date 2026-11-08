const SAVED_MEDIA = 'data-socl-media-before-effects';

function legacyLinks(): HTMLLinkElement[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter(link => {
    if (link.id === 'socl-legacy-styles') return true;
    try { return new URL(link.href, document.baseURI).pathname === '/legacy/styles.css'; }
    catch { return false; }
  });
}

/** Keep the stylesheet loaded. Toggling disabled can leave WebView2 without
 * the sheet when returning, especially if HMR replaced the captured link. */
export function suspendClippingStyles(): () => void {
  for (const link of legacyLinks()) {
    link.setAttribute(SAVED_MEDIA, JSON.stringify(link.getAttribute('media')));
    link.disabled = false;
    link.media = 'not all';
  }
  return () => {
    let links = legacyLinks();
    if (links.length === 0) {
      const link = document.createElement('link');
      link.id = 'socl-legacy-styles'; link.rel = 'stylesheet'; link.href = '/legacy/styles.css';
      document.head.append(link); links = [link];
    }
    // Query live links again: Vite/WebView2 may have replaced the original node.
    for (const link of links) {
      let media: string | null = null;
      try { media = JSON.parse(link.getAttribute(SAVED_MEDIA) ?? 'null'); } catch { /* restore default media */ }
      if (media === null) link.removeAttribute('media'); else link.media = media;
      link.disabled = false;
      if (link.sheet) link.sheet.disabled = false;
      link.removeAttribute(SAVED_MEDIA);
    }
  };
}
