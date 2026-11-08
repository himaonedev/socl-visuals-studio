import { suspendClippingStyles } from '../workspace-styles';

afterEach(() => { document.querySelectorAll('link').forEach(link => link.remove()); });

it('restores clipping CSS across repeated effects/back switches', () => {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/legacy/styles.css'; link.media = 'screen';
  document.head.append(link);
  for (let i = 0; i < 3; i++) {
    const restore = suspendClippingStyles();
    expect(link.disabled).toBe(false);
    expect(link.media).toBe('not all');
    restore();
    expect(link.disabled).toBe(false);
    expect(link.media).toBe('screen');
  }
});

it('restores the live stylesheet when HMR replaced the original link', () => {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = '/legacy/styles.css?t=1';
  document.head.append(link);
  const restore = suspendClippingStyles();
  const replacement = link.cloneNode() as HTMLLinkElement;
  replacement.href = '/legacy/styles.css?t=2'; replacement.disabled = true;
  link.replaceWith(replacement);
  restore();
  expect(replacement.disabled).toBe(false);
  expect(replacement.hasAttribute('media')).toBe(false);
});

it('recovers the clipping stylesheet if its link disappeared', () => {
  const restore = suspendClippingStyles();
  restore();
  const link = document.querySelector<HTMLLinkElement>('#socl-legacy-styles')!;
  expect(link.getAttribute('href')).toBe('/legacy/styles.css');
  expect(link.disabled).toBe(false);
});
