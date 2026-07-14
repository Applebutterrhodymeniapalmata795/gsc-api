// Shared Google Search Console helpers, used by both the CLI (check-index.mjs)
// and the dashboard server (server.mjs). Everything lives inside gsc-api/.

import { google } from 'googleapis';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Credentials, the OAuth token, and local data live at the project root (one
// level up from src/), so nothing changes if you move the source around.
const ROOT = path.resolve(__dirname, '..');

// Where to read the list of URLs to check. Configure via environment variables
// (see .env.example). LIVE takes priority; LOCAL is the offline fallback.
//   GSC_SITEMAP_URL   – public sitemap URL, e.g. https://connascent.com/sitemap.xml
//   GSC_LOCAL_SITEMAP – path to a local sitemap.xml (defaults to ./sitemap.xml)
const LIVE_SITEMAP = process.env.GSC_SITEMAP_URL || '';
const LOCAL_SITEMAP = process.env.GSC_LOCAL_SITEMAP
  ? path.resolve(process.env.GSC_LOCAL_SITEMAP)
  : path.resolve(ROOT, 'sitemap.xml');

// Scopes: full webmasters covers inspection + analytics + sitemaps read AND
// sitemap submit (write); indexing is for reindex notifications.
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/indexing',
  'https://www.googleapis.com/auth/userinfo.email', // so we can show who's logged in
  'openid',
];

export const SCOPES_ARR = SCOPES;
export const TOKEN_PATH = path.resolve(ROOT, 'token.json');

// Scan the project root for a json file matching a predicate on its contents.
function findJson(pred) {
  for (const n of fs.readdirSync(ROOT).filter((f) => f.endsWith('.json'))) {
    const p = path.join(ROOT, n);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pred(j)) return { path: p, json: j };
    } catch {
      /* skip non-json */
    }
  }
  return null;
}

// A service-account key (the "bot").
export function findKeyFile() {
  const hit = findJson((j) => j.client_email && j.private_key);
  if (!hit) throw new Error('No service-account .json key found in the project root');
  return hit.path;
}

// A downloaded OAuth "Desktop app" client (for logging in as a real Gmail user).
export function findOAuthClient() {
  const hit = findJson((j) => j.installed || j.web);
  if (!hit) return null;
  return hit.json.installed || hit.json.web;
}

export function hasUserToken() {
  return fs.existsSync(TOKEN_PATH);
}

// Which credential are we using?  'user' (Gmail OAuth) is preferred when a
// token exists; otherwise fall back to the service-account bot.
export function authMode() {
  if (hasUserToken() && findOAuthClient()) return 'user';
  try {
    findKeyFile();
    return 'service';
  } catch {
    return 'none';
  }
}

// Build an OAuth2 client from the downloaded Desktop-app credentials.
export function makeOAuthClient(redirectPort) {
  const c = findOAuthClient();
  if (!c) throw new Error('No OAuth client JSON (with an "installed" key) found in the project root');
  return new google.auth.OAuth2(
    c.client_id,
    c.client_secret,
    `http://localhost:${redirectPort || 5500}`
  );
}

// Identity string shown in the UI.
export function authIdentity() {
  const mode = authMode();
  if (mode === 'user') {
    try {
      return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')).account || 'your Google account';
    } catch {
      return 'your Google account';
    }
  }
  if (mode === 'service') return JSON.parse(fs.readFileSync(findKeyFile(), 'utf8')).client_email;
  return '(no credential yet)';
}

// Back-compat alias used elsewhere.
export function clientEmail() {
  return authIdentity();
}

