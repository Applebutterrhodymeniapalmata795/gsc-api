# Using this tool from an AI agent

This page is written in plain language for AI models and agents. It tells you what
the tool does, how to run it, and what data you get back.

## What this tool does

It checks if pages of a website are in Google's search index. It uses the Google
Search Console API. It can also ask Google to re-crawl a page.

It runs on one computer. It saves data in a local file called `gsc.db`.

## Words you need to know

- **Property**: one website (or one part of it) that is set up in Google Search
  Console. Examples: `sc-domain:connascent.com`, `https://connascent.com/it/`.
- **Indexed**: the page is in Google. It can show up in search.
- **Not indexed**: the page is not in Google right now.
- One account can have **many properties**. This tool supports all of them. You
  pick which property to work with.

## Two ways to use it

You can use the **command line** (simplest for a one-time job) or the **web API**
(best if you want to call it from code).

Setup is only done once (Google login and keys). See the main
[README](../README.md) for setup. This page assumes setup is done.

---

## Way 1: Command line

Run these from the project root folder.

| Command | What it does | What you get back |
| --- | --- | --- |
| `node src/check-index.mjs --list-sites` | List all properties the account can use. | A list printed on screen. |
| `node src/check-index.mjs` | Check 50 pages of the active property. | Progress on screen + saved to `gsc.db`. |
| `node src/check-index.mjs --all` | Check every page of the active property. | Same, all pages. |
| `node src/check-index.mjs --site=sc-domain:example.com` | Check a specific property. | Same. |
| `node src/check-index.mjs --all-sites` | Check every property in the account, one by one. | Same, for all properties. |

After a run, two files are written at the project root:

- **`not-indexed.txt`** — a simple list of pages that are NOT indexed, grouped by
  property. Read this to see problems fast.
- **`results.json`** — the full data as JSON (see shape below).

### `results.json` shape

```json
{
  "updatedAt": "2026-07-07T12:00:00.000Z",
  "sites": {
    "sc-domain:connascent.com": {
      "https://connascent.com/": {
        "isIndexed": true,
        "verdict": "PASS",
        "coverageState": "Submitted and indexed",
        "lastCheckedAt": "2026-07-07T12:00:00.000Z"
      }
    }
  }
}
```

The top key is `sites`. Under it, each key is a property. Under each property,
each key is a page URL. `isIndexed` is `true`, `false`, or `null` (not checked
yet).

---

## Way 2: Web API

Start the server:

```bash
GSC_NO_OPEN=1 node src/server.mjs
```

`GSC_NO_OPEN=1` stops it from opening a browser. The server listens on
`http://localhost:4500`. Set `PORT` to change the port.

All answers are JSON. Here are the endpoints you will use most:

| Method + path | What it does | Body / query |
| --- | --- | --- |
| `GET /api/data` | Get the active property, the list of pages, and their status. | — |
| `GET /api/sites` | List all properties + which one is active. | — |
| `POST /api/site` | Change the active property. | `{ "siteUrl": "https://connascent.com/it/" }` |
| `POST /api/check` | Check one or more pages now. | `{ "urls": ["https://connascent.com/"] }` |
| `GET /api/inspect?url=...` | Full details for one page. | url in the query |
| `POST /api/reindex` | Ask Google to re-crawl a page. | `{ "url": "https://connascent.com/" }` |
| `POST /api/analytics` | Clicks, impressions, CTR, position. | `{ "days": 28, "dimensions": ["query"] }` |
| `GET /api/sitemaps` | Sitemaps submitted for the active property. | — |
| `GET /api/logs?level=all&limit=100` | Recent log lines. | — |

### The important idea: pick the property first

Data is per property. To work with a property, POST to `/api/site` first, then
call the other endpoints. Example flow:

1. `POST /api/site` with `{ "siteUrl": "https://connascent.com/it/" }`
2. `GET /api/data` → now returns the `/it/` pages and their status.
3. `POST /api/check` with some of those URLs → checks them and saves.

### `GET /api/data` answer shape

```json
{
  "siteUrl": "sc-domain:connascent.com",
  "sites": ["sc-domain:connascent.com", "https://connascent.com/it/"],
  "bot": "you@example.com",
  "rows": [
    {
      "url": "https://connascent.com/",
      "isIndexed": true,
      "coverageState": "Submitted and indexed",
      "gscLink": "https://search.google.com/search-console/inspect?..."
    }
  ]
}
```

`rows` is the list of pages. Each row has `url`, `isIndexed`, `coverageState`,
and a `gscLink` a human can open.

---

## Tips for AI agents

- **Read before you check.** If you only need status, read `results.json` or call
  `GET /api/data`. Do not re-check every page each time. Checking uses quota.
- **Quotas are real.** Checking pages is limited to about 2,000 per property per
  day. Reindex requests are limited to 200 per day. Stop if you get a `429`.
- **Reindex is a real action.** `POST /api/reindex` tells Google to re-crawl. Only
  do this for pages that need it. If you are acting for a person, ask them first.
- **One property at a time.** Set the active property, then act. Or use
  `--all-sites` on the command line to loop through every property.
- **Nothing is automatic.** The tool never reindexes on its own. It only checks
  and reports until you tell it to reindex.

## Safety

This tool talks to Google as the signed-in user and can change how Google treats
pages (reindex / "removed" signals). Treat `POST /api/reindex` and
"Notify removed" as actions that affect a live website. When in doubt, just read
data — checking and reading never change anything.
