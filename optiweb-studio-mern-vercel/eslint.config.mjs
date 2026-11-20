import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        Blob: "readonly",
        Buffer: "readonly",
        File: "readonly",
        FormData: "readonly",
        ReadableStream: "readonly",
        Request: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        structuredClone: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        performance: "readonly",
        // The browser tests pass functions to the page with `page.evaluate`; these names exist there.
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        location: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        createImageBitmap: "readonly",
        OffscreenCanvas: "readonly",
        Image: "readonly",
        MouseEvent: "readonly",
        DataTransfer: "readonly",
        HTMLElement: "readonly",
        HTMLCanvasElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        getComputedStyle: "readonly",
        Navigator: "readonly",
        XMLHttpRequest: "readonly",
        Event: "readonly",
        DragEvent: "readonly",
        MutationObserver: "readonly",
        requestAnimationFrame: "readonly",
        indexedDB: "readonly",
        caches: "readonly",
        atob: "readonly",
        btoa: "readonly",
        Headers: "readonly",
        queueMicrotask: "readonly",
      },
    },
  },
  {
    // Loaded by index.html before the app, as a classic script.
    files: ["public/**/*.js"],
    languageOptions: { sourceType: "script", globals: { document: "readonly", window: "readonly", localStorage: "readonly" } },
    rules: { "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }] },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-explicit-any": "warn"
    }
  }
);
