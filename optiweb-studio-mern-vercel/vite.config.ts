import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
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
