"use strict";
/**
 * The client route viewer — "the spine".
 *
 * One exercise, followed as a route: a vertical rail with one node per
 * station, solid behind where the client is and dashed ahead. Cues, cautions
 * and options branch off the station they were said on. **Nothing advances on
 * a clock**: the client taps Next station. The only timed thing on the screen
 * is the hold timer, which starts itself (after a 5s "get into position"
 * lead-in) only when the client arrives at a hold by tapping Next.
 *
 * This file does not decide what a station is. The route — stations, their
 * branches, the lead-in, the hold targets, the labels — is built server-side
 * by App\Services\RouteViewerService and arrives on the payload as
 * `video.route`, because the printed sheet is rendered by mpdf and two
 * implementations of the same rules would eventually disagree between a
 * client's screen and their handout. What lives here is the painting and the
 * three pieces of state that only exist on a screen: which station you are on,
 * the hold timer, and whether the done run is folded away.
 *
 * Built once per exercise, painted on change. Never re-innerHTML the list on
 * advance: a replaced node cannot transition, and the step then snaps from
 * one size to the other with nothing in between — which is what made an
 * earlier prototype feel like a slideshow rather than an interface.
 *
 * Surfaces are chosen by the component's OWN width, not the viewport's. The
 * portal's grid, and on the app a 260px rail, both make a media query the
 * wrong instrument (the same lesson as the marketing site's price band).
 */
