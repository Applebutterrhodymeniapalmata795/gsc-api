// Local Google Search Console de-indexing checker (CLI).
// Inspects each sitemap URL's live index status, stores results + history in
// gsc.db (per property), logs every step, flags pages that newly dropped out of
// the index, and writes a plain list of not-indexed URLs to not-indexed.txt.
//
// Usage (from the project root):
//   node src/check-index.mjs                 # check 50 oldest-unchecked URLs on the active property
//   node src/check-index.mjs --all           # check every URL in the property's sitemap
//   node src/check-index.mjs --limit=20      # check N URLs
//   node src/check-index.mjs --site=sc-domain:example.com   # force a specific property
//   node src/check-index.mjs --all-sites     # sweep EVERY property in the account
//   node src/check-index.mjs --list-sites    # just show the properties the account can access

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSites, pickSite, readSitemapUrls, inspectUrl, clientEmail } from './gsc.mjs';
import { getPageMap, savePage, setMeta, log, migrateFromJsonIfEmpty, exportResultsJson } from './db.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Written to the project root (one level up from src/).
const NOT_INDEXED_TXT = path.resolve(__dirname, '..', 'not-indexed.txt');
const DELAY_MS = 250;

const args = process.argv.slice(2);
const getFlag = (n) => args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
const getVal = (n, d) => {
  const f = getFlag(n);
  if (!f) return d;
  return f.split('=')[1] ?? true;
};
const wantAll = !!getFlag('all');
const limit = wantAll ? Infinity : Number(getVal('limit', 50));
const forcedSite = getVal('site', null);
const wantAllSites = !!getFlag('all-sites');
const listOnly = !!getFlag('list-sites');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Check a single property. Returns { indexed, notIndexed, notIndexedList }.
async function checkProperty(siteUrl) {
  console.log(`\n=== ${siteUrl} ===`);
  const prev = getPageMap(siteUrl);
  const allUrls = await readSitemapUrls(siteUrl);
  if (!allUrls.length) {
    console.log('No sitemap URLs found for this property — skipping.');
    log({ level: 'warn', event: 'sitemap', message: `No sitemap URLs for ${siteUrl}` });
    return { indexed: 0, notIndexed: 0, notIndexedList: [] };
  }
  const ordered = [...allUrls].sort((a, b) =>
    (prev[a]?.lastCheckedAt || '').localeCompare(prev[b]?.lastCheckedAt || '')
  );
  const batch = ordered.slice(0, limit === Infinity ? ordered.length : limit);
  console.log(`Checking ${batch.length} of ${allUrls.length} URLs...\n`);
  log({ level: 'info', event: 'run', message: `CLI run started — ${batch.length} URLs on ${siteUrl}` });

  let indexed = 0;
  let notIndexed = 0;
  for (let i = 0; i < batch.length; i++) {
    const url = batch[i];
    try {
      const r = await inspectUrl(siteUrl, url);
      const wasIndexed = prev[url]?.isIndexed;
      savePage(siteUrl, url, r);

      if (wasIndexed === true && !r.isIndexed) {
        log({ level: 'info', event: 'deindex', url, message: `DE-INDEXED: ${r.coverageState}` });
      }
      log({ level: 'debug', event: 'check', url, message: `${r.verdict} · ${r.coverageState}`, raw: r });

      r.isIndexed ? indexed++ : notIndexed++;
      console.log(
        `${r.isIndexed ? '✅' : '❌'} [${i + 1}/${batch.length}] ${r.coverageState.padEnd(34)} ${url}`
      );
    } catch (err) {
      const m = err.errors?.[0]?.message || err.message;
      if (err.code === 429) {
        log({ level: 'warn', event: 'ratelimit', url, message: '429 quota hit — stopping run' });
        console.warn('\n🚨 GSC rate/quota limit hit (2000/day). Stopping.');
        break;
      }
      log({ level: 'error', event: 'check', url, message: m });
      console.error(`⚠️  Failed: ${url} — ${m}`);
    }
    if (i < batch.length - 1) await sleep(DELAY_MS);
  }

  const map = getPageMap(siteUrl);
  const notIndexedList = Object.entries(map)
    .filter(([, v]) => v.isIndexed === false)
    .map(([url, v]) => `${url}  —  ${v.coverageState}`);
  console.log(
    `\nIndexed: ${indexed} · Not indexed: ${notIndexed} · total not-indexed for property: ${notIndexedList.length}`
  );
  return { indexed, notIndexed, notIndexedList };
}

async function main() {
  migrateFromJsonIfEmpty();

  const sites = await listSites();
  if (sites.length === 0) {
    log({ level: 'error', event: 'auth', message: `No GSC properties for ${clientEmail()}` });
    console.error(
      `\n⚠️  ${clientEmail()} has access to ZERO Search Console properties.\n` +
        `   Sign in with an account that owns the property: node src/login.mjs\n`
    );
    process.exit(1);
  }

  console.log('\nProperties available:');
  sites.forEach((s) => console.log('  •', s));
  if (listOnly) return;

  // Which properties to check this run: every one (--all-sites) or just the
  // active/forced one.
  const targets = wantAllSites ? sites : [pickSite(sites, forcedSite)];
  if (!wantAllSites) setMeta('siteUrl', targets[0]); // keep the dashboard's active property in sync
  console.log(
    wantAllSites ? `\nSweeping ALL ${targets.length} properties.` : `\nUsing property: ${targets[0]}`
  );

  const notIndexedBlocks = [];
  let totalIndexed = 0;
  let totalNot = 0;
  for (const siteUrl of targets) {
    const { indexed, notIndexed, notIndexedList } = await checkProperty(siteUrl);
    totalIndexed += indexed;
    totalNot += notIndexed;
    if (notIndexedList.length)
      notIndexedBlocks.push(`# ${siteUrl}\n` + notIndexedList.map((l) => '  ' + l).join('\n'));
  }

  exportResultsJson();
  fs.writeFileSync(NOT_INDEXED_TXT, notIndexedBlocks.join('\n\n') + (notIndexedBlocks.length ? '\n' : ''));

  log({
    level: 'info',
    event: 'run',
    message: `CLI run done — ${targets.length} propert${targets.length > 1 ? 'ies' : 'y'}, indexed ${totalIndexed}, not-indexed ${totalNot}`,
  });

  console.log('\n────────────────────────────────');
  console.log(`Properties checked:     ${targets.length}`);
  console.log(`Indexed (this run):     ${totalIndexed}`);
  console.log(`Not indexed (this run): ${totalNot}`);
  console.log(`Saved → gsc.db (+ results.json export)`);
  console.log(`Not-indexed list → not-indexed.txt`);
}

main().catch((e) => {
  log({ level: 'error', event: 'fatal', message: e.message });
  console.error('\nFatal:', e.message);
  process.exit(1);
});
