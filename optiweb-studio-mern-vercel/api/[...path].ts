/**
 * Vercel catch-all API function. The Vite frontend is deployed as static assets
 * from dist/ and served by Vercel's CDN; only /api/** reaches this Express app.
 */
import app from "../src/index";

export default app;
