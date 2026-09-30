// Osso Export Classifier: the case model. Pure functions, no DOM, no network:
// they derive the case file from what the Worker already returns (the
// transcript, the verdict, the licensing step and the pathway) and from the
// corpus the page loads for Browse. Nothing here is written by a model or
// guessed from prose: facts are the visitor's own words, candidate entries
// are the codes the model looked up (lookup_entries) or cited (final_answer),
// thresholds are the corpus's own parameter lines, and every disclaimer is
// the one the Worker appended. worker/test/overhaul-a-2026-09-28.test.ts runs
// these functions on real Worker responses.
(function (root) {
  "use strict";

  const STATUS_LABEL = { listed: "Listed in Annex I", not_listed: "Not listed in Annex I", needs_expert: "Needs expert review" };
  const OUTCOME_LABEL = {
    gea_available: "EU general export authorisation available",
    individual_licence_required: "Individual authorisation required",
    sanctions_review_required: "Sanctions regime: legal review required",
  };
  const STEPS = ["describe", "clarify", "classify", "licence"];
  const MAX_CANDIDATES = 8;

  function entryCode(x) {
    const m = /^(\d[A-E]\d{3})/i.exec(String(x == null ? "" : x).trim());
    return m ? m[1].toUpperCase() : null;
  }

  function textOf(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.filter((b) => b && b.type === "text").map((b) => String(b.text || "")).join("\n");
  }

  // What the visitor typed in one user turn: a string, or the text blocks of
  // an array. Tool results are not the visitor's, and the Worker's own
  // nudges carry the "[system]" marker (worker/src/transcript.ts).
  function typedText(content) {
    const parts = typeof content === "string" ? [content]
      : Array.isArray(content) ? content.filter((b) => b && b.type === "text").map((b) => String(b.text || "")) : [];
    return parts.filter((t) => t.trim() && !t.startsWith("[system]")).join("\n").trim();
  }

  // The visitor's own words: the description, then each answer with the
  // question it answered (the last assistant text before it).
  function factsOf(messages) {
    const out = [];
    let asked = null;
    for (const m of messages || []) {
      if (m.role === "assistant") {
        const t = textOf(m.content).trim();
        if (t) asked = t;
      } else if (m.role === "user") {
        const t = typedText(m.content);
        if (!t) continue;
        out.push({ question: out.length ? asked : null, answer: t });
        asked = null;
      }
    }
    return out;
  }

  // Entries in play, oldest first: every code the model looked up, then every
  // entry a final_answer cites (the same rule as the Worker's default picker,
  // worker/src/candidates.ts).
  // On the threshold-table path no lookup or final answer exists yet: the
  // entries in play are the ones the open form is checking. They are read from
  // what the Worker already returns and never guessed: the scopes of the
  // conversation's last recorded threshold_form (the transcript carries it),
  // then the provision path each question of the form quotes (the form
  // itself). A catalogue or restart question names no provision, so it adds
  // nothing (29-09-2026).
  function formEntriesOf(messages, form) {
    const out = [];
    const add = (c) => {
      const code = entryCode(c);
      if (code && !out.includes(code)) out.push(code);
    };
    let last = null;
    for (const m of messages || []) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content) if (b && b.type === "tool_use" && b.name === "threshold_form") last = b;
    }
    const scopes = last && last.input && Array.isArray(last.input.scopes) ? last.input.scopes : [];
    scopes.forEach(add);
    for (const q of (form && form.questions) || []) add(q && q.quote && q.quote.path);
    return out;
  }

  function candidatesOf(messages, verdict, form) {
    const seen = [];
    const add = (c) => {
      const code = entryCode(c);
      if (code && !seen.includes(code)) seen.push(code);
    };
    formEntriesOf(messages, form).forEach(add);
    for (const m of messages || []) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (!b || b.type !== "tool_use") continue;
        const input = b.input || {};
        if (b.name === "lookup_entries" && Array.isArray(input.codes)) input.codes.slice(0, 6).forEach(add);
        if (b.name === "final_answer") {
          (Array.isArray(input.entry_codes) ? input.entry_codes : []).forEach(add);
          (Array.isArray(input.reasoning) ? input.reasoning : []).forEach((r) => add(r && r.entry_code));
        }
      }
    }
    if (verdict) {
      (verdict.entry_codes || []).forEach(add);
      (verdict.reasoning || []).forEach((r) => add(r.entry_code));
    }
    return seen.slice(0, MAX_CANDIDATES);
  }

  const normPath = (p) => String(p || "").trim().replace(/\.+$/, "").toLowerCase();

  // An entry's thresholds are the corpus's parameter lines. Once a verdict
  // is in, a line it tested says met or not met; the rest stay open.
  function thresholdsOf(entry, verdict) {
    const tested = new Map();
    for (const r of (verdict && verdict.reasoning) || []) tested.set(normPath(r.dotted_path), r.met === false ? "not_met" : "met");
    return ((entry && entry.parameters) || []).map((line) => {
      const path = String(line).split(/\s/, 1)[0];
      return { path, text: String(line).slice(path.length).trim(), state: tested.get(normPath(path)) || "open" };
    });
  }

  // The provisions a verdict tested. The Worker attaches an ancestor's
  // Technical Notes to every sub-item they govern; they show in full once,
  // and every later row says "shown above".
  function provisionRows(verdict) {
    const shown = new Set();
    return ((verdict && verdict.reasoning) || []).map((r) => {
      const lines = String(r.verbatim_quote || "").split("\n").map((line) => {
        const m = /^(\d[A-E]\d{3}\S*) Technical Notes?\b/.exec(line);
        if (!m) return line;
        if (shown.has(line)) return m[1] + " Technical Notes: shown above.";
        shown.add(line);
        return line;
      });
      return { path: r.dotted_path, entry: entryCode(r.entry_code) || "", met: r.met !== false, quote: lines.join("\n"), explanation: r.explanation || "" };
    });
  }

  function caveatsOf(x) {
    // the Worker's disclaimer already says "not legal advice"; model caveats
    // repeating it would say it three times
    return ((x && x.caveats) || []).filter((c) => !/not legal advice/i.test(c));
  }

  // Where the case stands, for the stepper.
  function stepOf(s) {
    if (!s.started) return { current: "describe", done: [] };
    if (!s.verdict) return { current: s.stage === "card" ? "classify" : "clarify", done: ["describe"] };
    const lic = s.licensing;
    const finished = s.pathway || !lic || lic.note;
    if (finished) return { current: null, done: STEPS.slice() };
    return { current: "licence", done: ["describe", "clarify", "classify"] };
  }

  // What the wait line says, from the stages the Worker streams.
  function progressCopy(stage, interviewSteps) {
    if (stage === "card:final_answer") return "Drafting the classification and checking every quote against the corpus…";
    if (stage === "ask-fallback") return "Preparing the next question…";
    if (stage === "interview") {
      return interviewSteps <= 1 ? "Consulting Annex I…" : interviewSteps === 2 ? "Reading the cited entries…" : "Cross-checking notes and definitions…";
    }
    return null;
  }

  // The first sentence of a question, for the case file's record of answers
  // (the chat keeps the whole question). A full stop after e.g., i.e., vs. and
  // the like, or inside a number, is not a sentence end. A first sentence
  // under 25 characters is not a summary: the whole text stays.
  function firstSentence(text) {
    const t = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    const re = /[.?!]["\u201d')]*\s+(?=\S)/g;
    for (let m; (m = re.exec(t)); ) {
      if (/(?:^|[\s(])(?:e\.g|i\.e|vs|approx|cf|etc|no|fig)$/i.test(t.slice(0, m.index))) continue;
      const cut = m.index + m[0].trimEnd().length;
      return cut >= 25 ? t.slice(0, cut) : t;
    }
    return t;
  }

  function optionLabel(q, value) {
    const o = ((q && q.options) || []).find((x) => x.value === value);
    return o ? o.label : value;
  }

  // The memo as plain text, for "Copy as text". Same content as the memo.
  function memoText(c) {
    const v = c.verdict;
    const lines = ["Osso Export Classifier: classification memo (indicative triage, not legal advice)"];
    if (c.reference) lines.push("Reference: " + c.reference);
    lines.push("Date: " + c.date);
    if (v && v.corpus_version) lines.push("Corpus: Regulation (EU) 2021/821, Annex I, consolidated version " + v.corpus_version);
    const facts = factsOf(c.messages);
    if (facts.length) {
      lines.push("", "Item: " + facts[0].answer);
      for (const f of facts.slice(1)) lines.push("Q: " + String(f.question || "").replace(/\*\*/g, ""), "A: " + f.answer);
    }
    if (v) {
      lines.push("", "Classification: " + (STATUS_LABEL[v.status] || v.status) + (v.entry_codes.length ? " (" + v.entry_codes.join(", ") + ")" : ""));
      for (const r of provisionRows(v)) {
        lines.push("- " + r.path + (r.met ? "" : " (not met)") + ': "' + r.quote.split("\n").join("\n    ") + '"');
        if (r.explanation) lines.push("    " + r.explanation);
      }
    }
    const pw = c.pathway;
    const lic = c.licensing;
    if (lic || pw) {
      lines.push("", "Licensing pathway");
      for (const q of (lic && lic.questions) || []) if (q.answer !== undefined) lines.push("Answer: " + q.text + " " + optionLabel(q, q.answer));
      if (lic && lic.note && !pw) lines.push(lic.note);
      if (pw) {
        lines.push("Outcome: " + (OUTCOME_LABEL[pw.outcome] || pw.outcome) + (pw.eligible_gea ? " (" + pw.eligible_gea + ")" : "") + " · destination: " + pw.destination);
        for (const q of pw.conditions_quoted || []) {
          lines.push("- " + q.gea_id + ': "' + q.verbatim_quote + '"');
          if (q.explanation) lines.push("    " + q.explanation);
        }
        for (const cv of caveatsOf(pw)) lines.push("Caveat: " + cv);
        if (pw.disclaimer) lines.push(pw.disclaimer);
      }
    }
    if (v) {
      lines.push("");
      for (const cv of caveatsOf(v)) lines.push("Caveat: " + cv);
      if (v.disclaimer) lines.push(v.disclaimer);
    }
    lines.push("", c.aiLine, c.siteUrl || "");
    return lines.join("\n");
  }

  root.OssoCaseModel = {
    STATUS_LABEL, OUTCOME_LABEL, STEPS,
    entryCode, textOf, typedText, factsOf, candidatesOf, formEntriesOf, firstSentence, thresholdsOf, provisionRows, caveatsOf, stepOf, progressCopy, optionLabel, memoText,
  };
})(typeof window !== "undefined" ? window : globalThis);
