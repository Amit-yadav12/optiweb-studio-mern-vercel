/**
 * Response headers that every page and every API answer carries.
 *
 * The Content-Security-Policy is part of the privacy design, not decoration:
 * `connect-src 'self'` and `form-action 'self'` make the browser itself refuse
 * to send anything from these pages to another origin. Together with the fact
 * that this origin has no route that accepts a file, a selected file has
 * nowhere to go.
 *
 * `vercel.json` and `netlify.toml` repeat these values for the static files
 * those hosts serve. `npm run test:security` fails when the three disagree.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' allows the AVIF and WebP codecs (WebAssembly served from this origin). It does not allow eval().
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // blob: is how a file that exists only in this tab is previewed and saved.
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};
