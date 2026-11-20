/**
 * A document for tests that mount real screens without a browser.
 *
 * The page gets a document and its element classes from jsdom. `File`, `Blob`
 * and `URL` stay Node's own, so files have real sizes and `blob:` URLs really
 * point at their bytes. jsdom does not lay out, paint, decode images or save
 * files, so these tests cover what a screen shows, links to and hands to its
 * engine, not how it looks and not what a browser's codecs produce.
 */
import path from "node:path";
import { resolveObjectURL } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function createDom(url = "http://localhost/app/images") {
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => pageErrors.push(String(error?.message ?? error)));
  const { window } = new JSDOM('<!doctype html><html lang="en"><body><div id="root"></div></body></html>', { url, pretendToBeVisual: true, virtualConsole });
  for (const name of ["window", "document", "navigator", "location", "history", "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLAnchorElement", "SVGElement", "DocumentFragment", "Event", "MouseEvent", "KeyboardEvent", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    Object.defineProperty(globalThis, name, { value: window[name], configurable: true, writable: true });
  }
  const { document } = window;

  // Anything that could carry data out of the page is replaced by a recorder.
  // A screen that processes files locally never calls one of them.
  const network = [];
  const refuse = (api) => (...args) => {
    network.push({ api, target: String(args[0]?.url ?? args[0] ?? "") });
    throw new Error(`${api} was called in a test that allows no network use`);
  };
  globalThis.fetch = refuse("fetch");
  for (const api of ["XMLHttpRequest", "WebSocket", "EventSource"]) {
    const Refused = function Refused(...args) { refuse(api)(...args); };
    Object.defineProperty(globalThis, api, { value: Refused, configurable: true, writable: true });
    Object.defineProperty(window, api, { value: Refused, configurable: true, writable: true });
  }
  Object.defineProperty(window.navigator, "sendBeacon", { value: refuse("sendBeacon"), configurable: true });

  // blob: URLs are counted, so a test can see that every one is released.
  const liveUrls = new Set();
  let urlsCreated = 0;
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const made = createObjectURL(blob);
    liveUrls.add(made);
    urlsCreated += 1;
    return made;
  };
  URL.revokeObjectURL = (target) => {
    liveUrls.delete(target);
    revokeObjectURL(target);
  };

  // A download is started by clicking a temporary link. jsdom cannot save
  // files, so the click records what would be saved: the name, and the Blob
  // the link's blob: URL points at, read at the moment of the click.
  const downloads = [];
  window.HTMLAnchorElement.prototype.click = function click() {
    const href = this.getAttribute("href") ?? "";
    downloads.push({ href, name: this.download, blob: href.startsWith("blob:") ? (resolveObjectURL(href) ?? null) : null });
  };

  /** The visible text of an element, with whitespace collapsed. Empty for an element that is not there. */
  const text = (root = document.body) => (root ? root.textContent.replace(/\s+/g, " ").trim() : "");
  async function waitFor(condition, timeoutMs = 10_000) {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
      if (await condition()) return true;
      await sleep(10);
    }
    return Boolean(await condition());
  }
  const labelOf = (element) => (element.getAttribute("aria-label") ?? element.textContent).replace(/\s+/g, " ").trim();
  const buttons = () => Array.from(document.querySelectorAll('button, [role="radio"]'));
  const buttonLabels = () => buttons().map(labelOf);
  const findButton = (label) => buttons().find((element) => (label instanceof RegExp ? label.test(labelOf(element)) : labelOf(element) === label)) ?? null;
  /** Clicks the button with this label. False when there is none, or when it is disabled. */
  function press(label) {
    const element = findButton(label);
    if (!element || element.disabled) return false;
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    return true;
  }
  /** Puts files into the file picker, as choosing them in the dialog does. */
  function chooseFiles(files) {
    const input = document.querySelector('input[type="file"]');
    if (!input) return false;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    return true;
  }
  /** Types a value into a field the way React notices: through the element's own setter, then an input event. */
  function setValue(selector, value) {
    const input = document.querySelector(selector);
    if (!input) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, String(value));
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    return true;
  }
  /**
   * Presses a button once it is there and enabled, then lets React apply the
   * update. React applies the state changes of a click in a microtask, so two
   * presses in a row need this between them.
   */
  async function tap(label, timeoutMs = 3_000) {
    const there = await waitFor(() => {
      const element = findButton(label);
      return element !== null && !element.disabled;
    }, timeoutMs);
    if (there) press(label);
    await sleep(0);
    return there;
  }
  return { window, document, pageErrors, downloads, network, liveUrls, urlsCreated: () => urlsCreated, text, waitFor, buttonLabels, findButton, press, tap, chooseFiles, setValue };
}

/** Loads a module of the app through Vite, so that aliases, JSX and `import.meta.env` work as in the build. */
export async function createModuleLoader() {
  const { createServer } = await import("vite");
  // `envDir` points at a directory without .env files, so a developer's local settings cannot change a test.
  const vite = await createServer({
    root: appDir,
    envDir: path.join(appDir, "scripts", "lib"),
    appType: "custom",
    logLevel: "error",
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    // Packages are loaded as the ES modules they publish for Node ("module-sync"). Without this the router's
    // CommonJS build is picked, and not all of its named exports can be seen from an import statement.
    ssr: { resolve: { externalConditions: ["module-sync", "node"] } },
  });
  return { load: (modulePath) => vite.ssrLoadModule(modulePath), close: () => vite.close() };
}
