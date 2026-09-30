// Deployment configuration.
//
// Where the site lives: every absolute URL of the page comes from HOST. The
// move to osso.global (the classifier at the apex, the watcher at
// watch.osso.global, the Worker API at api.osso.global) is this one line,
// "github" to "osso", then `node scripts/stamp-urls.mjs` to write the same
// URLs into the HTML (canonical, og:url, og:image, the Watch links, the CSP's
// connect-src), which a test keeps in step. The Worker already accepts both
// origins (worker/wrangler.toml, ALLOWED_ORIGINS).
const HOST = "osso";
const HOSTS = {
  github: {
    SITE_URL: "https://rikiosso.github.io/dualuse-classifier/",
    WATCH_URL: "https://rikiosso.github.io/exports-watch/",
    WORKER_URL: "https://dualuse-classifier.rikiosso.workers.dev",
    ANNEX_URL: "https://rikiosso.github.io/exports-watch/data/annex.json",
  },
  osso: {
    SITE_URL: "https://osso.global/",
    WATCH_URL: "https://watch.osso.global/",
    WORKER_URL: "https://api.osso.global",
    ANNEX_URL: "https://watch.osso.global/data/annex.json",
  },
};
window.CLASSIFIER_CONFIG = {
  ...HOSTS[HOST],
  // "How accurate is it?": the latest published benchmark run, as recorded in
  // docs/benchmark.md. Update these values, not the page, after a new run;
  // worker/test/overhaul-a-2026-09-28.test.ts checks them against the table.
  BENCHMARK: {
    cases: 100,
    correct: 92,
    date: "2026-09-30",
    typical: { cases: 61, correct: 55 },
    hard: { cases: 39, correct: 37 },
    gaps: [
      "All eight misses were cautious ones: the tool said needs expert review where the expected answer was a definite listed or not listed. None gave a wrong listed or not-listed result.",
      "Where no threshold table exists yet (15 of the 100 cases), the AI interview decides, as before, and is less predictable than the tables.",
      "The same product does not always get the same answer: between two runs of the same cases, some flipped each way. Read the score as about 92, not exactly 92.",
      "The score is on the benchmark's own 100 cases, and its earlier misses were used to build the tables. Every card must be reviewed by a qualified professional before use.",
    ],
  },


};
