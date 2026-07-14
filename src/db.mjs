// SQLite store for the GSC index checker. One local file (gsc.db), no server,
// no auth. Holds current page state, full check history, and a logs feed.
// A logBus EventEmitter fires on every log() so the dashboard can stream the
// raw process live (Server-Sent Events).
//
// The store is PROPERTY-SCOPED: every page and check row belongs to a Search
// Console property (`site`), so a single database can track many properties
// independently without their data colliding.

import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Data files live at the project root (one level up from src/). Both paths can
// be overridden for testing / power use via env vars.
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.GSC_DB ? path.resolve(process.env.GSC_DB) : path.resolve(ROOT, 'gsc.db');
const RESULTS_JSON = process.env.GSC_RESULTS
  ? path.resolve(process.env.GSC_RESULTS)
  : path.resolve(ROOT, 'results.json');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safe concurrent reads + crash-safe writes

// Fresh-database schema. For an existing OLD database these CREATE-IF-NOT-EXISTS
// statements are no-ops (the tables already exist); migrateToMultiProperty()
// below upgrades that older shape. No index on checks(site,...) here — the
// column may not exist yet on an old DB; it's created after migration.
db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    site            TEXT NOT NULL DEFAULT '',
    url             TEXT NOT NULL,
    is_indexed      INTEGER,
    verdict         TEXT,
    coverage_state  TEXT,
    last_crawl_time TEXT,
    robots_txt_state TEXT,
    indexing_state  TEXT,
    last_checked_at TEXT,
    PRIMARY KEY (site, url)
  );
  CREATE TABLE IF NOT EXISTS checks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    site       TEXT,
    url        TEXT NOT NULL,
    is_indexed INTEGER,
    verdict    TEXT,
    coverage_state TEXT,
    checked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      TEXT,
    level   TEXT,
    event   TEXT,
    url     TEXT,
    message TEXT,
    raw     TEXT
  );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ---- migrate older single-property databases ------------------------------
// Older versions keyed `pages` by URL only (no `site` column) and `checks` had
// no `site`. If we detect that shape, rebuild/upgrade the tables and stamp the
// existing rows with the property they were last checked under (meta.siteUrl),
// so nothing is lost. Runs before any page/check statement is prepared.
(function migrateToMultiProperty() {
  const hasCol = (table, col) =>
    db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const legacySite = db.prepare('SELECT value FROM meta WHERE key=?').get('siteUrl')?.value || '';

  if (!hasCol('pages', 'site')) {
    db.transaction(() => {
      db.exec(`CREATE TABLE pages_new (
        site TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
        is_indexed INTEGER, verdict TEXT, coverage_state TEXT,
        last_crawl_time TEXT, robots_txt_state TEXT, indexing_state TEXT, last_checked_at TEXT,
        PRIMARY KEY (site, url)
      );`);
      db.prepare(
        `INSERT OR IGNORE INTO pages_new
           (site,url,is_indexed,verdict,coverage_state,last_crawl_time,robots_txt_state,indexing_state,last_checked_at)
         SELECT ?,url,is_indexed,verdict,coverage_state,last_crawl_time,robots_txt_state,indexing_state,last_checked_at
         FROM pages`
      ).run(legacySite);
      db.exec('DROP TABLE pages;');
      db.exec('ALTER TABLE pages_new RENAME TO pages;');
    })();
    console.log(`[gsc.db] upgraded pages -> multi-property (existing rows: site="${legacySite || 'unknown'}")`);
  }

  if (!hasCol('checks', 'site')) {
    db.transaction(() => {
      db.exec('ALTER TABLE checks ADD COLUMN site TEXT;');
      db.prepare('UPDATE checks SET site=? WHERE site IS NULL').run(legacySite);
    })();
  }
})();

// Now that both tables definitely have `site`, create the lookup index.
db.exec('CREATE INDEX IF NOT EXISTS idx_checks_site_url ON checks(site, url);');

const toInt = (v) => (v === true ? 1 : v === false ? 0 : null);
const toBool = (v) => (v === 1 ? true : v === 0 ? false : null);
const rowToPage = (row) => ({
  isIndexed: toBool(row.is_indexed),
  verdict: row.verdict,
  coverageState: row.coverage_state,
  lastCrawlTime: row.last_crawl_time,
  robotsTxtState: row.robots_txt_state,
  indexingState: row.indexing_state,
  lastCheckedAt: row.last_checked_at,
});

// ---- meta -----------------------------------------------------------------
const _setMeta = db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const _getMeta = db.prepare('SELECT value FROM meta WHERE key=?');
export const setMeta = (k, v) => _setMeta.run(k, String(v));
export const getMeta = (k) => _getMeta.get(k)?.value ?? null;

// ---- pages + checks (all scoped by `site`) --------------------------------
const _upsertPage = db.prepare(`
  INSERT INTO pages (site,url,is_indexed,verdict,coverage_state,last_crawl_time,robots_txt_state,indexing_state,last_checked_at)
  VALUES (@site,@url,@is_indexed,@verdict,@coverage_state,@last_crawl_time,@robots_txt_state,@indexing_state,@last_checked_at)
  ON CONFLICT(site,url) DO UPDATE SET
    is_indexed=excluded.is_indexed, verdict=excluded.verdict, coverage_state=excluded.coverage_state,
    last_crawl_time=excluded.last_crawl_time, robots_txt_state=excluded.robots_txt_state,
    indexing_state=excluded.indexing_state, last_checked_at=excluded.last_checked_at
`);
const _insCheck = db.prepare(
  'INSERT INTO checks (site,url,is_indexed,verdict,coverage_state,checked_at) VALUES (?,?,?,?,?,?)'
);