var KTRouteViewer = (function () {
  var DESK_FROM = 760;      // px of the component's own box
  var FOLD_BEHIND = 2;      // stations kept visible behind the current one

  var root = null;
  var i18n = {};
  var route = null;
  var at = 0;
  var unfolded = false;
  var LEAD_MS = 5000;       // "get into position" before an auto-started hold

  /* The hold, as one small state machine counted off the wall clock (a phone
     on the floor sleeps; an interval count would come back wrong).
     idle -> lead (auto-start only) -> run <-> paused; reset -> idle. Past the
     target it keeps counting, as overtime: every hold she gives is a minimum
     or a guide, never a cut-off. */
  var hp = "idle";          // idle | lead | run | paused
  var leadEnd = 0;
  var runFrom = 0;          // wall-clock ms the current run segment began
  var banked = 0;           // ms held in earlier segments (before a pause)
  var reachedSaid = false;
  var frame = null;
  var reduced = false;
  var observer = null;

  function fill(template, values) {
    return String(template || "").replace(/\{(\d)\}/g, function (match, n) {
      return values[n] !== undefined ? values[n] : match;
    });
  }

  function esc(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function q(sel) { return root ? root.querySelector(sel) : null; }
  function qa(sel) { return root ? Array.prototype.slice.call(root.querySelectorAll(sel)) : []; }

  function stations() { return route && route.stations ? route.stations : []; }

  /* ---------- building, once per exercise ---------- */

  function branchHtml(station) {
    if (!station.branch.length) return "";

    var rows = station.branch.map(function (row) {
      var cls = row.row === "caution" ? "is-caution" : (row.row === "option" ? "is-option" : "");
      // A caution that was MOVED here because her own words said it applies
      // throughout says so, or it reads as a warning about getting into
      // position rather than about the whole exercise.
      var standing = row.standing
        ? '<span class="rv-standing">(' + esc(i18n.cautionStanding) + ")</span>"
        : "";
      // Tag (pill + standing marker) and text are separate boxes so the
      // text can wrap to its own left edge instead of running back under
      // the pill.
      return '<li class="' + cls + '"><span class="rv-tag"><span class="rv-pill">' + esc(row.pill) + "</span>"
        + standing + '</span><span class="rv-text">' + esc(row.text) + "</span></li>";
    });

    return '<ul class="rv-branch">' + rows.join("") + "</ul>";
  }

  function holdCopy(hold) {
    if (hold.source === "dose") return fill(i18n.holdCopyPrescribed, [hold.secs]);
    if (hold.range) return fill(i18n.holdCopyRange, [hold.secs]);
    if (hold.hedge) return fill(i18n.holdCopyHedge, [hold.secs]);
    return fill(i18n.holdCopyPlain, [hold.secs]);
  }

  /* The hold: a status line (what is happening, and the target) with Reset
     at its end, then one row: a big bar that fills as you hold, and the button
     that does the next thing. The number sits on the bar with no backing tab:
     it is drawn twice, dark on the track and white inside the fill, and the
     fill is a clip rather than a scale, so the digits change colour exactly
     where the fill edge crosses them. Chosen over a dial
     (2026-10-05): it reads as a timer just as well and takes less height. */
  function holdHtml(hold) {
    // What the bar shows: the go icon and (paused only) the reset icon at the
    // left, the seconds at the right. Drawn twice - dark on the track, white
    // inside the fill - so each glyph changes colour exactly where the fill
    // edge crosses it.
    var face = '<span class="rv-hbar-face"><span class="rv-ico-go">' + ICON_PLAY + "</span>"
      + '<span class="rv-ico-reset">' + RESET_ICON + "</span>"
      + '<span class="rv-hold-n"><b>' + hold.secs + "</b><small>" + esc(i18n.holdSecs) + "</small></span></span>";
    return '<div class="rv-hold" data-phase="idle">'
      + '<div class="rv-hold-top"><p class="rv-hold-copy"><b class="rv-hold-head">' + esc(i18n.holdReady) + "</b> "
      // The target ("About 60 seconds.") is for screen readers only: the
      // station's own sentence states it and the bar shows the seconds, and
      // beside the state on one line it wrapped in every language at phone
      // width, moving the bar on each state change (measured 2026-10-05).
      + '<span class="rv-sr">' + esc(holdCopy(hold)) + "</span></p></div>"
      // The bar IS the control (owner, 2026-10-05): one button over the whole
      // bar starts / cancels / pauses / resumes, and once paused a second,
      // smaller button sits over the reset icon. Nothing beside the bar, so
      // its width never changes. The same on every surface.
      + '<div class="rv-hbar">' + face
      + '<span class="rv-hbar-fill" aria-hidden="true">' + face.replace('rv-hbar-face"', 'rv-hbar-face is-inv"') + "</span>"
      + '<button class="rv-hold-go" type="button" aria-label="' + esc(i18n.holdStart) + '"></button>'
      + '<button class="rv-hold-reset" type="button" hidden aria-label="' + esc(i18n.holdReset) + '" title="'
      + esc(i18n.holdReset) + '"></button>'
      + "</div></div>";
  }


  function build(title) {
    var list = stations();
    var n = list.length;
    var rails = '<span class="rv-seg rv-seg-up"></span>';

    q(".rv-title").textContent = title || "";
    q(".rv-meta").innerHTML = (route.meta || []).map(function (item) {
      return "<li>" + esc(item) + "</li>";
    }).join("");

    // One segment per station, in the header where the client looks first.
    // aria-hidden: it says nothing the position label does not. A station
    // carrying a caution keeps its marker as a colour on its segment, which is
    // what the old line's floating dots were for without the dots colliding
    // with the controls underneath.
    q(".rv-progress").innerHTML = list.map(function (station) {
      var care = station.branch.some(function (r) { return r.row === "caution"; });
      return '<li' + (care ? ' class="is-care"' : "") + "></li>";
    }).join("");
    // A class can run to 126 stations; past two dozen the gaps would be all
    // there is, so the bar closes up into one continuous fill.
    q(".rv-progress").classList.toggle("is-dense", n > 24);

    q(".rv-index").innerHTML = list.map(function (station, i) {
      var care = station.branch.some(function (r) { return r.row === "caution"; });
      var label = station.labelFull;
      var aria = fill(i18n.indexRowLabel, [i + 1, n, label])
        + (care ? ", " + i18n.indexHasCaution : "");
      return '<button class="rv-ix" type="button" data-go="' + i + '" aria-label="' + esc(aria) + '">'
        + "<b>" + (i + 1) + "</b><span>" + esc(label) + "</span>"
        + (care ? '<span class="rv-ix-care"></span>' : (station.hold ? '<span class="rv-ix-hold"></span>' : ""))
        + "</button>";
    }).join("");

    var html = "";

    // Said before she started: a lead-in, not a station. It folds away with
    // the rest once the client is past it.
    if (route.lead && route.lead.length) {
      html += '<li class="rv-lead-row is-done has-label"><div class="rv-rail">' + rails
        + '<span class="rv-node" aria-hidden="true"><span class="rv-dot"></span></span>'
        + '<span class="rv-seg rv-seg-dn"></span></div>'
        + '<div class="rv-body"><p class="rv-label">' + esc(route.leadHeading) + "</p>"
        + route.lead.map(function (line) {
          return '<p class="rv-leadin">' + esc(line) + "</p>";
        }).join("")
        + "</div></li>";
    }

    html += '<li class="rv-fold"><div class="rv-rail">' + rails
      + '<span class="rv-seg rv-seg-dn"></span></div><button type="button" class="rv-unfold"></button></li>';

    html += list.map(function (station, i) {
      return '<li data-i="' + i + '" class="' + (station.finish ? "is-finish " : "")
        + (station.label ? "has-label" : "") + '">'
        + '<div class="rv-rail">' + rails
        + '<button class="rv-node" type="button" data-go="' + i + '" aria-label="'
        + esc(fill(i18n.position, [i + 1, n])) + '"><span class="rv-dot"></span></button>'
        + '<span class="rv-seg rv-seg-dn"></span></div>'
        + '<div class="rv-body">'
        + (station.label ? '<p class="rv-label">' + esc(station.label) + "</p>" : "")
        + '<p class="rv-say">' + esc(station.text) + "</p>"
        + (station.hold ? holdHtml(station.hold) : "")
        + branchHtml(station)
        + "</div></li>";
    }).join("");

    q(".rv-spine").innerHTML = html;
  }

  /* ---------- painting, on every change ---------- */

  function paint() {
    var list = stations();
    var n = list.length;
    if (!n) return;

    at = Math.max(0, Math.min(at, n - 1));
    var hidden = unfolded ? 0 : Math.max(0, at - FOLD_BEHIND);

    qa(".rv-spine > li[data-i]").forEach(function (li) {
      var i = parseInt(li.getAttribute("data-i"), 10);
      li.classList.toggle("is-done", i < at);
      li.classList.toggle("is-now", i === at);
      li.classList.toggle("is-todo", i > at);
      li.classList.toggle("is-folded", i < hidden);
      if (i === at) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    });

    var leadRow = q(".rv-lead-row");
    if (leadRow) leadRow.classList.toggle("is-folded", hidden > 0);

    var fold = q(".rv-fold");
    var folded = hidden + (leadRow && hidden > 0 ? 1 : 0);
    fold.classList.toggle("is-on", hidden > 0);
    if (hidden > 0) {
      fold.querySelector("button").textContent = folded === 1
        ? i18n.foldSingular
        : fill(i18n.foldPlural, [folded]);
    }

    qa(".rv-ix").forEach(function (b, i) {
      b.classList.toggle("is-done", i < at);
      b.classList.toggle("is-now", i === at);
      if (i === at) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });

    qa(".rv-progress li").forEach(function (seg, i) {
      seg.classList.toggle("is-done", i < at);
      seg.classList.toggle("is-now", i === at);
    });
    paintHold();

    q(".rv-pos").textContent = fill(i18n.position, [at + 1, n]);
    var last = at === n - 1;
    var next = q(".rv-next");
    next.textContent = last ? i18n.routeFinished : i18n.nextStation;
    next.disabled = last;
    q(".rv-back").disabled = at === 0;

    scrollIntoPlace(fold);
  }

  /* The current station is parked a quarter of the way down rather than at the
     top, so the one before it stays on screen as context. */
  function scrollIntoPlace(fold) {
    var scroller = q(".rv-scroll");
    var current = scroller.querySelector("li[aria-current]");
    if (current) {
      var top = Math.max(0, current.offsetTop - Math.round(scroller.clientHeight * 0.26));
      if (fold.classList.contains("is-on") && top < fold.offsetTop + fold.offsetHeight) top = 0;
      scroller.scrollTo({ top: top, behavior: reduced ? "auto" : "smooth" });
    }

    if (root.getAttribute("data-surf") !== "desk") return;
    var index = q(".rv-index");
    var row = index.querySelector(".rv-ix.is-now");
    if (row) {
      index.scrollTo({ top: Math.max(0, row.offsetTop - 120), behavior: reduced ? "auto" : "smooth" });
    }
  }

  /* ---------- the hold ---------- */

  function currentHold() {
    var station = stations()[at];
    return station ? station.hold : null;
  }

  function heldMs(now) {
    return banked + (hp === "run" ? now - runFrom : 0);
  }

  function stopTimer() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = null;
    hp = "idle";
    banked = 0;
    runFrom = 0;
    leadEnd = 0;
    reachedSaid = false;
  }

  function loop() {
    frame = null;
    paintHold();
    if (hp === "lead" || hp === "run") frame = window.requestAnimationFrame(loop);
  }

  function setPhase(next) {
    var now = Date.now();
    if (next === "lead") { leadEnd = now + LEAD_MS; }
    if (next === "run") { runFrom = now; }
    if (next === "paused" && hp === "run") { banked += now - runFrom; }
    hp = next;
    if (!frame) frame = window.requestAnimationFrame(loop);
    paintHold();
  }

  /* The primary button does whatever the next thing is. */
  function primary() {
    if (hp === "idle") setPhase("run");
    else if (hp === "lead") { stopTimer(); paintHold(); }
    else if (hp === "run") setPhase("paused");
    else if (hp === "paused") setPhase("run");
  }

  var RESET_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">'
    + '<rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/>'
    + '<rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor"/></svg>';
  var ICON_CANCEL = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">'
    + '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
  var ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">'
    + '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/></svg>';

    /* Restart the one-off pulse on the digits. */
  function tickPulse(box) {
    box.classList.remove("is-go");
    void box.offsetWidth;
    box.classList.add("is-go");
  }

  function paintHold() {
    var li = q('.rv-spine > li[data-i="' + at + '"]');
    var box = li ? li.querySelector(".rv-hold") : null;
    var hold = currentHold();
    if (!box || !hold) return;

    var now = Date.now();
    if (hp === "lead" && now >= leadEnd) {
      hp = "run";
      runFrom = leadEnd;
      box.removeAttribute("data-lead");
      tickPulse(box);
    }

    if (hp !== "lead") box.removeAttribute("data-lead");
    var target = hold.secs * 1000;
    var held = heldMs(now);
    var over = held >= target;
    var frac, num, unit, head, go;

    if (hp === "lead") {
      var left = Math.max(0, leadEnd - now);
      // The bar stays empty and still through the lead-in; only the number
      // counts down, with a tick on each second. The one thing that ever
      // moves along the bar is the hold itself.
      frac = 0;
      num = String(Math.ceil(left / 1000));
      if (num !== box.getAttribute("data-lead")) {
        box.setAttribute("data-lead", num);
        tickPulse(box);
      }
      unit = "";
      head = i18n.holdLead;
      go = i18n.holdCancel;
    } else {
      frac = Math.min(1, held / target);
      if (over) {
        num = "+" + Math.floor((held - target) / 1000);
        unit = i18n.holdSecs;
      } else {
        num = String(hp === "idle" ? hold.secs : Math.ceil((target - held) / 1000));
        unit = i18n.holdSecs;
      }
      head = hp === "idle" ? i18n.holdReady
        : over ? fill(hold.range ? i18n.holdReachedRange : i18n.holdReached, [hold.secs])
        : hp === "paused" ? i18n.holdPaused : i18n.holdHolding;
      go = hp === "idle" ? i18n.holdStart : hp === "run" ? i18n.holdPause : i18n.holdResume;
    }

    if (over && !reachedSaid && hp === "run") {
      reachedSaid = true;
      announce(fill(hold.range ? i18n.holdReachedRange : i18n.holdReached, [hold.secs]));
    }

    box.setAttribute("data-phase", hp);
    box.classList.toggle("is-over", over && hp !== "lead");
    box.querySelectorAll(".rv-hold-n").forEach(function (el) {
      var b = el.querySelector("b");
      if (b.textContent !== num) b.textContent = num;
      el.querySelector("small").textContent = unit;
    });
    var h = box.querySelector(".rv-hold-head");
    if (h.textContent !== head) h.textContent = head;
    // The go icon follows the state; the button's name says what a tap does.
    var icon = hp === "run" ? ICON_PAUSE : hp === "lead" ? ICON_CANCEL : ICON_PLAY;
    if (box.getAttribute("data-icon") !== hp) {
      box.setAttribute("data-icon", hp);
      box.querySelectorAll(".rv-ico-go").forEach(function (el) { el.innerHTML = icon; });
    }
    var b = box.querySelector(".rv-hold-go");
    if (b.getAttribute("aria-label") !== go) b.setAttribute("aria-label", go);
    box.querySelector(".rv-hold-reset").hidden = hp !== "paused";

    box.querySelector(".rv-hbar-fill").style.clipPath = "inset(0 " + ((1 - frac) * 100).toFixed(3) + "% 0 0)";
  }

  /* ---------- navigation ---------- */

  function announce(text) {
    var say = q(".rv-say-live");
    if (say) say.textContent = text;
  }

  function announceStation() {
    var list = stations();
    var station = list[at];
    if (!station) return;

    var parts = [fill(i18n.position, [at + 1, list.length]) + "."];
    if (station.label) parts.push(station.label + ".");
    parts.push(station.text);
    station.branch.forEach(function (row) { parts.push(row.pill + ": " + row.text); });
    announce(parts.join(" "));
  }

  /* `forward` is true only for Next (button or ArrowDown). Back, the index
     and the dots are browsing, and must not start a countdown at anyone. */
  function go(i, forward) {
    at = i;
    unfolded = false;
    stopTimer();
    paint();
    announceStation();
    if (forward && currentHold() && !reduced) setPhase("lead");
  }

  /* ---------- compact / full ---------- */

  /* In the video's card the viewer is compact by default - only the station
     the client is on - and the toggle opens the whole spine in place. The
     choice is kept across exercises; it is the client's, not the clip's. */
  function setMode(mode) {
    root.setAttribute("data-mode", mode);
    var full = mode === "full";
    var button = q(".rv-expand");
    if (button) {
      // An icon button: the words are its accessible name and its tooltip.
      var label = full ? i18n.showOneStation : i18n.showAllStations;
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-expanded", full ? "true" : "false");
    }
    if (route) paint();
  }

  /* ---------- surface ---------- */

  function measure() {
    if (!root) return;
    var width = root.getBoundingClientRect().width;
    var surf = width >= DESK_FROM ? "desk" : "phone";
    if (root.getAttribute("data-surf") !== surf) root.setAttribute("data-surf", surf);
  }

  /* ---------- public ---------- */

  function mount(element, strings) {
    root = element;
    i18n = strings || {};
    reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!root.getAttribute("data-mode")) root.setAttribute("data-mode", "full");
    setMode(root.getAttribute("data-mode"));
    measure();
    if (window.ResizeObserver) {
      observer = new window.ResizeObserver(measure);
      observer.observe(root);
    } else {
      window.addEventListener("resize", measure);
    }

    root.addEventListener("click", function (e) {
      var target = e.target;
      var goTo = target.closest ? target.closest("[data-go]") : null;
      if (goTo) { go(parseInt(goTo.getAttribute("data-go"), 10)); return; }
      if (target.closest(".rv-unfold")) { unfolded = true; paint(); return; }
      if (target.closest(".rv-expand")) { setMode(root.getAttribute("data-mode") === "full" ? "compact" : "full"); return; }
      if (target.closest(".rv-hold-reset")) { stopTimer(); paintHold(); return; }
      if (target.closest(".rv-hold-go")) { primary(); return; }
      if (target.closest(".rv-next")) { go(at + 1, true); return; }
      if (target.closest(".rv-back")) { go(at - 1); }
    });

    // Scoped to the component rather than the document: this page also has a
    // video player and a list of exercises, and a global arrow-key handler
    // would move the route while somebody is scrubbing the clip.
    root.addEventListener("keydown", function (e) {
      if (e.target.matches("input, textarea, button, [contenteditable]")) return;
      var n = stations().length;
      if (e.key === "ArrowDown" && at < n - 1) { e.preventDefault(); go(at + 1, true); }
      if (e.key === "ArrowUp" && at > 0) { e.preventDefault(); go(at - 1); }
    });
  }

  /**
   * Show one exercise's route. Returns false when there is nothing to show —
   * no classified steps for this clip, which is most of the library and every
   * clip whose clinic typed its own wording — and the caller then falls back
   * to the prose panel.
   */
  function load(next, title) {
    if (!root) return false;

    stopTimer();
    at = 0;
    unfolded = false;

    if (!next || !next.stations || !next.stations.length) {
      route = null;
      root.hidden = true;
      return false;
    }

    route = next;
    root.hidden = false;
    build(title);
    measure();
    paint();
    // Not announced on arrival: the client did not ask to be read to, and a
    // live region that fires on every exercise change talks over the page.
    return true;
  }

  function clear() {
    stopTimer();
    route = null;
    if (root) root.hidden = true;
  }

  return { mount: mount, load: load, clear: clear };
})();