let _clients = null;
let _clientsSig = null;
export function getClients() {
  // Rebuild if the credential changed — e.g. login.mjs (re)wrote token.json, or
  // the auth mode switched — so a running dashboard picks up a fresh login
  // without needing a restart.
  const sig = authMode() + '|' + (hasUserToken() ? String(fs.statSync(TOKEN_PATH).mtimeMs) : 'none');
  if (_clients && _clientsSig === sig) return _clients;
  _clientsSig = sig;

  let auth;
  if (authMode() === 'user') {
    auth = makeOAuthClient();
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    auth.setCredentials(token);
    // Persist refreshed access tokens so we don't re-login.
    auth.on('tokens', (t) => {
      const merged = { ...token, ...t };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    });
  } else {
    auth = new google.auth.GoogleAuth({ keyFile: findKeyFile(), scopes: SCOPES });
  }

  _clients = {
    searchconsole: google.searchconsole({ version: 'v1', auth }),
    indexing: google.indexing({ version: 'v3', auth }),
  };
  return _clients;
}

export async function listSites() {
  const { searchconsole } = getClients();
  const resp = await searchconsole.sites.list();
  return (resp.data.siteEntry || []).map((s) => s.siteUrl);
}

export function pickSite(sites, forced) {
  if (!sites.length) return undefined;
  // Honor a forced/stored property (CLI --site or the saved active one) or
  // GSC_SITE — but only when it actually resolves to one of the account's
  // properties (exact match first, then a loose match on the bare domain). This
  // ignores a bad/stale value (or a valueless `--site` that arrives as `true`)
  // and falls back to the first accessible property.
  const want = (typeof forced === 'string' && forced) || process.env.GSC_SITE;
  if (want) {
    const bare = want.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const hit = sites.find((s) => s === want) || (bare && sites.find((s) => s.includes(bare)));
    if (hit) return hit;
  }
  return sites[0];
}

// True if `url` belongs to the Search Console property `siteUrl`.
//   sc-domain:example.com   → any URL on example.com or a subdomain
//   https://example.com/it/ → any URL under that path prefix
export function siteMatches(siteUrl, url) {
  try {
    if (siteUrl.startsWith('sc-domain:')) {
      const domain = siteUrl.slice('sc-domain:'.length).toLowerCase();
      const host = new URL(url).hostname.toLowerCase();
      return host === domain || host.endsWith('.' + domain);
    }
    // URL-prefix property: Google only lets you inspect URLs that start with the
    // property prefix *including its trailing slash* (e.g. the property
    // "https://example.com/it/" does NOT cover "https://example.com/it").
    const prefix = siteUrl.endsWith('/') ? siteUrl : siteUrl + '/';
    return url.startsWith(prefix);
  } catch {
    return false;
  }
}

const parseLocs = (xml) => [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/g)].map((m) => m[1].trim());

// Fetch a sitemap URL and return the page URLs it lists. Follows up to two
// levels of sitemap-index nesting (a sitemap that points to other sitemaps).
async function fetchSitemapUrls(url, depth = 0) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const xml = await res.text();
  const locs = parseLocs(xml);
  if (/<sitemapindex[\s>]/i.test(xml) && depth < 2) {
    const out = [];
    for (const child of locs) {
      try { out.push(...(await fetchSitemapUrls(child, depth + 1))); } catch { /* skip bad child */ }
    }
    return out;
  }
  return locs;
}

// The origin (scheme+host) for a property, for sitemap discovery.
function siteOrigin(siteUrl) {
  try {
    return siteUrl.startsWith('sc-domain:')
      ? `https://${siteUrl.slice('sc-domain:'.length)}`
      : new URL(siteUrl).origin;
  } catch {
    return '';
  }
}

