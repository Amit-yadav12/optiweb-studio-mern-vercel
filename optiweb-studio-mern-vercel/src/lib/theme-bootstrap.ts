/**
 * Theme bootstrap — must run before first paint.
 *
 * Resolution order: an explicit choice stored in localStorage wins; otherwise the
 * OS `prefers-color-scheme` is used. Rendered as a blocking inline script in
 * <head> so the correct palette is applied before the first frame and the page
 * never flashes the wrong theme.
 */
export const THEME_STORAGE_KEY = "ow-theme";

export const themeBootstrapScript = `
(function () {
  try {
    var stored = localStorage.getItem("${THEME_STORAGE_KEY}");
    var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    var theme = stored === "light" || stored === "dark" ? stored : prefersDark ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
  } catch (error) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
`;

/** Keeps the OS preference in sync when the user has not made an explicit choice. */
export const themeSyncScript = `
(function () {
  try {
    var stored = localStorage.getItem("${THEME_STORAGE_KEY}");
    if (stored === "light" || stored === "dark") return;
    var media = window.matchMedia("(prefers-color-scheme: dark)");
    var apply = function () {
      document.documentElement.setAttribute("data-theme", media.matches ? "dark" : "light");
    };
    apply();
    if (media.addEventListener) media.addEventListener("change", apply);
  } catch (error) {
    /* no-op */
  }
})();
`;