// Save an inspection result for a property. `site` is the Search Console
// property URL (e.g. "sc-domain:example.com"); `r` = shape from gsc.inspectUrl.
// Records both the current state (pages) and a history row (checks).
export const savePage = db.transaction((site, url, r) => {
  const ii = toInt(r.isIndexed);
  const when = r.lastCheckedAt ?? new Date().toISOString();
  _upsertPage.run({
    site: site || '',
    url,
    is_indexed: ii,
    verdict: r.verdict ?? null,
    coverage_state: r.coverageState ?? null,
    last_crawl_time: r.lastCrawlTime ?? null,
    robots_txt_state: r.robotsTxtState ?? null,
    indexing_state: r.indexingState ?? null,
    last_checked_at: when,
  });
  _insCheck.run(site || '', url, ii, r.verdict ?? null, r.coverageState ?? null, when);
  setMeta('updatedAt', new Date().toISOString());
});

const _pagesForSite = db.prepare('SELECT * FROM pages WHERE site = ?');
const _allPages = db.prepare('SELECT * FROM pages');
const _distinctSites = db.prepare('SELECT DISTINCT site FROM pages ORDER BY site');

// Current page state for one property → { url: {isIndexed, verdict, ...} }
export function getPageMap(site = '') {
  const map = {};
  for (const row of _pagesForSite.all(site)) map[row.url] = rowToPage(row);
  return map;
}

// All properties that have any stored pages.
export const listStoredSites = () => _distinctSites.all().map((r) => r.site);

// Every property's pages → { site: { url: {...} } }
export function getAllPagesBySite() {
  const out = {};
  for (const row of _allPages.all()) {
    (out[row.site] ??= {})[row.url] = rowToPage(row);
  }
  return out;
}

const _historyFor = db.prepare(
  'SELECT is_indexed,verdict,coverage_state,checked_at FROM checks WHERE site=? AND url=? ORDER BY id DESC LIMIT ?'
);
export const historyFor = (site, url, limit = 50) =>
  _historyFor.all(site || '', url, limit).map((r) => ({ ...r, isIndexed: toBool(r.is_indexed) }));

// ---- logs (+ live bus) ----------------------------------------------------
export const logBus = new EventEmitter();
logBus.setMaxListeners(0);

const _insLog = db.prepare('INSERT INTO logs (ts,level,event,url,message,raw) VALUES (?,?,?,?,?,?)');
const _getLogs = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?');
const _getLogsLvl = db.prepare('SELECT * FROM logs WHERE level=? ORDER BY id DESC LIMIT ?');
const _clearLogs = db.prepare('DELETE FROM logs');
const _errCount = db.prepare("SELECT COUNT(*) c FROM logs WHERE level='error'");

// log({level,event,url,message,raw}) → persists and emits for live streaming.
export function log(entry) {
  const row = {
    ts: new Date().toISOString(),
    level: entry.level || 'info',
    event: entry.event || null,
    url: entry.url || null,
    message: entry.message || '',
    raw: entry.raw != null ? (typeof entry.raw === 'string' ? entry.raw : JSON.stringify(entry.raw)) : null,
  };
  const info = _insLog.run(row.ts, row.level, row.event, row.url, row.message, row.raw);
  const full = { id: info.lastInsertRowid, ...row };
  logBus.emit('log', full);
  return full;
}

export function getLogs({ level, limit = 300 } = {}) {
  const rows = level && level !== 'all' ? _getLogsLvl.all(level, limit) : _getLogs.all(limit);
  return rows.reverse(); // oldest→newest for console display
}
export const clearLogs = () => _clearLogs.run();
export const errorCount = () => _errCount.get().c;

// ---- one-time migration from results.json --------------------------------
const _pageCount = db.prepare('SELECT COUNT(*) c FROM pages');
export function migrateFromJsonIfEmpty() {
  if (_pageCount.get().c > 0) return;
  if (!fs.existsSync(RESULTS_JSON)) return;
  try {
    const data = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8'));
    let n = 0;
    db.transaction(() => {
      if (data.sites && typeof data.sites === 'object') {
        // New per-property export shape: { sites: { site: { url: {...} } } }
        for (const [site, pages] of Object.entries(data.sites))
          for (const [url, r] of Object.entries(pages)) { savePage(site, url, r); n++; }
      } else if (data.pages && typeof data.pages === 'object') {
        // Legacy flat shape: { siteUrl, pages: { url: {...} } }
        const site = data.siteUrl || getMeta('siteUrl') || '';
        for (const [url, r] of Object.entries(data.pages)) { savePage(site, url, r); n++; }
      }
    })();
    if (n) log({ level: 'info', event: 'migrate', message: `Imported ${n} pages from results.json into gsc.db` });
  } catch (e) {
    log({ level: 'warn', event: 'migrate', message: 'Could not import results.json: ' + e.message });
  }
}

// Optional: keep writing results.json so older exports/scripts still work.
// New shape groups pages by property: { updatedAt, sites: { site: { url: {} } } }.
export function exportResultsJson() {
  fs.writeFileSync(
    RESULTS_JSON,
    JSON.stringify({ updatedAt: getMeta('updatedAt'), sites: getAllPagesBySite() }, null, 2)
  );
}
