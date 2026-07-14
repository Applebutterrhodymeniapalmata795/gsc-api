# GSC Index Monitor

A small, **local** tool to monitor Google's index status of every page on your
site, watch a live log of what's happening, and request reindexing — without the
30‑day Search Console UI delay.

It talks to Google **as you** (OAuth, signed in as the account that owns the
property), stores everything in a local SQLite file, and serves a dashboard at
`http://localhost:4500`. No database server, no cloud, no hosting, no auth
layer — it all runs on your machine.

> Built and used in production by [Connascent](https://connascent.com) to keep an
> eye on the indexing of **connascent.com**. Open-sourced so you can point it at
> your own property.

![Node](https://img.shields.io/badge/node-%E2%89%A520-3c873a)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

---

## Features

- **Index status for every URL** in your sitemap (live, via the URL Inspection API).
- **Dashboard** — filter/search pages, re-check one or many, open full inspection
  details (mobile usability, rich results, canonicals, crawl info).
- **Multiple properties** — switch between every property in your account from a
  header dropdown; each property keeps its own tracked pages, history, and URL
  list (sourced from that property's own sitemap).
- **Reindex on demand** — nudge Google to re-crawl a page (Indexing API).
- **De-index alerts** — flags pages that *newly* dropped out of the index.
- **Sitemaps & Search Analytics** — list submitted sitemaps, (re)submit one, and
  pull clicks / impressions / CTR / position.
- **Live console + structured logs** — stream every action as it happens.
- **Local & private** — SQLite file on disk, nothing leaves your machine except
  the Google API calls you make.

---

## How it works: two separate Google APIs

Checking never spends your reindex quota — they're deliberately different endpoints.

|            | Checking                              | Reindexing                    |
| ---------- | ------------------------------------- | ----------------------------- |
| **API**    | URL Inspection (Search Console API)   | Web Search **Indexing API**   |
| **Quota**  | ~2,000/day **per property**           | **200/day**                   |
| **Actions**| Re-check, Details, Performance, Sitemaps | Reindex, Notify removed   |

Nothing reindexes automatically — a URL is only submitted when you click
**Reindex** on that row.

---

## Project structure

```text
.
├── src/
│   ├── server.mjs        # local web server + dashboard API
│   ├── check-index.mjs   # CLI checker
│   ├── login.mjs         # one-time OAuth sign-in
│   ├── gsc.mjs           # shared Google API helpers (auth, inspect, sitemaps, analytics)
│   └── db.mjs            # SQLite store (pages, history, logs) + live log bus
├── public/
│   └── dashboard.html    # the dashboard UI (single self-contained file)
├── docs/
│   ├── for-ai.md                # plain-language guide for AI models/agents
│   └── nextjs-cron-variant.md   # alternative: a serverless Next.js/Vercel cron build
├── .env.example
├── package.json
└── README.md
```

Your credentials, OAuth token, and local database live at the **project root**
and are all git‑ignored (see [Security](#security)):

```text
token.json                     # your saved OAuth token (auto-refreshes)
client_secret_*.json           # your Google OAuth "Desktop app" client
*.iam.gserviceaccount.com.json # (optional) a service-account key
gsc.db                         # the SQLite database
results.json / not-indexed.txt # exports written on each run
```

---

## Prerequisites

- **Node.js ≥ 20** (uses built-in `fetch`, `AbortSignal.timeout`, and SQLite via `better-sqlite3`).
- A **Google account that owns a Search Console property** (or has been added as an Owner).
- A **Google Cloud project** where you can create an OAuth client and enable APIs (free).

---

## Setup

### 1. Install

```bash
git clone https://github.com/Connascent-Dev/gsc-api.git
cd gsc-api
npm install
```

### 2. Enable the two APIs

In the [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Library**, enable:

- **Google Search Console API** (checking, sitemaps, analytics)
- **Web Search Indexing API** (reindex requests)

### 3. Create an OAuth client (sign in "as you")

1. **APIs & Services → OAuth consent screen** → set User type to **External**, and
   add the Google account that owns the property as a **Test user**.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID** →
   Application type **Desktop app** → **Download JSON**.
3. Drop that downloaded `client_secret_….json` into the **project root**. That's it —
   the tool auto-discovers it (no need to rename it).

### 4. (Optional) Point it at your site

Copy the example env file and set your property + sitemap:

```bash
cp .env.example .env
```

```env
GSC_SITE=sc-domain:connascent.com
GSC_SITEMAP_URL=https://connascent.com/sitemap.xml
```

If you skip this, the tool auto-selects the first property your account can
access and reads whatever sitemap you configure later. Load the env file by
running commands as `node --env-file=.env src/server.mjs` (Node 20.6+).

### 5. Sign in, then launch

```bash
npm run login       # opens your browser → pick the owner account → Allow
npm run dashboard   # starts the dashboard at http://localhost:4500 (opens browser)
```

`npm run login` saves `token.json` and auto-refreshes it, so you only do this
once (re-run only if auth ever expires).

---

## Usage

### Dashboard

```bash
npm run dashboard        # → http://localhost:4500
```

**Stop it:** press `Ctrl+C` in its terminal. On Windows, if it's running in the
background you can kill it by port:

```powershell
Get-NetTCPConnection -LocalPort 4500 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

**Tabs**

- **Pages** — every sitemap URL with its live index status. Per row: **Re-check**,
  **Details** (full inspection), **Reindex**, **Copy** + **GSC ↗**. Toolbar has
  filters (All / Indexed / Not indexed / Not checked), search, and bulk re-check.
- **Site & APIs** — property switcher, submitted sitemaps + stats, **Submit sitemap**,
  and **Search performance** (clicks / impressions / CTR / position).
- **Logs** — structured, filterable feed of every event.
- **Console** — raw live stream of the process (Server-Sent Events).

### CLI

| Command | What it does |
| --- | --- |
| `npm run check` | Check the 50 oldest-unchecked URLs. Writes to `gsc.db` + `not-indexed.txt`. |
| `npm run check:all` | Check **every** URL in the sitemap. |
| `node src/check-index.mjs --limit=20` | Check N URLs. |
| `node src/check-index.mjs --site=sc-domain:example.com` | Force a specific property. |
| `node src/check-index.mjs --all-sites` | Sweep **every** property in the account, one by one. |
| `node src/check-index.mjs --list-sites` | List the properties your account can access. |

---

## Configuration

All optional — set via environment variables (see [`.env.example`](.env.example)):

| Variable | Default | Purpose |
| --- | --- | --- |
| `GSC_SITE` | first accessible property | Which Search Console property to use by default. |
| `GSC_SITEMAP_URL` | — | Global fallback sitemap URL (per-property sitemaps are used first). |
| `GSC_LOCAL_SITEMAP` | `./sitemap.xml` | Offline fallback sitemap file. |
| `PORT` | `4500` | Dashboard port. |
| `GSC_NO_OPEN` | — | Set to `1` to not auto-open a browser (headless / CI). |
| `GSC_DB` | `./gsc.db` | Path to the SQLite database file. |

### Working with multiple properties

One account can own many properties (e.g. `sc-domain:example.com`,
`https://example.com/it/`). This tool tracks them all **independently** — each
property has its own pages, history, and URL list, so their data never mixes.

- **Dashboard**: pick the property from the dropdown in the header (shown when you
  have more than one). Everything on the page then reflects that property.
- **CLI**: use `--site=<property>` for one, or `--all-sites` to sweep them all.
- **URL list per property**: pulled from that property's own submitted sitemap
  first; if it has none, discovered from the site's `robots.txt` / `sitemap.xml`
  and filtered to the URLs that belong to the property.

### Auth modes

- **User (OAuth)** — preferred. Sign in with `npm run login`; acts as your Google
  account. Needed for the Indexing API (reindex) and sitemap submit.
- **Service account** — optional. Drop a `*.iam.gserviceaccount.com.json` key in the
  project root and add its `client_email` as a user in Search Console. Good for
  read-only/CI checks; reindex requires the account to be an **Owner**.

---

## Docs

- **[docs/for-ai.md](docs/for-ai.md)** — plain-language guide for AI models and
  agents: the CLI commands, the HTTP API, data shapes, and safety notes.
- **[docs/nextjs-cron-variant.md](docs/nextjs-cron-variant.md)** — an alternative
  design that runs the same idea as a serverless Next.js + Vercel cron job.

## Troubleshooting

- **Page stuck on "Loading…" / blank** — stale browser tab. Hard-reload with `Ctrl+Shift+R`.
- **Auth error / `invalid_grant`** — the OAuth token expired (testing-mode tokens can
  lapse after ~7 days of disuse). Run `npm run login` again.
- **"No Search Console properties"** — you signed in with an account that doesn't own
  the property. Sign in with an Owner account.
- **Reindex says "permission denied"** — confirm the Indexing API is enabled and your
  account is an **Owner** of the property.
- **Submit sitemap says "need write access"** — re-run `npm run login` to grant the full
  `webmasters` scope.
- **Port 4500 already in use** — an old instance is running; stop it (see above) or set `PORT`.

---

## Security

This repo is safe to make public — **no credentials are committed.** The
[`.gitignore`](.gitignore) ignores every `.json` (re-allowing only
`package.json` / `package-lock.json`), plus `token.json`, `client_secret*.json`,
service-account keys, the SQLite database, `.env`, and generated exports. Your
secrets stay on your machine.

If you ever fork or clone, keep your `client_secret_*.json`, `token.json`, and any
service-account key **out of version control**.

---

## License

[MIT](LICENSE) © Connascent
