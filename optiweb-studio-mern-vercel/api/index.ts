/**
 * Vercel Function entry for the OptiWeb Studio API.
 *
 * `vercel.json` rewrites every `/api/*` request to this single function, and the
 * shared Express app then routes on the original request path. The app is
 * exported directly (not wrapped) so Vercel hands Express the untouched request
 * stream: multipart boundaries and binary image bytes must reach the raw body
 * parser exactly as the browser sent them.
 *
 * The Vite frontend is not served from here. Vercel's CDN serves `dist/` and
 * falls back to `index.html` for client-side routes.
 */
import app from "../src/app.js";

export default app;
