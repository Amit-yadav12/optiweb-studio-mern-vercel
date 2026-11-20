/* Applies the stored or system theme before first paint. Loaded as a blocking script from index.html. */
(function () {
  var root = document.documentElement;
  try {
    var saved = localStorage.getItem("unikit:theme");
    var dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.setAttribute("data-theme", saved === "light" || saved === "dark" ? saved : dark ? "dark" : "light");
    var settings = JSON.parse(localStorage.getItem("unikit:preferences") || "null");
    if (settings && settings.reduceMotion === true) root.classList.add("uk-reduce-motion");
  } catch (error) {
    if (!root.getAttribute("data-theme")) root.setAttribute("data-theme", "light");
  }
})();
