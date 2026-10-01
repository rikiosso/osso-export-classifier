// The site intro (operator, plan of 30-09-2026, built 01-10-2026): the 3.3 s
// OSSO EXPORT clip plays once per browser session over the page, then fades
// into it. Skippable (a button, a click anywhere, Esc). Never for a visitor
// who asked for reduced motion, never for a link that lands on something
// specific (?q= or a #anchor), and never when session storage is unavailable
// (it could not remember, so it would play on every page load).
// Loaded in <head>, before the page paints, so the page never flashes first.
(function () {
  "use strict";
  var KEY = "osso-intro-seen";
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (/[?&]q=/.test(location.search) || location.hash) return;
    if (sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(KEY, "1");
  } catch (e) {
    return;
  }
  var root = document.documentElement;
  root.classList.add("intro-on");

  function start() {
    var box = document.createElement("div");
    box.id = "intro";
    box.setAttribute("aria-hidden", "true");
    var video = document.createElement("video");
    video.src = "media/intro.mp4?v=3";
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.preload = "auto";
    var skip = document.createElement("button");
    skip.type = "button";
    skip.className = "intro-skip";
    skip.textContent = "Skip";
    box.appendChild(video);
    box.appendChild(skip);
    document.body.appendChild(box);

    var done = false;
    function finish() {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey);
      root.classList.add("intro-out");
      root.classList.remove("intro-on");
      setTimeout(function () {
        if (box.parentNode) box.parentNode.removeChild(box);
        root.classList.remove("intro-out");
        document.dispatchEvent(new Event("osso:intro-done")); // app.js opens its notice now
      }, 1000); // the drop (0.5 s), then the brown's fade (0.6 s from 0.3 s)
    }
    function onKey(ev) {
      if (ev.key === "Escape") finish();
    }
    video.addEventListener("ended", finish);
    video.addEventListener("error", finish);
    box.addEventListener("click", finish);
    document.addEventListener("keydown", onKey);
    setTimeout(finish, 6000); // a clip that stalls never holds the page
    var played = video.play();
    if (played && played.catch) played.catch(finish); // autoplay refused: straight to the page
  }

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
