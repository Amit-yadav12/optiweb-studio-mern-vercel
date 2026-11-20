/**
 * Vercel Function entry for the Unikit Studio API.
 *
 * `vercel.json` rewrites every `/api/*` request to this single function, and
 * the shared Express app then routes on the original request path.
 *
 * The Vite frontend is not served from here. Vercel's CDN serves `dist/` and
 * falls back to `index.html` for client-side routes.
 */
import app from "../src/app.js";

export default app;
