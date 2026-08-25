// Google Analytics (GA4) bootstrap.
//
// This is the standard gtag.js snippet, with the inline <script> half moved into this
// module instead of index.html on purpose: the Worker serves HTML with
// `script-src 'self'` (edge/src/index.ts, issue #11), which blocks inline scripts. Keeping
// the config here means it ships inside the bundle -- same-origin, so it runs without
// having to weaken the CSP with 'unsafe-inline'. The loader tag in index.html still points
// at googletagmanager.com, which is why that host is allowlisted in script-src.
//
// ponytail: no consent banner. Add one if this ever serves EU traffic under a policy that
// needs it -- GA4 has Consent Mode for exactly that.

export const GA_MEASUREMENT_ID = 'G-DHNFGES97B';

declare global {
  interface Window {
    dataLayer: unknown[];
  }
}

export function initAnalytics(): void {
  window.dataLayer = window.dataLayer || [];
  // Pushes the `arguments` object itself, exactly as Google's snippet does. This looks like
  // something a rest parameter should replace, and it isn't: gtag.js only treats an
  // Arguments object as a gtag command, and silently ignores a plain Array. Pushing
  // `[...args]` here made 'js'/'config' never register and GA report nothing at all, with
  // no console error to show for it. The cast supplies the call signature without declaring
  // parameters the body deliberately doesn't read.
  const gtag = function () {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer.push(arguments);
  } as (...args: unknown[]) => void;
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID);
}
