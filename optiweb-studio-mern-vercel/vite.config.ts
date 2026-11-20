import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

/**
 * The public address of the site being built, when the build host says what it
 * is: `SITE_URL` if set, else Netlify's `URL`, else Vercel's production domain.
 * Null for a local build.
 */
function siteUrl(): string | null {
  const value =
    process.env.SITE_URL ??
    (process.env.NETLIFY === "true" ? process.env.URL : undefined) ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined);
  return value && /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(value) ? value.replace(/\/$/, "") : null;
}

/**
 * Social networks fetch the preview image from an absolute URL. The page
 * names it by path, so that the same source builds for any host; this turns
 * the path into a full address when the host is known.
 */
function absoluteSocialImage(): Plugin {
  return {
    name: "unikit-absolute-social-image",
    transformIndexHtml(html) {
      const site = siteUrl();
      return site ? html.replaceAll('content="/og-image.png"', `content="${site}/og-image.png"`) : html;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), absoluteSocialImage()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // The image worker loads its codecs on demand, which needs a module worker.
  worker: { format: "es" },
  // The codecs locate their .wasm files relative to their own modules. Pre-bundling would move the modules and break that.
  optimizeDeps: { exclude: ["@jsquash/avif", "@jsquash/webp"] },
  server: {
    host: "0.0.0.0",
    // Arena's HTTPS preview uses a sandbox subdomain; allow that suffix while
    // retaining Vite's normal Host checks for every other hostname.
    allowedHosts: [".e2b.app"],
    port: 5173,
    proxy: { "/api": { target: process.env.DEV_API_URL ?? "http://localhost:5000", changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: false, assetsDir: "assets" },
});
