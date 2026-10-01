// Osso Export Classifier: the page. Vanilla JS, no dependencies.
// Security note: model and dataset text is ALWAYS rendered with textContent /
// createTextNode, never innerHTML: nothing the model (or a prompt-injecting
// user) says can become markup in someone's browser.
//
// Layout (operator's pick of 28-09-2026, concept A): the interview on the
// left, the case file on the right, filling in from what the Worker returns;
// on phones the case file is a sheet behind a tab. The case file is the one
// combined card of the conversation: classification and licensing together.
// What it shows is derived in case-model.js from the Worker's responses.

(function () {
  "use strict";

  const M = window.OssoCaseModel;
  const cfg = window.CLASSIFIER_CONFIG || {};
  // owner/tester bypass of the per-visitor cap: visit once with ?tester=CODE
  const params = new URLSearchParams(location.search);
  // The code is then taken out of the address bar (29-09-2026, security audit)
  // so it does not linger in the history, a screenshot or a shared link; the
  // tab keeps it in sessionStorage. Other parameters and the #hash stay.
  const testerFromUrl = params.get("tester");
  if (testerFromUrl) {
    try { sessionStorage.setItem("tester_key", testerFromUrl); } catch (e) { /* storage blocked: this page load only */ }
    params.delete("tester");
    const rest = params.toString();
    try { history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash); } catch (e) { /* not fatal */ }
  }
  let testerKey = testerFromUrl;
  try { testerKey = sessionStorage.getItem("tester_key") || testerFromUrl; } catch (e) { /* blocked */ }
  const $ = (id) => document.getElementById(id);
  const workerReady = cfg.WORKER_URL && !cfg.WORKER_URL.startsWith("REPLACE");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const phone = matchMedia("(max-width: 900px)");
  const AI_LINE =
    "This assistant is an AI (Claude, by Anthropic). Its answers can be wrong and must be reviewed by a " +
    "qualified professional before they are relied on, used or shared.";

  // DOM helper: strings become text nodes, never markup
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    return n;
  }

  // ---------- state ----------
  // The transcript is server-owned and re-sent verbatim. Licensing answers
  // are keyed by question id and sent with every POST; the Worker recomputes
  // the pathway from the recorded verdict plus these answers each time.
  const S = {
    transcript: [],
    licensingAnswers: {},
    started: false,
    busy: false,
    stage: null, // "interview" | "card" while a reply is being made
    wait: "",
    verdict: null,
    licensing: null,
    pathway: null,
    verdictRef: null,
    determinedOn: null,
    // the threshold-table engine's form (INTERVIEW_MODE=tables, 28-09-2026):
    // set while a signed, not-yet-decided threshold form is open, before any
    // verdict exists. Cleared as soon as a verdict or pathway card arrives.
    tableForm: null,
    editingQ: null, // the id of a table-form answer being changed locally, before any request
  };

  // What the sticky bars cover, measured, so scrolled-to content is never
  // under the top bars, the composer or the phone's case-file tab
  // (html's scroll-padding reads these; CSSOM, not an inline style attribute).
  function measureBars() {
    // what is covered: down to the top bars' bottom edge, and up from the
    // stuck composer (on phones it sits on the case-file tab)
    const shown = (sel) => { const n = document.querySelector(sel); return n && getComputedStyle(n).display !== "none" ? n.getBoundingClientRect() : null; };
    const bar = shown(".ws-bar") || shown(".topbar");
    const comp = shown("#composer");
    const root = document.documentElement.style;
    root.setProperty("--bars-top", (bar ? bar.bottom : 0) + "px");
    // stuck, the composer covers its own height plus its sticky offset
    const off = comp ? parseFloat(getComputedStyle($("composer")).bottom) || 0 : 0;
    root.setProperty("--bars-bottom", (comp && !$("workspace").classList.contains("hidden") ? comp.height + off : 0) + "px");
    // the page header (title, one line, the view switch) scrolls with the page:
    // the interview and the case file are sized to fit under it on first view
    const head = shown("#page-head");
    root.setProperty("--head-h", (head ? head.height : 0) + "px");
  }
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(measureBars);
    for (const sel of [".topbar", "#page-head", "#composer", "#sheet-tab"]) { const n = document.querySelector(sel); if (n) ro.observe(n); }
  }
  measureBars();

  // ---------- views: case, memo, browse ----------
  function show(view) {
    // the accuracy and data sections, and the paused banner, belong to the
    // Classifier view, not to Browse (operator, 28-09-2026)
    document.body.classList.toggle("view-browse", view === "browse");
    $("workspace").classList.toggle("hidden", view !== "case");
    $("memo-view").classList.toggle("hidden", view !== "memo");
    $("panel-browse").classList.toggle("hidden", view !== "browse");
    $("sheet-tab").classList.toggle("hidden", view !== "case");
    for (const [id, on] of [["tab-chat", view !== "browse"], ["tab-browse", view === "browse"]]) {
      $(id).classList.toggle("on", on);
      $(id).setAttribute("aria-pressed", String(on));
    }
    // the top menu names where you are, and closes after a choice
    $("menu-current").textContent = view === "browse" ? "Browse Annex I" : "Classifier";
    $("nav-menu").open = false;
    if (view === "memo") renderMemo();
    if (view === "browse") ensureAnnexLoaded();
    if (view !== "case") sheet(false);
    measureBars();
    window.scrollTo(0, 0);
    settleFocus(view);
  }
  // Accessibility (29-09-2026): a click on a button that the view switch hides
  // (the menu's choice, "Open the memo", "Back to the case") would drop focus to
  // the top of the page. If focus was lost, put it on the new view's heading.
  function settleFocus(view) {
    const a = document.activeElement;
    if (a && a !== document.body && a.getClientRects().length) return;
    const target = view === "memo" ? $("memo-title") : view === "browse" ? $("browse-h") : $("chat-input");
    if (target) target.focus({ preventScroll: true });
  }
  $("tab-chat").addEventListener("click", () => show("case"));
  // a click anywhere else closes the top menu
  document.addEventListener("click", (e) => { if (!e.target.closest("#nav-menu")) $("nav-menu").open = false; });
  $("tab-browse").addEventListener("click", () => show("browse"));
  // Keyboard (29-09-2026): Escape closes the menu and returns focus to its
  // button; leaving it with Tab closes it too, so it never stays open behind
  // the page.
  const navMenu = $("nav-menu");
  navMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && navMenu.open) {
      e.preventDefault();
      navMenu.open = false;
      navMenu.querySelector("summary").focus();
    }
  });
  navMenu.addEventListener("focusout", (e) => {
    if (navMenu.open && e.relatedTarget && !navMenu.contains(e.relatedTarget)) navMenu.open = false;
  });
  $("open-memo").addEventListener("click", () => show("memo"));

  // the case file as a sheet on phones
  function sheet(open) {
    $("panel-case").classList.toggle("open", open);
    $("sheet-tab").setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("sheet-open", open);
    if (open) $("close-sheet").focus({ preventScroll: true });
    // the first look after a new classification goes to the classification
    if (open && S.verdictUnseen) {
      S.verdictUnseen = false;
      requestAnimationFrame(() => focusCase());
    }
  }
  $("sheet-tab").addEventListener("click", () => sheet(true));
  $("close-sheet").addEventListener("click", () => {
    // wide screens: the case file is a side panel the visitor can hide and
    // bring back (operator, 29-09-2026); phones: the sheet closes as before
    if (!phone.matches) {
      document.body.classList.add("case-hidden");
      $("show-case").focus();
      return;
    }
    sheet(false);
    $("sheet-tab").focus();
  });
  $("show-case").addEventListener("click", () => {
    document.body.classList.remove("case-hidden");
    $("close-sheet").focus({ preventScroll: true });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("panel-case").classList.contains("open")) {
      sheet(false);
      $("sheet-tab").focus();
    }
  });

  // ---------- health check ----------
  // Nothing is shown while the assistant is available; the only status the
  // page ever surfaces is a notice when it is not.
  // Nothing about budgets shows until a limit is hit; then one calm banner
  // at the top of the Classifier (operator, 28-09-2026). The Worker's health
  // says which limit: the day's resumes at 00:00 UTC, the month's at the
  // start of the next month.
  const PAUSED = {
    day: ["The assistant is paused.", "Today's free capacity has been used. It resumes at 00:00 UTC. Browse Annex I stays fully available."],
    month: ["The assistant is paused.", "This month's free capacity has been used. It resumes at the start of next month. Browse Annex I stays fully available."],
    service: ["The assistant is paused.", "A temporary service limit has been reached. Please try again later. Browse Annex I stays fully available."],
  };
  function showPaused(kind) {
    const [first, rest] = PAUSED[kind === "month" || kind === "service" ? kind : "day"];
    const b = $("budget-banner");
    b.className = "notice paused";
    b.setAttribute("role", "status");
    b.replaceChildren(el("p", {}, el("span", { class: "first", text: first }), " " + rest));
    S.blocked = true;
    input.disabled = true;
    sendBtn.disabled = true;
    input.placeholder = "The assistant is paused. Browse Annex I stays fully available.";
    for (const t of document.querySelectorAll(".tile")) t.disabled = true;
    $("tab-browse").classList.add("suggest");
  }
  // the Worker refuses the assistant where Anthropic does not offer its API
  // or sanctions forbid providing it (worker/src/geo.ts, 28-09-2026)
  const REGION = [
    "The assistant is not available from your country or region",
    "Anthropic, which provides the AI model, does not offer its service there, or sanctions rules do not allow it to be provided. Browse Annex I still shows the full text.",
  ];
  function showNotice([title, body], disable, withWaitlist) {
    const b = $("budget-banner");
    b.replaceChildren(el("h2", { text: title }), el("p", { text: body }),
      el("button", { class: "btn", type: "button", onclick: () => show("browse"), text: "Browse Annex I" }),
      // never a null child: replaceChildren would print it as the text "null"
      ...(withWaitlist ? [el("button", { class: "btn ghost", type: "button", onclick: openWaitlist, text: "Join the waitlist" })] : []));
    b.classList.remove("hidden");
    if (disable) {
      S.blocked = true;
      input.disabled = true;
      sendBtn.disabled = true;
      for (const t of document.querySelectorAll(".tile")) t.disabled = true;
    }
  }
  async function refreshStatus() {
    if (!workerReady) return;
    try {
      const resp = await fetch(cfg.WORKER_URL.replace(/\/$/, "") + "/api/health", { headers: testerKey ? { "x-tester-key": testerKey } : {} });
      const h = await resp.json();
      if (h.region_available === false) {
        showNotice(REGION, true);
        input.placeholder = "The assistant is not available from your country or region.";
      } else if (!h.assistant_available) {
        showPaused(h.paused);
      }
    } catch {
      // health unavailable: stay silent; a failed chat POST reports itself
    }
  }

  // ---------- interview ----------
  const messagesEl = $("messages");
  const form = $("chat-form");
  const input = $("chat-input");
  const sendBtn = $("send");
  const waitEl = $("wait");

  for (const tile of document.querySelectorAll(".tile")) {
    tile.addEventListener("click", () => {
      input.value = tile.dataset.prompt;
      // one click runs the case: a demo that needs a second click loses the visitor
      if (!sendBtn.disabled) form.requestSubmit();
      else input.focus();
    });
  }

  // ?q=<text> fills in the description from a link (the watcher links EU
  // notes here): value assignment only, never sent automatically, so the
  // visitor always chooses to send it themselves.
  if (params.get("q")) {
    input.value = params.get("q");
    input.focus({ preventScroll: true });
  }

  // Render assistant text with ONLY **bold** honoured, built with DOM nodes
  function renderInline(parent, text) {
    const parts = String(text).split(/\*\*/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1 && i < parts.length - (parts.length % 2 === 0 ? 1 : 0)) parent.appendChild(el("strong", { text: parts[i] }));
      else parent.appendChild(document.createTextNode(parts[i]));
    }
  }

  // The interview follows new messages while the visitor is following it.
  // Sending turns following on; only the visitor's own scrolling (wheel,
  // touch, keys) can turn it off, when it leaves the end of the last message
  // out of view. The page's own smooth scrolling never counts, so a reply
  // arriving mid-scroll is still shown. A reply longer than the screen is
  // shown from its start.
  let following = true;
  let gesture = 0;
  const markGesture = () => (gesture = Date.now());
  window.addEventListener("wheel", markGesture, { passive: true });
  window.addEventListener("touchmove", markGesture, { passive: true });
  window.addEventListener("keydown", (e) => { if (/^(Page|Arrow|Home|End| )/.test(e.key) && e.target === document.body) markGesture(); });
  // Wide screens (operator, 29-09-2026): the interview scrolls inside its own
  // box and the case file inside its own, so the page never moves under the
  // visitor. On phones the page is the interview and scrolls as before.
  const chatScroll = $("chat-scroll");
  const paned = () => !phone.matches;
  window.addEventListener("scroll", () => { if (!paned() && Date.now() - gesture < 400) following = atEnd(); }, { passive: true });
  chatScroll.addEventListener("scroll", () => { if (paned() && Date.now() - gesture < 400) following = atEnd(); }, { passive: true });
  function atEnd() {
    if (paned()) return chatScroll.scrollTop + chatScroll.clientHeight >= chatScroll.scrollHeight - 24;
    const last = messagesEl.lastElementChild;
    if (!last) return true;
    const clear = window.innerHeight - parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bars-bottom") || "0");
    return last.getBoundingClientRect().bottom <= clear + 24;
  }
  function reveal(node) {
    if (paned()) {
      // scroll the interview box only: scrollIntoView would move the page too
      const top = node.offsetTop, h = node.offsetHeight, box = chatScroll.clientHeight;
      const target = h > box - 16 ? top - 8 : Math.max(chatScroll.scrollTop, top + h - box + 16);
      chatScroll.scrollTo({ top: target, behavior: reduceMotion.matches ? "auto" : "smooth" });
      return;
    }
    const room = window.innerHeight - parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bars-bottom") || "0")
      - parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--bars-top") || "0");
    node.scrollIntoView({ block: node.getBoundingClientRect().height > room ? "start" : "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" });
  }

  // Who speaks: "You", or the Osso mark and "Osso", the way Claude shows its
  // own logo in its chat (operator, 29-09-2026: never "Assistant")
  function who(role) {
    if (role === "user") return el("span", { class: "who label", text: "You" });
    return el("span", { class: "who label osso" }, el("img", { class: "who-mark", src: "img/brand/osso-mark-espresso.svg", alt: "", width: "18", height: "18" }), "Osso");
  }

  function addBubble(role, text, force) {
    if (force) following = true;
    const follow = following;
    const div = el("div", { class: "msg " + role }, who(role));
    const body = el("div", { class: "body" });
    if (role === "assistant") {
      // heading and quote markers render as emphasis, never as raw # or >
      const lines = String(text).split("\n");
      lines.forEach((line, i) => {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (heading) {
          const b = el("strong");
          renderInline(b, heading[1].replace(/\*\*/g, ""));
          body.appendChild(b);
        } else renderInline(body, line.replace(/^>\s?/, ""));
        if (i < lines.length - 1) body.appendChild(document.createTextNode("\n"));
      });
    } else body.textContent = text;
    div.appendChild(body);
    messagesEl.appendChild(div);
    if (follow) reveal(div);
    return div;
  }

  // a line in the interview pointing at the case file, for phones and for
  // anyone who is reading the interview column
  function addCaseLine(text) {
    const follow = following;
    const line = el("div", { class: "msg caseline" }, el("span", { text }), " ",
      el("button", { class: "linkish", type: "button", onclick: () => (phone.matches ? sheet(true) : focusCase()), text: "Open the case file" }));
    messagesEl.appendChild(line);
    if (follow) reveal(line);
  }
  // on wide screens the case file scrolls on its own: bring its
  // classification to the top of the panel, without moving the page
  // the case file follows the answers as they are recorded (operator,
  // 29-09-2026): the newest one is brought into view inside the panel, never
  // by moving the page
  function followCase(sectionId) {
    if (phone.matches) return;
    const rows = document.querySelectorAll("#" + sectionId + " .qa, #" + sectionId + " .next-in-chat");
    const node = rows[rows.length - 1];
    if (!node) return;
    const panel = $("panel-case");
    const top = node.offsetTop, bottom = top + node.offsetHeight;
    const target = bottom > panel.scrollTop + panel.clientHeight - 24 ? bottom - panel.clientHeight + 32
      : top < panel.scrollTop + 24 ? top - 24 : null;
    if (target !== null) panel.scrollTo({ top: Math.max(0, target), behavior: reduceMotion.matches ? "auto" : "smooth" });
  }
  function focusCase(id) {
    const target = $(id || "cf-classification");
    if (target) $("panel-case").scrollTo({ top: target.offsetTop - 24, behavior: reduceMotion.matches ? "auto" : "smooth" });
  }

  // Clipboard with fallback: navigator.clipboard is refused in some browsers
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = el("textarea", { readonly: true, class: "offscreen" });
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }
  function memoContext() {
    return {
      messages: S.transcript, verdict: S.verdict, licensing: S.licensing, pathway: S.pathway,
      reference: S.caseRef || "", date: S.determinedOn || today(), aiLine: AI_LINE, siteUrl: cfg.SITE_URL,
    };
  }
  const today = () => new Date().toISOString().slice(0, 10);
  async function copyMemo(btn) {
    const ok = await copyText(M.memoText(memoContext()));
    const label = btn.textContent;
    btn.textContent = ok ? "Copied" : "Copy failed. Select the memo text instead";
    setTimeout(() => (btn.textContent = label), 2500);
  }

  // ---------- the stepper ----------
  function renderStepper() {
    if (!$("stepper")) return; // the page no longer shows a step bar (operator, 29-09-2026)
    const st = M.stepOf(S);
    for (const li of $("stepper").children) {
      const step = li.dataset.step;
      li.classList.toggle("done", st.done.includes(step));
      if (step === st.current) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
      li.setAttribute("aria-label", li.textContent + (st.done.includes(step) ? ", done" : step === st.current ? ", current step" : ""));
    }
  }

  // ---------- the case file ----------
  const skel = () => el("div", { class: "skel", "aria-hidden": "true" }, el("span"), el("span"), el("span"));
  const empty = (text) => el("p", { class: "cf-empty", text });
  const section = (id, title, ...body) => el("section", { class: "cf-section", id }, el("h3", { class: "label", text: title }), ...body);

  function factsBlock() {
    const facts = M.factsOf(S.transcript);
    if (!facts.length) return empty("Your description, and every answer you give, appear here.");
    return factsList(facts);
  }
  // each answer under the question it answered (the question clamped on
  // screen, in full in the memo and when printed)
  function factsList(facts, full) {
    return el("ol", { class: full ? "facts full" : "facts" }, facts.map((f, i) => {
      const asked = el("p", { class: "asked" });
      if (i === 0 && !full) asked.textContent = "Description";
      else if (f.question) renderInline(asked, f.question);
      else asked.textContent = "Added";
      return el("li", {}, asked, el("p", { class: "answer", text: f.answer }));
    }));
  }

  const STATE_WORD = { met: "Met", not_met: "Not met", open: "Open" };
  const entryOf = (code) => annex && annex.entries.find((e) => e.entry_code === code);
  const titleOf = (entry, code) => (entry ? entry.verbatim_text.split("\n", 1)[0].replace(code, "").trim() : "");
  function candidatesBlock() {
    const codes = M.candidatesOf(S.transcript, S.verdict, S.tableForm);
    if (!codes.length) return S.busy ? skel() : empty("The entries the assistant reads, and the thresholds each turns on, appear here.");
    // On the threshold-table path, before any classification, the entries are
    // the ones the form is checking: a compact list, code and title, with no
    // thresholds (the questions are the thresholds). Once a verdict exists the
    // full block below takes over (29-09-2026).
    if (S.tableForm && !S.verdict) {
      return el("ul", { class: "cand compact", "aria-label": "Entries the questions check" }, codes.map((code) =>
        el("li", {},
          el("a", { class: "code", href: "#" + code, title: "Open " + code + " in Browse Annex I", onclick: (e) => { e.preventDefault(); openEntryInBrowse(code); }, text: code }),
          titleOf(entryOf(code), code) ? el("span", { class: "title", title: titleOf(entryOf(code), code), text: titleOf(entryOf(code), code) }) : null)));
    }
    return el("ul", { class: "cand" }, codes.map((code) => {
      const entry = entryOf(code);
      const title = titleOf(entry, code);
      // tested: the verdict's own rows for this entry (a sub-item it tested
      // need not be a parameter line); open: the corpus's other thresholds
      const tested = M.provisionRows(S.verdict).filter((r) => r.entry === code)
        .map((r) => ({ path: r.path, text: r.quote.split("\n", 1)[0], state: r.met ? "met" : "not_met" }));
      const th = entry ? M.thresholdsOf(entry, S.verdict).filter((t) => t.state === "open") : [];
      const overall = !S.verdict ? null : S.verdict.entry_codes.includes(code) ? ["matched", "Matched"] : tested.length ? ["not_met", "Not matched"] : null;
      return el("li", {},
        el("div", { class: "head" },
          el("a", { class: "code", href: "#" + code, title: "Open " + code + " in Browse Annex I", onclick: (e) => { e.preventDefault(); openEntryInBrowse(code); }, text: code }),
          overall ? el("span", { class: "tag " + overall[0], text: overall[1] }) : null),
        title ? el("p", { class: "title", text: title }) : null,
        tested.length ? el("ul", { class: "thresholds", "aria-label": "Thresholds tested" }, tested.map(thresholdRow)) : null,
        th.length
          ? el("details", { class: "more" }, el("summary", { text: (tested.length ? "Other thresholds in " : "Thresholds in ") + code + " (" + th.length + ")" }),
              el("ul", { class: "thresholds" }, th.map(thresholdRow)))
          : null);
    }));
  }
  function thresholdRow(t) {
    return el("li", {}, el("span", { class: "tag " + t.state, text: STATE_WORD[t.state] }),
      el("span", {}, el("span", { class: "code", text: t.path }), " ", t.text));
  }

  function testedBlock() {
    const rows = M.provisionRows(S.verdict);
    if (!rows.length) return S.stage === "card" ? skel() : empty("Each provision the classification rests on is quoted here from the corpus, marked met or not met.");
    return el("div", { class: "tested" }, rows.map((r) => el("blockquote", {},
      el("div", { class: "row" },
        el("a", { class: "code", href: "#" + r.entry, title: "Open " + r.entry + " in Browse Annex I", onclick: (e) => { e.preventDefault(); openEntryInBrowse(r.entry); }, text: r.path }),
        el("span", { class: "tag " + (r.met ? "met" : "not_met"), text: r.met ? "Met" : "Not met" })),
      // corpus text attached by the Worker, never written by the model
      el("div", { class: "provision", text: "“" + r.quote + "”" }),
      (() => { const d = el("div", { class: "expl" }); renderInline(d, r.explanation); return d; })())));
  }

  function classificationBlock() {
    const v = S.verdict;
    if (!v) return S.stage === "card" ? skel() : empty("The classification appears once the facts it turns on are settled.");
    const missing = (v.missing_facts || []).concat((v.unavailable_facts || []).map((f) => f.fact + " (“" + f.user_statement + "”)"));
    return el("div", {},
      el("p", { class: "verdict-line" }, el("span", { class: "status " + v.status, text: M.STATUS_LABEL[v.status] || v.status }),
        v.entry_codes.length ? el("span", { class: "code", text: v.entry_codes.join(", ") }) : null),
      missing.length ? el("div", { class: "missing" }, el("p", { class: "label", text: "Facts still needed" }), el("ul", {}, missing.map((m) => el("li", { text: m })))) : null,
      el("p", { class: "caveats", text: M.caveatsOf(v).join(" · ") }),
      // the disclaimer is appended by the Worker, never by the model
      v.disclaimer ? el("p", { class: "disclaimer", text: v.disclaimer }) : null,
      el("p", { class: "meta", text: (S.caseRef ? "Case " + S.caseRef + " · " : "") + (v.corpus_version ? "Corpus version " + v.corpus_version + " · " : "") + "Determined on " + S.determinedOn }),
      feedbackBlock());
  }

  function licensingBlock() {
    const box = el("div", { class: "licensing" });
    if (!S.verdict) box.appendChild(empty("Once the item is classified, the licensing questions are asked in the interview, and your answers are recorded here."));
    else if (!S.licensing) {
      box.appendChild(empty(S.verdict.status === "listed"
        ? "No licensing step in this conversation: the classification was asked for on its own."
        : "No licensing step: the item was not placed under an Annex I entry."));
    } else renderLicensing(box, S.licensing, S.pathway);
    return box;
  }

  // The licensing section: the answered questions (each can be changed),
  // then the pathway once decided. The pending question is asked in the
  // interview, not here (operator, 29-09-2026): the case file only records.
  function renderLicensing(el_, licensing, pw) {
    const questions = licensing.questions || [];
    const answered = questions.filter((q) => q.answer !== undefined);
    answered.forEach((q, i) => {
      el_.appendChild(qaRow(q, "Change the answer to: " + q.text,
        // this answer and every later one depend on each other: ask again
        () => { for (const later of answered.slice(i)) delete S.licensingAnswers[later.id]; submitLicensing(); }));
    });
    const pending = questions.find((q) => q.answer === undefined);
    if (pending && !pw) el_.appendChild(el("p", { class: "next-in-chat", text: "Next question: in the interview." }));
    // a needs_expert card stops after the destination when it is not
    // sanctioned: the Worker's note says why (sanctionsScreen, 28-09-2026)
    if (licensing.note && !pending && !pw) {
      const note = document.createElement("p");
      note.className = "answered";
      note.textContent = licensing.note;
      el_.appendChild(note);
    }
    if (S.busy && S.stage === null && S.started) el_.appendChild(skel());
    if (pw) el_.appendChild(pathwayBlock(pw, false));
  }

  // One recorded answer in the case file: the question in full, the answer,
  // and a clear Change button (operator, 29-09-2026: the small underlined
  // link was easy to miss).
  // The record shows the question's first sentence, clamped to two lines: the
  // full text opens with "Show full question", is the hover title, and is what
  // the memo and the printed page carry (29-09-2026). The chat question itself
  // is untouched.
  S.openQ = new Set();
  function qaQuestion(q) {
    const plain = String(q.text).replace(/\*\*/g, "");
    const short = M.firstSentence(q.text);
    const p = el("p", { class: "qa-q" });
    if (short === q.text && plain.length <= 90) { renderInline(p, q.text); return [p]; }
    const uid = "qq-" + q.id.replace(/\W/g, "");
    const open = S.openQ.has(q.id);
    const sShort = el("span", { class: "q-short" }), sFull = el("span", { class: "q-full", id: uid });
    renderInline(sShort, short);
    renderInline(sFull, q.text);
    p.append(sShort, sFull);
    p.title = plain;
    p.classList.toggle("open", open);
    const toggle = el("button", { class: "linkish q-toggle", type: "button", "aria-expanded": String(open), "aria-controls": uid, text: open ? "Show less" : "Show full question" });
    toggle.addEventListener("click", () => {
      const now = !p.classList.contains("open");
      p.classList.toggle("open", now);
      if (now) S.openQ.add(q.id); else S.openQ.delete(q.id);
      toggle.setAttribute("aria-expanded", String(now));
      toggle.textContent = now ? "Show less" : "Show full question";
    });
    return [p, toggle];
  }
  function qaRow(q, label, onChange) {
    return el("div", { class: "qa" + (S.editingQ === q.id ? " editing" : "") },
      qaQuestion(q),
      el("p", { class: "qa-a" }, el("strong", { text: M.optionLabel(q, q.answer) }),
        S.editingQ === q.id
          ? el("span", { class: "qa-note", text: "Being changed in the interview" })
          : el("button", { class: "btn ghost change", type: "button", "aria-label": label, disabled: S.busy, onclick: onChange, text: "Change" })));
  }

  function pathwayBlock(pw, full) {
    const tone = pw.outcome === "gea_available" ? "gea" : pw.outcome === "individual_licence_required" ? "individual" : "sanctions";
    return el("div", { class: "pathway" },
      el("p", { class: "verdict-line" }, el("span", { class: "status " + tone, text: M.OUTCOME_LABEL[pw.outcome] || pw.outcome }),
        pw.eligible_gea ? el("span", { class: "code", text: pw.eligible_gea }) : null,
        el("span", { class: "dest", text: "Destination: " + pw.destination })),
      el("div", { class: "tested" }, (pw.conditions_quoted || []).map((c) => quoteBlock(c.gea_id, c.verbatim_quote, c.explanation))),
      M.caveatsOf(pw).length ? el("p", { class: "caveats", text: M.caveatsOf(pw).join(" · ") }) : null,
      pw.disclaimer ? el("p", { class: "disclaimer", text: pw.disclaimer }) : null,
      full ? null : el("p", { class: "review-cta" }, "This pathway is a draft determination. Have it confirmed by the lawyer who built this tool. ",
        el("a", { href: "https://www.linkedin.com/in/ricardo-ossorio", target: "_blank", rel: "noopener", text: "Request legal review" })));
  }

  // "EU001: "quoted text"": the quote is corpus text, the explanation ours.
  // A threshold-table question's quote names its dotted path instead of a
  // GEA id (q.quote.gea_id is absent, q.quote.path present): same chip, the
  // label is just the provision instead of the authorisation.
  function quoteBlock(label, quote, explanation) {
    const q = el("blockquote", {}, el("span", { class: "code", text: label }), ": ", el("span", { class: "provision", text: "“" + quote + "”" }));
    if (explanation) {
      const d = el("div", { class: "expl" });
      renderInline(d, explanation);
      q.appendChild(d);
    }
    return q;
  }

  // ---------- questions asked in the interview (operator, 29-09-2026) ----------
  // Every threshold and licensing question is asked in the interview, as an
  // assistant message with its options as buttons, and the visitor's pick
  // shows as their reply; the case file only records the answers, each
  // changeable there. One question is live at a time: a newer one closes it.
  S.live = null; // { id, node } of the question awaiting a click
  S.seen = new Set(); // form questions already in the interview (asked, or read from the description)

  function closeLive() {
    if (!S.live) return;
    const chips = S.live.node.querySelector(".chips");
    if (chips) chips.remove();
    // the confirm step's Change buttons sit outside .chips: once the step is
    // answered they must go too, or a dead button re-asks a decided form
    // (review of 85a51cf, 30-09-2026)
    S.live.node.querySelectorAll(".confirm-rows .change").forEach((b) => b.remove());
    S.live = null;
    syncComposer();
  }

  // The text box follows the case (operator, 01-10-2026): free chat is a Pro
  // feature, so a question with buttons is answered with the buttons ("Don't
  // know" is always one of them, so nobody is stuck), and a finished case
  // locks the box and offers a new case instead of more chat.
  const newCase = $("new-case");
  function caseDone() {
    if (S.pathway) return true;
    if (!S.verdict) return false;
    return !S.licensing || !(S.licensing.questions || []).some((q) => q.answer === undefined);
  }
  function syncComposer() {
    if (S.blocked) return; // a pause or region notice owns the composer
    const done = !S.live && !S.busy && caseDone();
    const locked = !!S.live || done;
    input.disabled = locked;
    sendBtn.disabled = locked || !!S.busy;
    input.placeholder = S.live ? "Pick one of the options above" : S.started ? "Answer the question, or add a fact" : input.placeholder;
    form.classList.toggle("hidden", done);
    newCase.classList.toggle("hidden", !done);
  }

  // the visitor's pick: their reply in the interview, then the round trip
  // A button that answered by keyboard (a click with no pointer, detail 0)
  // is removed with its question: focus goes to the text box so a keyboard
  // user is not thrown to the top of the page. Not for a tap or a mouse click,
  // where it would open the phone's keyboard.
  const keyboardClick = (ev) => !!ev && ev.detail === 0;
  function picked(label, run, ev) {
    if (S.busy) return;
    closeLive();
    if (keyboardClick(ev)) input.focus({ preventScroll: true });
    if (label) addBubble("user", label, true);
    run();
  }

  function askInChat(q, keep) {
    if (S.live && S.live.id === q.id && !keep) return;
    closeLive();
    S.seen.add(q.id);
    const follow = following;
    const body = el("div", { class: "body", id: "q-" + q.id.replace(/\W/g, "") });
    renderInline(body, q.text);
    // the options are one group, named by the question they answer
    const chips = el("div", { class: "chips", role: "group", "aria-labelledby": body.id });
    if (q.kind === "destination") {
      const id = "dest-" + q.id.replace(/\W/g, "");
      const select = el("select", { class: "field", id }, el("option", { value: "", text: "Choose a destination…" }), q.options.map((o) => el("option", { value: o.value, text: o.label })));
      const go = el("button", { class: "chip primary", type: "button", disabled: true, text: "Continue" });
      select.addEventListener("change", () => (go.disabled = !select.value));
      go.addEventListener("click", (ev) => {
        if (!select.value) return;
        const o = q.options.find((x) => x.value === select.value);
        picked(o ? o.label : select.value, () => { S.licensingAnswers[q.id] = select.value; submitLicensing(); }, ev);
      });
      chips.append(el("label", { class: "visually-hidden", for: id, text: q.text }), select, go);
    } else {
      for (const o of q.options) {
        // the catalogue's "none" becomes typed text, and the restart reruns
        // the first description: both make their own bubble, or none
        const own = (q.id === "table_catalog.choice" && o.value === "table_catalog.none") || q.id === "table_restart.choice";
        chips.appendChild(el("button", {
          class: "chip", type: "button", text: o.label,
          onclick: (ev) => (own ? (S.busy ? null : (closeLive(), keyboardClick(ev) && input.focus({ preventScroll: true }), chooseOption(q, o))) : picked(o.label, () => chooseOption(q, o), ev)),
        }));
      }
    }
    if (keep) {
      chips.appendChild(el("button", {
        class: "chip quiet", type: "button", text: "Keep my answer",
        onclick: (ev) => picked("Keep: " + keep, () => { S.editingQ = null; renderCase(); if (S.tableForm) formToChat(S.tableForm); }, ev),
      }));
    }
    const div = el("div", { class: "msg assistant ask" }, who("assistant"), body, chips,
      q.quote ? el("details", { class: "legal" }, el("summary", { text: "The legal text" }),
        quoteBlock(q.quote.gea_id || q.quote.path, q.quote.verbatim_quote, "")) : null);
    messagesEl.appendChild(div);
    S.live = { id: q.id, node: div };
    syncComposer();
    if (follow) reveal(div);
  }

  // The Worker asks for confirmation (form.confirm, 30-09-2026, operator decision):
  // the answers would decide the card, but some were filled in by the model, from
  // the visitor's description or typed words, and nothing is decided until the
  // visitor confirms. Osso says so once, lists exactly those answers (the Worker
  // flags them, q.prefilled; every row is plain text) each with its own Change
  // button, and one Confirm button. The confirmation rides this one request,
  // never stored (second review S2, 29-09-2026). Without the flag (every
  // question answered, none pending) the older, shorter prompt stays.
  function askConfirm(form) {
    if (S.live && S.live.id === "table.confirm") return;
    closeLive();
    const follow = following;
    const answered = ((form && form.questions) || []).filter((q) => q.answer !== undefined);
    const rows = answered.filter((q) => q.prefilled);
    const chips = el("div", { class: "chips", role: "group", "aria-labelledby": "q-confirm" }, el("button", {
      class: "chip primary", type: "button", text: "Confirm these answers",
      onclick: (ev) => picked("Confirmed", () => {
        S.editingQ = null;
        S.licensingAnswers["table.confirm"] = "yes";
        submitLicensing();
        delete S.licensingAnswers["table.confirm"];
      }, ev),
    }));
    const flagged = !!(form && form.confirm) && rows.length > 0;
    const list = flagged
      ? el("ul", { class: "confirm-rows" }, rows.map((q) => {
        const what = el("span", { class: "confirm-q", title: String(q.text).replace(/\*\*/g, "") });
        renderInline(what, M.firstSentence(q.text));
        return el("li", {}, what, " ", el("strong", { text: M.optionLabel(q, q.answer) }), " ",
          el("button", {
            class: "btn ghost change", type: "button", "aria-label": "Change the answer to: " + String(q.text).replace(/\*\*/g, ""), text: "Change",
            onclick: () => { if (!S.busy) changeFormAnswer(q, answered, answered.indexOf(q)); },
          }));
      }))
      : null;
    const div = el("div", { class: "msg assistant ask" }, who("assistant"),
      el("div", { class: "body", id: "q-confirm", text: flagged
        ? "Osso filled in these answers from your description. Check them, then confirm."
        : "Every question is answered. Check the answers in the case file, change any that is wrong there, then confirm to get the classification." }),
      list, chips);
    messagesEl.appendChild(div);
    S.live = { id: "table.confirm", node: div };
    syncComposer();
    if (follow) reveal(div);
  }

  // A form from the Worker, into the interview: the answers the AI read from
  // the description are said once (they sit in the case file, changeable),
  // then the next question is asked, or the confirmation.
  function formToChat(form) {
    const qs = form.questions || [];
    // the confirm step lists the prefilled answers itself: no separate "I read N answers" line before it
    if (form.confirm) {
      qs.forEach((q) => S.seen.add(q.id));
      askConfirm(form);
      return;
    }
    const read = qs.filter((q) => q.answer !== undefined && !S.seen.has(q.id));
    read.forEach((q) => S.seen.add(q.id));
    if (read.length === 1) addBubble("assistant", "From your description: " + read[0].text + " **" + M.optionLabel(read[0], read[0].answer) + "**. You can change it in the case file.");
    else if (read.length > 1) addBubble("assistant", "I read " + read.length + " answers from your description. They are listed in the case file under Your answers: check them, and change any that is wrong.");
    const pending = qs.find((q) => q.answer === undefined);
    if (pending) askInChat(pending);
    else if (qs.length > 0) askConfirm(form);
  }

  // The licensing step, into the interview: its next question, if any
  function licensingToChat() {
    if (!S.licensing || S.pathway) return;
    const pending = (S.licensing.questions || []).find((q) => q.answer === undefined);
    if (pending) askInChat(pending);
  }

  // A click on one option button. Two of the table engine's own synthetic
  // questions are handled here and never answered as a threshold (review of
  // 29-09-2026): "None of these / not sure" on the catalogue chooser becomes
  // the visitor's own typed sentence, which the Worker hands to the AI path
  // (a click alone can never decide by a table); and the restart prompt of a
  // stale form starts the conversation over with the visitor's own words.
  function chooseOption(q, o) {
    if (q.id === "table_catalog.choice" && o.value === "table_catalog.none") {
      S.editingQ = null;
      sendTurn("None of these describes my item, or I am not sure.");
      return;
    }
    if (q.id === "table_restart.choice") {
      restartConversation();
      return;
    }
    S.editingQ = null;
    S.licensingAnswers[q.id] = o.value;
    submitLicensing();
  }

  // The first thing the visitor typed, from the server-held transcript (a
  // message's content is a string, or a list of blocks with a text block).
  function firstUserText() {
    for (const m of S.transcript) {
      if (m.role !== "user") continue;
      if (typeof m.content === "string") { if (m.content.trim()) return m.content; continue; }
      if (Array.isArray(m.content)) {
        const t = m.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
        if (t) return t;
      }
    }
    return "";
  }

  // One click after a stale threshold form (the tables or the corpus changed
  // while the visitor was answering): the description they already gave runs
  // again, so they never retype it. Second review S3 (29-09-2026): the page
  // sends the stale transcript back with the restart answer and the Worker,
  // which finds the form stale from its own signed record, restarts from the
  // first description as the SAME conversation (it does not count as a new
  // start against the daily cap). Their description is already on screen, so
  // no second bubble is added. The answers of the dead form are dropped, and
  // the restart answer rides this one request only.
  function restartConversation() {
    if (S.busy || !firstUserText()) return;
    S.editingQ = null;
    S.licensingAnswers = { "table_restart.choice": "restart" };
    exchange("Consulting Annex I…", false);
    S.licensingAnswers = {};
  }

  // Change one answer of the threshold form, from the case file or from the
  // confirm step: the question is asked again in the interview, with its
  // buttons; the answers the visitor clicked after it may have rested on the
  // old one, so they are cleared (the prefilled ones stay in the signed record).
  function changeFormAnswer(q, answered, i) {
    for (const later of answered.slice(i + 1)) delete S.licensingAnswers[later.id];
    S.editingQ = q.id;
    askInChat(q, M.optionLabel(q, q.answer));
    renderCase();
    // the Change button was rebuilt: focus goes to the question's first option
    const first = S.live && S.live.node.querySelector(".chip, select");
    if (first) first.focus({ preventScroll: true });
  }

  // The threshold-table engine's form (INTERVIEW_MODE=tables, 28-09-2026): a
  // code-decided classification, asked as buttons before any verdict exists.
  // Its questions are asked in the interview (askInChat, like a licensing
  // question); here, the "answered, can be changed" record, as in
  // renderLicensing, and the same
  // submitLicensing() round trip: a click posts {messages, licensing_answers}
  // and the Worker returns the next form, or the verdict card once decided.
  function renderTableForm(el_, form) {
    const questions = form.questions || [];
    const answered = questions.filter((q) => q.answer !== undefined);
    // A prefilled answer (read from the visitor's own description) is shown
    // here exactly like a clicked one: answered, and changeable. It decides
    // nothing until the visitor confirms (review blocker 1, 29-09-2026), so
    // "Change" opens that question's own buttons locally (no request). What it
    // clears: the answers the visitor CLICKED after that question (they may
    // have rested on the old one). The prefilled answers after it stay (the
    // Worker holds them in the signed form and the page cannot clear them),
    // shown and each changeable; nothing decides until the Worker has a
    // confirmation, or a click that itself carries a new answer (S2, second
    // review, 29-09-2026).
    answered.forEach((q, i) => {
      el_.appendChild(qaRow(q, "Change the answer to: " + q.text, () => changeFormAnswer(q, answered, i)));
    });
    const pending = questions.find((q) => q.answer === undefined);
    if (pending || questions.length > 0) {
      el_.appendChild(el("p", { class: "next-in-chat", text: S.editingQ ? "Answer the question again in the interview." : pending ? "Next question: in the interview." : "Confirm in the interview to get the classification." }));
    }
    if (S.busy && S.stage === null && S.started) el_.appendChild(skel());
  }

  function tableFormBlock() {
    const box = el("div", { class: "licensing" });
    renderTableForm(box, S.tableForm);
    return box;
  }

  function renderCase() {
    const scroller = phone.matches ? $("panel-case") : null;
    const keep = scroller ? scroller.scrollTop : 0;
    // only the sections that hold something (operator, 29-09-2026: the empty
    // "appears here" placeholders made the page look cluttered)
    const sections = [section("cf-facts", "Facts gathered", factsBlock())];
    if (M.candidatesOf(S.transcript, S.verdict, S.tableForm).length) sections.push(section("cf-candidates", "Candidate entries", candidatesBlock()));
    if (S.tableForm) sections.push(section("cf-threshold-form", "Your answers", tableFormBlock()));
    if (M.provisionRows(S.verdict).length) sections.push(section("cf-tested", "Provisions tested", testedBlock()));
    if (S.verdict || S.stage === "card") sections.push(section("cf-classification", "Classification", classificationBlock()));
    if (S.verdict) sections.push(section("cf-licensing", "Licensing pathway", licensingBlock()));
    $("casefile").replaceChildren(...sections);
    if (scroller) scroller.scrollTop = keep;
    $("case-actions").classList.toggle("hidden", !S.verdict);
    document.body.classList.toggle("has-memo", !!S.verdict);
    // the tab says what the sheet holds, so there is a reason to open it
    const facts = M.factsOf(S.transcript).length;
    const status = S.pathway ? M.OUTCOME_LABEL[S.pathway.outcome] : S.verdict ? M.STATUS_LABEL[S.verdict.status] + (S.verdict.entry_codes.length ? " " + S.verdict.entry_codes.join(", ") : "") : S.busy ? "working" : facts ? "in progress" : "empty";
    $("sheet-summary").replaceChildren(el("span", { class: "label", text: "Case file" }), " · " + (facts ? facts + (facts === 1 ? " fact · " : " facts · ") : "") + status);
    renderStepper();
  }

  // ---------- feedback and the opt-in save (28-09-2026) ----------
  // "Was this right?" on every classification: yes or no, and a short text
  // only if the visitor writes one, kept with the case's anonymous outcome
  // data (worker/src/caseData.ts). The draft survives re-renders of the case
  // file, which rebuilds on every licensing answer.
  S.feedback = {};
  S.feedbackDraft = {};
  S.saved = {};
  const api = (path, body) =>
    fetch(cfg.WORKER_URL.replace(/\/$/, "") + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then((r) => r.json().then((d) => ({ ok: r.ok && d.ok, reason: d.reason })))
      .catch(() => ({ ok: false, reason: "network" }));

  function feedbackBlock() {
    const ref = S.caseRef;
    if (!ref || !workerReady) return null;
    const state = S.feedback[ref];
    if (state === "sent") return el("p", { class: "feedback-done", text: "Thank you. Your answer is kept with this case's anonymous outcome data." });
    const box = el("div", { class: "feedback" }, el("p", { class: "label", text: "Was this right?" }));
    box.appendChild(el("div", { class: "fb-row" },
      el("button", { class: "btn ghost", type: "button", onclick: () => sendFeedback(true, ""), text: "Yes" }),
      el("button", { class: "btn ghost", type: "button", "aria-expanded": state === "no" || state === "error" ? "true" : "false", onclick: () => { S.feedback[ref] = "no"; renderCase(); const t = $("fb-text"); if (t) t.focus(); }, text: "No, it should be\u2026" })));
    if (state === "no" || state === "error") {
      const ta = el("textarea", { class: "field", id: "fb-text", rows: "2", maxlength: "500", placeholder: "What should it be? (optional)" });
      ta.value = S.feedbackDraft[ref] || "";
      ta.addEventListener("input", () => (S.feedbackDraft[ref] = ta.value));
      box.append(el("label", { class: "visually-hidden", for: "fb-text", text: "What should it be? Optional" }), ta,
        el("p", { class: "fb-note", text: "Optional. What you write here is kept only if you write it, with this case's anonymous outcome data and without your IP address. Please do not include personal data." }),
        el("button", { class: "btn", type: "button", onclick: () => sendFeedback(false, ta.value), text: "Send" }));
      if (state === "error") box.appendChild(el("p", { class: "fb-note error", role: "status", text: "That did not go through. Please try again." }));
    }
    return box;
  }
  async function sendFeedback(right, text) {
    const ref = S.caseRef;
    const t = String(text || "").trim();
    const res = await api("/api/feedback", { ref, right, ...(t ? { text: t } : {}) });
    S.feedback[ref] = res.ok ? "sent" : "error";
    renderCase();
    if (res.ok) announce("Thank you for your feedback.");
  }

  // The opt-in on the memo: unticked unless the visitor ticks it; ticking
  // keeps the description and the answers, unticking deletes them.
  function saveBox() {
    const ref = S.caseRef;
    if (!ref || !workerReady) return null;
    const cb = el("input", { type: "checkbox", id: "save-case" });
    cb.checked = !!S.saved[ref];
    const status = el("p", { class: "fb-note", role: "status" });
    cb.addEventListener("change", async () => {
      const facts = M.factsOf(S.transcript);
      const body = cb.checked
        ? { ref, save: true, description: facts.length ? facts[0].answer : "", answers: facts.slice(1).map((f) => ({ question: String(f.question || "").replace(/\*\*/g, ""), answer: f.answer })) }
        : { ref, save: false };
      cb.disabled = true;
      const res = await api("/api/case", body);
      cb.disabled = false;
      if (res.ok) {
        S.saved[ref] = cb.checked;
        status.textContent = cb.checked ? "Saved. To delete it, untick the box, or write to privacy@osso.global with " + ref + "." : "Deleted.";
      } else {
        cb.checked = !cb.checked;
        status.textContent = "That did not go through. Please try again.";
      }
    });
    return el("div", { class: "save-case no-print" },
      el("label", { class: "wl-consent" }, cb, " Save this case anonymously to help improve Osso Export"),
      el("p", { class: "fb-note", text: "If you tick it, your description and answers are kept with the case reference " + ref + ", without your IP address or any email address, for 12 months. Untick it to delete them; later, write to privacy@osso.global with the reference." }),
      status);
  }

  // ---------- the memo: the case as one document ----------
  function renderMemo() {
    const c = memoContext();
    const v = S.verdict;
    if (!v) return;
    const facts = M.factsOf(S.transcript);
    const lic = S.licensing;
    const pw = S.pathway;
    let n = 0;
    const h = (t) => el("h2", { text: ++n + ". " + t });
    $("memo-view").replaceChildren(el("article", { class: "memo", "aria-labelledby": "memo-title" },
      el("p", { class: "label kind", text: "Osso Export Classifier" }),
      el("h1", { id: "memo-title", text: "Classification memo" }),
      el("dl", { class: "memo-meta" },
        c.reference ? [el("dt", { text: "Reference" }), el("dd", { text: c.reference })] : null,
        el("dt", { text: "Date" }), el("dd", { text: c.date }),
        v.corpus_version ? [el("dt", { text: "Corpus" }), el("dd", { text: "Regulation (EU) 2021/821, Annex I, consolidated version " + v.corpus_version })] : null,
        el("dt", { text: "Prepared with" }), el("dd", { text: AI_LINE })),
      h("Item"), el("p", { text: facts.length ? facts[0].answer : "" }),
      facts.length > 1 ? [h("Facts relied on"), factsList(facts.slice(1), true)] : null,
      h("Classification"),
      el("p", { class: "verdict-line" }, el("span", { class: "status " + v.status, text: M.STATUS_LABEL[v.status] || v.status }), v.entry_codes.length ? el("span", { class: "code", text: v.entry_codes.join(", ") }) : null),
      M.provisionRows(v).length ? [h("Provisions tested"), el("div", { class: "tested" }, M.provisionRows(v).map((r) => el("blockquote", {},
        el("div", { class: "row" }, el("span", { class: "code", text: r.path }), el("span", { class: "tag " + (r.met ? "met" : "not_met"), text: r.met ? "Met" : "Not met" })),
        el("div", { class: "provision", text: "“" + r.quote + "”" }),
        (() => { const d = el("div", { class: "expl" }); renderInline(d, r.explanation); return d; })())))] : null,
      lic ? [h("Licensing pathway"),
        (lic.questions || []).filter((q) => q.answer !== undefined).map((q) => el("p", { class: "answered" }, q.text + " ", el("strong", { text: M.optionLabel(q, q.answer) }))),
        lic.note && !pw ? el("p", { text: lic.note }) : null,
        pw ? pathwayBlock(pw, true) : lic.note ? null : el("p", { class: "caveats", text: "Not determined: the licensing questions were not all answered." })] : null,
      h("Caveats"),
      el("p", { class: "caveats", text: M.caveatsOf(v).join(" · ") }),
      bench ? el("p", { class: "caveats" }, "How accurate is it? " + benchLine + " ", el("a", { href: "#accuracy", text: "What counts as correct, and the known gaps" })) : null,
      v.disclaimer ? el("p", { class: "disclaimer", text: v.disclaimer }) : null,
      el("p", { class: "caveats no-print" }, "How this case is kept: ", el("a", { href: "#security", text: "your data and security" }), "."),
      saveBox(),
      el("div", { class: "memo-actions" },
        el("button", { class: "btn", type: "button", onclick: () => window.print(), text: "Download PDF" }),
        el("button", { class: "btn ghost", type: "button", onclick: (e) => copyMemo(e.currentTarget), text: "Copy as text" }),
        el("button", { class: "btn ghost", type: "button", onclick: () => show("case"), text: "Back to the case" }))),
      // Pro, after the memo and out of the case's way (never printed)
      el("aside", { class: "pro-note", "aria-label": "Osso Export Classifier Pro" },
        el("p", {}, el("span", { class: "label", text: "Osso Export Classifier Pro" }),
          "A version for US law, a free-text conversation with no fixed options, more than 5 chats a day, saved cases, memos with your company's own logo, and more."),
        el("button", { class: "btn ghost", type: "button", onclick: openWaitlist, text: "Join the waitlist" })));
  }
  // Printing (the "Download PDF" button, or the browser's own print) gives
  // the memo alone: the print stylesheet hides everything else once a
  // classification exists.
  window.addEventListener("beforeprint", () => { if (S.verdict) renderMemo(); });

  // ---------- talking to the Worker ----------
  // Inactivity watchdog: the Worker emits a progress line at every model-call
  // start, so healthy gaps stay well under two minutes; a longer silence
  // means a stalled stream, and without this guard the page would stay
  // locked on a pending read forever.
  const STREAM_IDLE_MS = 120000;

  async function readNdjson(resp, onProgress, abortCtl) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let data = null;
    for (;;) {
      let idleTimer;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          idleTimer = setTimeout(() => {
            if (abortCtl) abortCtl.abort();
            reject(new Error("stream stalled"));
          }, STREAM_IDLE_MS);
        }),
      ]).finally(() => clearTimeout(idleTimer));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (obj.type === "progress") onProgress(obj.stage);
        else if (obj.type === "result") data = obj.data;
      }
    }
    return data;
  }

  // A verdict or pathway response: the same recorded verdict updates the case
  // file in place; a new classification replaces it.
  function takeCard(data) {
    const lic = data.licensing || null;
    // the Worker's case reference names the recorded verdict: the same one
    // updates the case file, a new one is a new classification
    const same = !!data.case_ref && data.case_ref === S.caseRef;
    if (!same) {
      S.verdictUnseen = true;
      S.determinedOn = today();
      S.caseRef = data.case_ref || null;
    }
    S.verdict = data.verdict;
    S.licensing = lic;
    S.pathway = data.pathway || null;
    S.tableForm = null; // the threshold form it may have come from is settled
    return !same;
  }

  function setBusy(busy) {
    S.busy = busy;
    // a disabled button drops focus to the page; keep it in the composer
    // (29-09-2026) so a keyboard or screen-reader visitor stays where they typed
    // (Safari does not focus a clicked button, so focus may be on <main> instead.)
    const held = document.activeElement;
    if (busy && (held === sendBtn || held === $("main"))) input.focus({ preventScroll: true });
    sendBtn.disabled = busy;
    waitEl.classList.toggle("hidden", !busy);
    if (!busy) S.stage = null;
    renderCase();
    syncComposer();
  }

  function setWait(text) {
    if (!text) return;
    S.wait = text;
    waitEl.textContent = text;
  }

  async function exchange(firstCopy, fromLicensing) {
    if (!workerReady) {
      showNotice(["The assistant is not connected yet", "Browse Annex I works fully."], false);
      return;
    }
    S.stage = fromLicensing ? null : "interview";
    setWait(firstCopy);
    setBusy(true);
    announce("Osso is working on it.");
    messagesEl.after(waitEl);
    if (following && !fromLicensing) reveal(waitEl);
    let interviewSteps = 0;
    const onProgress = (stage) => {
      if (stage === "interview") interviewSteps += 1;
      if (stage.startsWith("card:")) {
        S.stage = "card";
        renderCase();
      }
      setWait(M.progressCopy(stage, interviewSteps));
    };
    try {
      const abortCtl = typeof AbortController === "function" ? new AbortController() : null;
      const resp = await fetch(cfg.WORKER_URL.replace(/\/$/, "") + "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson", ...(testerKey ? { "x-tester-key": testerKey } : {}) },
        body: JSON.stringify({ messages: S.transcript, licensing_answers: S.licensingAnswers }),
        ...(abortCtl ? { signal: abortCtl.signal } : {}),
      });
      const streamed = (resp.headers.get("content-type") || "").includes("application/x-ndjson");
      const data = streamed && resp.body ? await readNdjson(resp, onProgress, abortCtl) : await resp.json();
      if (!data) throw new Error("empty stream");
      if (data.type === "question") {
        S.transcript = data.messages;
        // typed text while a form was open (or "None of these" on the
        // catalogue) went to the assistant: that form is dead, not a stale
        // set of buttons under the new question (review, 29-09-2026)
        S.tableForm = null;
        S.editingQ = null;
        closeLive();
        setBusy(false);
        addBubble("assistant", data.text);
      } else if (data.type === "form") {
        // the threshold-table engine (INTERVIEW_MODE=tables): code decided
        // to ask exact thresholds as buttons. Each question is asked in the
        // interview with its options as buttons (formToChat, operator,
        // 29-09-2026); the case file records the answers, and a click re-runs
        // exchange the same way as a licensing answer.
        S.transcript = data.messages;
        S.tableForm = data.form;
        S.editingQ = null;
        setBusy(false);
        if (!S.started) {
          S.started = true;
          document.body.classList.add("started");
          input.placeholder = "Answer the question, or add a fact";
        }
        // not on the restart prompt or the catalogue chooser: neither means the
        // item matched a table (second review S3, 29-09-2026)
        const formId = (data.form && data.form.questions && data.form.questions[0] && data.form.questions[0].id) || "";
        const matchedTable = formId !== "table_catalog.choice" && formId !== "table_restart.choice";
        if (matchedTable && !S.tableIntro) {
          S.tableIntro = true;
          addBubble("assistant", "The item matches a threshold table. I will ask the exact figures the regulation turns on, one question at a time; code decides from your answers.");
        }
        formToChat(data.form);
        followCase("cf-threshold-form");
      } else if (data.type === "verdict" || data.type === "pathway") {
        S.transcript = data.messages;
        if (data.text) addBubble("assistant", data.text);
        const fresh = takeCard(data);
        closeLive();
        setBusy(false);
        if (fresh) {
          const v = data.verdict;
          const said = M.STATUS_LABEL[v.status] + (v.entry_codes.length ? ": " + v.entry_codes.join(", ") : "");
          addBubble("assistant", "Classification: **" + said + "**. Each provision it rests on is quoted in the case file." + (S.licensing ? " Now the export licence." : ""));
          if (phone.matches) addCaseLine("Classification ready. " + said + ".");
          if (!phone.matches) {
            S.verdictUnseen = false;
            document.body.classList.remove("case-hidden"); // the result is worth showing
            focusCase("cf-classification");
          }
        } else if (S.pathway) {
          const said = (M.OUTCOME_LABEL[S.pathway.outcome] || S.pathway.outcome) + (S.pathway.eligible_gea ? " (" + S.pathway.eligible_gea + ")" : "");
          addBubble("assistant", "Licence: **" + said + "**. The conditions are quoted in the case file, and the memo is ready to download.");
          if (phone.matches) addCaseLine("Licensing pathway ready.");
          if (!phone.matches) focusCase("cf-licensing");
        } else {
          followCase("cf-licensing");
        }
        licensingToChat();
        syncComposer();
      } else {
        setBusy(false);
        const reason = data.reason || "unknown";
        if (reason === "region_unavailable") showNotice(REGION, true);
        else if (reason === "daily_budget_exhausted") {
          // the chat refusal does not say which limit: ask the health check
          showPaused("day");
          refreshStatus();
        }
        else if (reason === "service_paused") showPaused("service");
        // 28-09-2026: reworded from "The assistant cannot classify this item
        // automatically" so a visitor is told plainly WHO declined — the
        // notice now ships only after the Worker has already retried once on
        // the refusal-fallback model (claudeClient.ts, RefusalFallbackClient)
        // and that retry declined too.
        else if (reason === "model_refusal") addBubble("assistant", "Anthropic, the AI provider behind this assistant, refused to process this request. Please have this item reviewed by your licensing authority or a qualified professional. Browse Annex I stays fully available.");
        else if (reason === "rate_limited") showNotice(["You have used today's 5 free chats", "More chats a day are planned for Pro. Browse Annex I stays fully available, and the assistant is back tomorrow."], true, true);
        else if (reason === "conversation_too_long") addBubble("assistant", "This conversation has reached its length limit. Please start a new one by reloading the page.");
        else addBubble("assistant", "Something went wrong upstream. Please try again in a moment.");
      }
    } catch {
      setBusy(false);
      addBubble("assistant", "The connection failed. Please try again.");
      // a limit the Worker could not report in its reply still shows as the banner
      refreshStatus();
    }
  }

  function announce(text) {
    $("announce").textContent = "";
    setTimeout(() => ($("announce").textContent = text), 50);
  }

  function sendTurn(text) {
    if (!S.started) {
      S.started = true;
      document.body.classList.add("started");
      input.placeholder = "Answer the question, or add a fact";
    }
    addBubble("user", text, true); // sending is the visitor's own move: show it
    S.transcript = S.transcript.concat([{ role: "user", content: text }]);
    return exchange("Consulting Annex I…", false);
  }

  // a licensing button: no new message, the Worker answers from its tables
  function submitLicensing() {
    if (S.busy) return;
    exchange(S.tableForm ? "Checking your answers against the thresholds…" : "Checking the authorisation against the corpus…", true);
  }

  // a fresh page is a clean case: nothing of the old one can leak into it
  $("new-case-btn").addEventListener("click", () => location.reload());

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    if (sendBtn.disabled) return; // a turn is already in flight: Enter must not double-fire
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendTurn(text);
  });

  // ---------- browse: Annex I as a tree ----------
  // Category titles and product groups as Annex I names them.
  const CATEGORY = {
    0: "Nuclear materials, facilities and equipment", 1: "Special materials and related equipment", 2: "Materials processing",
    3: "Electronics", 4: "Computers", 5: "Telecommunications and information security", 6: "Sensors and lasers",
    7: "Navigation and avionics", 8: "Marine", 9: "Aerospace and propulsion",
  };
  const GROUP = { A: "Systems, equipment and components", B: "Test, inspection and production equipment", C: "Materials", D: "Software", E: "Technology" };
  let annex = null;
  let annexLoading = null;
  const searchEl = $("search");
  const resultsEl = $("browse-results");
  const metaEl = $("browse-meta");

  function ensureAnnexLoaded() {
    if (annex) return Promise.resolve(annex);
    if (annexLoading) return annexLoading;
    metaEl.textContent = "Loading Annex I…";
    resultsEl.replaceChildren(skel());
    annexLoading = fetch(cfg.ANNEX_URL)
      .then((r) => r.json())
      .then((a) => {
        annex = a;
        metaEl.textContent = a.entry_count + " entries · consolidated version " + a.corpus_version + (a.valid_from ? " · in force since " + a.valid_from : "");
        renderBrowse(searchEl.value || "");
        renderCase(); // candidate titles and thresholds come from the corpus
        return a;
      })
      .catch(() => {
        annexLoading = null;
        metaEl.textContent = "Could not load Annex I. Please try again.";
        resultsEl.replaceChildren(el("button", { class: "btn ghost", type: "button", onclick: ensureAnnexLoaded, text: "Try again" }));
        return null;
      });
    return annexLoading;
  }

  // append `text` to `parent`, wrapping case-insensitive matches of q in <mark>
  function appendHighlighted(parent, text, q) {
    if (!q) return parent.appendChild(document.createTextNode(text));
    const lower = text.toLowerCase();
    let pos = 0;
    for (let hit; (hit = lower.indexOf(q, pos)) !== -1; pos = hit + q.length) {
      parent.appendChild(document.createTextNode(text.slice(pos, hit)));
      parent.appendChild(el("mark", { text: text.slice(hit, hit + q.length) }));
    }
    parent.appendChild(document.createTextNode(text.slice(pos)));
  }

  function entryDetails(e, q, open) {
    const det = el("details", { class: "entry", id: "entry-" + e.entry_code, open: open || null });
    const sum = el("summary", {});
    const firstLine = e.verbatim_text.split("\n", 1)[0];
    appendHighlighted(sum, firstLine.length > 140 ? firstLine.slice(0, 137) + "…" : firstLine, q);
    det.appendChild(sum);
    const pre = el("pre");
    const paramSet = new Set(e.parameters || []);
    for (const line of e.verbatim_text.split("\n")) {
      const span = el("span", { class: paramSet.has(line) ? "param" : null }); // threshold lines highlighted
      appendHighlighted(span, line, q);
      pre.append(span, "\n");
    }
    det.appendChild(pre);
    det.addEventListener("toggle", () => { if (det.open) history.replaceState(null, "", "#" + e.entry_code); });
    return det;
  }

  function renderBrowse(query, openCode) {
    if (!annex) return;
    const q = query.trim().toLowerCase();
    const hits = annex.entries.filter((e) => !q || e.entry_code.toLowerCase().includes(q) || e.verbatim_text.toLowerCase().includes(q));
    const LIMIT = 80;
    let budget = q ? LIMIT : Infinity;
    const cats = [];
    for (const c of Object.keys(CATEGORY)) {
      const inCat = hits.filter((e) => e.entry_code[0] === c);
      if (!inCat.length) continue;
      const groups = [];
      for (const g of Object.keys(GROUP)) {
        const inGroup = inCat.filter((e) => e.entry_code[1] === g);
        if (!inGroup.length || budget <= 0) continue;
        const shown = inGroup.slice(0, budget);
        budget -= shown.length;
        const openGroup = !!q || (openCode && openCode.startsWith(c + g));
        groups.push(el("details", { class: "group", open: openGroup || null },
          el("summary", {}, el("span", { class: "n", text: c + g }), el("span", { text: GROUP[g] }), el("span", { class: "count", text: String(inGroup.length) })),
          el("div", { class: "entries" }, shown.map((e) => entryDetails(e, q, e.entry_code === openCode)))));
      }
      if (!groups.length) continue;
      cats.push(el("details", { class: "category", open: !!q || (openCode && openCode[0] === c) || null },
        el("summary", {}, el("span", { class: "n", text: "Category " + c }), el("span", { text: CATEGORY[c] }), el("span", { class: "count", text: String(inCat.length) })),
        groups));
    }
    resultsEl.replaceChildren(...cats);
    if (q && hits.length > LIMIT) resultsEl.appendChild(el("p", { class: "meta", text: "Showing " + LIMIT + " of " + hits.length + " matches. Refine the search to see the rest." }));
    if (!hits.length) resultsEl.appendChild(el("p", { class: "meta", text: "No entry matches. Remember: catch-all controls can apply to items that are not listed." }));
  }

  async function openEntryInBrowse(code) {
    show("browse");
    const data = await ensureAnnexLoaded();
    if (!data) return;
    searchEl.value = "";
    renderBrowse("", code);
    const target = $("entry-" + code);
    if (target) {
      target.scrollIntoView({ block: "start" });
      target.querySelector("summary").focus({ preventScroll: true });
      history.replaceState(null, "", "#" + code);
    }
  }

  let debounce = null;
  searchEl.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => renderBrowse(searchEl.value), 150);
  });

  // ---------- Pro: the waitlist ----------
  // An email address and, optionally, a company, on the visitor's consent,
  // to the Worker's KV (POST /api/waitlist, worker/src/waitlist.ts). The
  // page states what is kept, in one line, with the privacy notice linked.
  const wl = $("waitlist");
  function openWaitlist() {
    if (typeof wl.showModal === "function") wl.showModal();
    else wl.setAttribute("open", "");
    const email = $("wl-email");
    if (email) email.focus();
  }
  $("wl-close").addEventListener("click", () => (typeof wl.close === "function" ? wl.close() : wl.removeAttribute("open")));
  for (const b of document.querySelectorAll("[data-waitlist]")) b.addEventListener("click", openWaitlist);
  $("wl-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("wl-status");
    const say = (text, error) => {
      status.textContent = text;
      status.classList.toggle("error", !!error);
    };
    const email = $("wl-email");
    if (!email.value.trim() || !email.checkValidity()) return say("Please enter a valid email address.", true), email.focus();
    if (!$("wl-consent").checked) return say("Please tick the box to agree to be contacted about Pro.", true), $("wl-consent").focus();
    if (!workerReady) return say("The waitlist is not connected yet. Please try again later.", true);
    $("wl-send").disabled = true;
    say("Sending\u2026");
    try {
      const resp = await fetch(cfg.WORKER_URL.replace(/\/$/, "") + "/api/waitlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.value.trim(), company: $("wl-company").value.trim(), consent: true }),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.ok) {
        $("wl-form").replaceChildren(el("p", { class: "wl-done", role: "status", text: "You are on the list. We will write when Pro opens. To withdraw, write to privacy@osso.global." }));
        return;
      }
      const reason = data.reason || "";
      say(reason === "rate_limited" ? "Too many signups from this connection today. Please try again tomorrow."
        : reason === "invalid_email" ? "Please enter a valid email address."
        : reason === "invalid_company" ? "Please shorten the company name."
        : "The signup did not go through. Please try again later.", true);
    } catch {
      say("The connection failed. Please try again.", true);
    }
    $("wl-send").disabled = false;
  });

  // ---------- How accurate is it? ----------
  // The figure and the known gaps come from config.js (BENCHMARK), so a new
  // benchmark run updates the page without touching the layout.
  const bench = cfg.BENCHMARK;
  const benchDate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  // The total first (operator, 29-09-2026: "start with 90 out of 100"), then
  // the hard edge cases and the everyday products; nothing omitted.
  const benchLine = bench && bench.typical && bench.hard
    ? bench.correct + " out of " + bench.cases + " real products classified correctly in the published benchmark, " + benchDate(bench.date) + ": " + bench.hard.correct + " of " + bench.hard.cases + " deliberately hard edge cases and " + bench.typical.correct + " of " + bench.typical.cases + " everyday products."
    : bench ? bench.correct + " out of " + bench.cases + " real products classified correctly in the published benchmark, " + benchDate(bench.date) + "." : "";
  if (bench) {
    $("acc-figure").textContent = benchLine;
    $("acc-gaps").replaceChildren(...(bench.gaps || []).map((g) => el("li", { text: g })));
    $("accuracy").classList.remove("hidden");
    $("gaps").classList.remove("hidden");
    // the figure sits low and quiet, in its own section (operator, 28-09-2026):
    // the start screen only links to it
    $("acc-teaser").replaceChildren(
      el("a", { href: "#accuracy", text: "How accurate is it?" }), " \u00B7 ", el("a", { href: "#security", text: "Your data and security" }));
    $("acc-teaser").classList.remove("hidden");
  }

  // the footer's and the start screen's links to the accuracy and data
  // sections work from Browse too: they bring the Classifier view back first
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest('a[href="#accuracy"], a[href="#security"]');
    if (!a || !document.body.classList.contains("view-browse")) return;
    e.preventDefault();
    show("case");
    const target = $(a.getAttribute("href").slice(1));
    if (target) target.scrollIntoView({ block: "start" });
  });

  // ---------- the notice, once (operator, 29-09-2026) ----------
  // What used to sit above the interview: now a dialog the visitor closes with
  // OK, before the first message of every session (the disclosure rule of
  // 28-09-2026 holds: every session sees it). The one-line AI notice under the
  // text box stays on screen at all times. Storage blocked: it shows each load.
  const NOTICE_KEY = "osso_notice_ok_v1";
  const noticeSeen = () => { try { return sessionStorage.getItem(NOTICE_KEY) === "1"; } catch { return false; } };
  $("notice-ok").addEventListener("click", () => {
    try { sessionStorage.setItem(NOTICE_KEY, "1"); } catch { /* shown again on the next load */ }
    const d = $("notice");
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
  });
  if (!noticeSeen()) {
    const d = $("notice");
    // once per load: the 7 s fallback reopened it after OK (01-10-2026)
    let noticeOpened = false;
    const open = () => { if (noticeOpened) return; noticeOpened = true; if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", ""); };
    // a modal's backdrop sits above everything, the intro too: wait for it
    // (01-10-2026), and never longer than 7 s, so the disclosure always shows
    if (document.documentElement.classList.contains("intro-on")) {
      document.addEventListener("osso:intro-done", open, { once: true });
      setTimeout(open, 7000);
    } else open();
  }

  // ---------- start ----------
  renderCase();
  refreshStatus();
  // the corpus gives candidate entries their titles and thresholds: load it
  // once a case starts, in the background
  form.addEventListener("submit", () => { if (!annex) ensureAnnexLoaded(); }, { once: true });
  // permalink: #3A001 opens that entry in Browse
  // a malformed hash (a lone "%") makes decodeURIComponent throw: ignore it
  // (29-09-2026, security audit) instead of stopping the page's start
  let hashCode = "";
  try { hashCode = decodeURIComponent(location.hash.replace("#", "")).toUpperCase(); } catch (e) { /* malformed: no permalink */ }
  if (/^\d[A-E]\d{3}$/.test(hashCode)) openEntryInBrowse(hashCode);
  // links from Osso Export Watch's top bar (29-09-2026): #browse opens Browse
  // Annex I, #pro the Pro waitlist
  else if (hashCode === "BROWSE") show("browse");
  else if (hashCode === "PRO") openWaitlist();
})();