// Discover sitemap URLs for a property that has none submitted in GSC: read the
// site's robots.txt (Sitemap: lines) and try the conventional /sitemap.xml.
async function discoverSitemaps(siteUrl) {
  const origin = siteOrigin(siteUrl);
  if (!origin) return [];
  const found = new Set([`${origin}/sitemap.xml`]);
  try {
    const res = await fetch(`${origin}/robots.txt`, { signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      for (const m of (await res.text()).matchAll(/^\s*sitemap:\s*(\S+)/gim)) found.add(m[1].trim());
    }
  } catch {
    /* no robots.txt — the /sitemap.xml guess still stands */
  }
  return [...found];
}

// The list of URLs to check for a property. Tried in order until something is
// found:
//   1. the property's own submitted sitemaps in GSC (per-property, automatic)
//   2. GSC_SITEMAP_URL             (global override / fallback)
//   3. discovery: the site's robots.txt "Sitemap:" lines + /sitemap.xml
//   4. a local sitemap.xml file    (offline fallback)
// The result is de-duped and filtered to URLs that actually belong to `siteUrl`,
// so one shared sitemap.xml still yields the right subset per property (e.g. a
// "/it/" URL-prefix property gets only its /it/ pages).
export async function readSitemapUrls(siteUrl) {
  // We accumulate URLs that ALREADY belong to the property (filtered as we go),
  // and only advance to the next source when we still have nothing that matches
  // — so a global GSC_SITEMAP_URL for another domain never suppresses a
  // property's own discovery.
  const matched = [];
  const seen = new Set();
  const addFrom = (urls) => {
    for (const u of urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      if (!siteUrl || siteMatches(siteUrl, u)) matched.push(u);
    }
  };
  const pull = async (sitemapUrl) => {
    try { addFrom(await fetchSitemapUrls(sitemapUrl)); } catch { /* skip bad sitemap */ }
  };

  // 1) the property's own submitted sitemaps in GSC
  if (siteUrl) {
    try { for (const m of await listSitemaps(siteUrl)) await pull(m.path); }
    catch { /* sitemaps.list failed (no permission / none submitted) */ }
  }
  // 2) global override / fallback
  if (!matched.length && LIVE_SITEMAP) await pull(LIVE_SITEMAP);
  // 3) discovery from the site itself (robots.txt + /sitemap.xml)
  if (!matched.length && siteUrl) { for (const sm of await discoverSitemaps(siteUrl)) await pull(sm); }
  // 4) local file
  if (!matched.length && fs.existsSync(LOCAL_SITEMAP)) addFrom(parseLocs(fs.readFileSync(LOCAL_SITEMAP, 'utf8')));

  if (!matched.length && !siteUrl && !LIVE_SITEMAP && !fs.existsSync(LOCAL_SITEMAP)) {
    throw new Error(
      'No sitemap found. Submit a sitemap for the property in Search Console, ' +
        'set GSC_SITEMAP_URL (e.g. https://connascent.com/sitemap.xml), ' +
        'or place a sitemap.xml at the project root.'
    );
  }
  return matched;
}

export async function inspectUrl(siteUrl, url) {
  const { searchconsole } = getClients();
  const resp = await searchconsole.urlInspection.index.inspect({
    requestBody: { inspectionUrl: url, siteUrl, languageCode: 'en-US' },
  });
  const r = resp.data.inspectionResult?.indexStatusResult || {};
  return {
    isIndexed: r.verdict === 'PASS',
    verdict: r.verdict || 'UNKNOWN',
    coverageState: r.coverageState || 'Unknown',
    lastCrawlTime: r.lastCrawlTime || null,
    robotsTxtState: r.robotsTxtState || null,
    indexingState: r.indexingState || null,
    lastCheckedAt: new Date().toISOString(),
  };
}

// Full URL Inspection result (everything Google returns, not just index status):
// index status, mobile usability, rich results, AMP, referring sitemaps, etc.
export async function inspectFull(siteUrl, url) {
  const { searchconsole } = getClients();
  const resp = await searchconsole.urlInspection.index.inspect({
    requestBody: { inspectionUrl: url, siteUrl, languageCode: 'en-US' },
  });
  return resp.data.inspectionResult || {};
}

// Indexing API: notify that a URL was updated or removed.
//   type = 'URL_UPDATED' (reindex) | 'URL_DELETED' (removed)
export async function publishUrlNotification(url, type = 'URL_UPDATED') {
  const { indexing } = getClients();
  try {
    const resp = await indexing.urlNotifications.publish({ requestBody: { url, type } });
    const t = resp.data.urlNotificationMetadata?.latestUpdate?.notifyTime;
    return { ok: true, message: `${type} accepted${t ? ' at ' + t : ''}` };
  } catch (err) {
    const msg = err.errors?.[0]?.message || err.message || 'Unknown error';
    let hint = msg;
    if (err.code === 403)
      hint = 'Permission denied. Enable the Indexing API in the Cloud project AND be an Owner of the property in Search Console.';
    else if (err.code === 429) hint = 'Daily Indexing API quota (200/day) exhausted.';
    return { ok: false, message: hint };
  }
}
// Back-compat: Reindex button.
export const requestReindex = (url) => publishUrlNotification(url, 'URL_UPDATED');

// Indexing API: last notification Google recorded for a URL.
export async function getIndexNotificationStatus(url) {
  const { indexing } = getClients();
  try {
    const resp = await indexing.urlNotifications.getMetadata({ url });
    return { ok: true, data: resp.data };
  } catch (err) {
    return { ok: false, message: err.errors?.[0]?.message || err.message };
  }
}

// Search Console: list properties with permission level.
export async function listSitesDetailed() {
  const { searchconsole } = getClients();
  const resp = await searchconsole.sites.list();
  return (resp.data.siteEntry || []).map((s) => ({
    siteUrl: s.siteUrl,
    permissionLevel: s.permissionLevel,
  }));
}

// Search Console: submitted sitemaps for a property + their stats.
export async function listSitemaps(siteUrl) {
  const { searchconsole } = getClients();
  const resp = await searchconsole.sitemaps.list({ siteUrl });
  return (resp.data.sitemap || []).map((s) => ({
    path: s.path,
    lastSubmitted: s.lastSubmitted || null,
    lastDownloaded: s.lastDownloaded || null,
    isPending: !!s.isPending,
    isSitemapsIndex: !!s.isSitemapsIndex,
    warnings: Number(s.warnings || 0),
    errors: Number(s.errors || 0),
    contents: s.contents || [],
  }));
}

// Search Console: (re)submit a sitemap. Needs full webmasters scope (re-login).
export async function submitSitemap(siteUrl, feedpath) {
  const { searchconsole } = getClients();
  try {
    await searchconsole.sitemaps.submit({ siteUrl, feedpath });
    return { ok: true, message: `Submitted ${feedpath}` };
  } catch (err) {
    const msg = err.errors?.[0]?.message || err.message;
    const hint =
      err.code === 403
        ? 'Need write access. Re-run "node login.mjs" to grant the full webmasters scope.'
        : msg;
    return { ok: false, message: hint };
  }
}

// Search Console: Search Analytics (clicks/impressions/CTR/position).
// opts: { url?, days=28, dimensions=['query'], rowLimit=25 }
export async function searchAnalytics(siteUrl, opts = {}) {
  const { searchconsole } = getClients();
  const days = opts.days || 28;
  const end = new Date();
  const start = new Date(Date.now() - days * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const body = {
    startDate: fmt(start),
    endDate: fmt(end),
    dimensions: opts.dimensions || ['query'],
    rowLimit: opts.rowLimit || 25,
  };
  if (opts.url) {
    body.dimensionFilterGroups = [
      { filters: [{ dimension: 'page', operator: 'equals', expression: opts.url }] },
    ];
  }
  const resp = await searchconsole.searchanalytics.query({ siteUrl, requestBody: body });
  return resp.data.rows || [];
}

// GSC "Inspect URL" deep link for the manual fallback button.
export function gscInspectLink(siteUrl, url) {
  if (!siteUrl) return 'https://search.google.com/search-console';
  return `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(siteUrl)}&id=${encodeURIComponent(url)}`;
}
