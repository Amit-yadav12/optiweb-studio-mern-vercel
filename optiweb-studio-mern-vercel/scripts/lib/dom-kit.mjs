/**
 * A document for tests that mount real screens without a browser.
 *
 * The page gets a document and its element classes from jsdom. `fetch`,
 * `FormData`, `File`, `Blob` and `URL` stay Node's own. jsdom does not lay
 * out, paint or save files, so these tests cover what a screen requests,
 * shows and links to, not how it looks.
 */
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function createDom(url = "http://localhost/app/images") {
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => pageErrors.push(String(error?.message ?? error)));
  const { window } = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url, pretendToBeVisual: true, virtualConsole });
  for (const name of ["window", "document", "navigator", "location", "history", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "SVGElement", "DocumentFragment", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
  }
  const { document } = window;

  // A download is started by clicking a temporary link. jsdom cannot save files, so record what would be saved.
  const downloads = [];
  window.HTMLAnchorElement.prototype.click = function click() {
    downloads.push({ href: this.getAttribute("href") ?? "", name: this.download });
  };

  const text = () => document.body.textContent.replace(/\s+/g, " ");
  const html = () => document.body.innerHTML;
  async function waitFor(condition, timeoutMs = 20_000) {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
      if (await condition()) return true;
      await sleep(20);
    }
    return Boolean(await condition());
  }
  const labelOf = (element) => (element.getAttribute("aria-label") ?? element.textContent).trim();
  const buttonLabels = () => Array.from(document.querySelectorAll("button")).map(labelOf);
  const findButton = (label) => Array.from(document.querySelectorAll("button")).find((element) => (label instanceof RegExp ? label.test(labelOf(element)) : labelOf(element) === label)) ?? null;
  /** Clicks the button with this label. False when there is none. */
  function press(label) {
    const element = findButton(label);
    element?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    return element !== null;
  }
  /** Puts files into the file picker, as choosing them in the dialog does. */
  function chooseFiles(files) {
    const input = document.querySelector('input[type="file"]');
    if (!input) return false;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    return true;
  }
  return { window, document, pageErrors, downloads, text, html, waitFor, buttonLabels, findButton, press, chooseFiles };
}

/** Loads a module of the app through Vite, so that aliases, JSX and `import.meta.env` work as in the build. */
export async function createModuleLoader() {
  const { createServer } = await import("vite");
  // `envDir` points at a directory without .env files, so a developer's local
  // VITE_API_BASE_URL cannot redirect the requests of a test.
  const vite = await createServer({
    root: appDir,
    envDir: path.join(appDir, "scripts", "lib"),
    appType: "custom",
    logLevel: "error",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  return { load: (modulePath) => vite.ssrLoadModule(modulePath), close: () => vite.close() };
}
