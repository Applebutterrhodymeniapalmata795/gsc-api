// One-time Gmail login for the GSC dashboard.
//   node login.mjs
// Opens your browser, you pick the Google account that owns the Search Console
// property and click Allow. The resulting token is saved to token.json and
// auto-refreshes, so you never have to do this again.

import http from 'node:http';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import { google } from 'googleapis';
import { makeOAuthClient, findOAuthClient, SCOPES_ARR, TOKEN_PATH } from './gsc.mjs';

const PORT = 5500;

// Open a URL in the default browser, cross-platform.
function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

if (!findOAuthClient()) {
  console.error(
    '\n❌ No OAuth client found in the project root.\n' +
      '   In Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID\n' +
      '   → Application type: Desktop app → Download JSON → drop it in the project root.\n'
  );
  process.exit(1);
}

const oauth2 = makeOAuthClient(PORT);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline', // get a refresh token
  prompt: 'consent', // force refresh token even on re-login
  scope: SCOPES_ARR,
});

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/?')) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('No code received.');
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    // Record which account this is, for display in the dashboard.
    let account = 'your Google account';
    try {
      const oauth2api = google.oauth2({ version: 'v2', auth: oauth2 });
      const me = await oauth2api.userinfo.get();
      account = me.data.email || account;
    } catch {
      /* userinfo scope not granted — fine */
    }

    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...tokens, account }, null, 2));

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<body style="font:16px system-ui;padding:40px;background:#0d1117;color:#e6edf3">
       ✅ Logged in as <b>${account}</b>. You can close this tab and return to the dashboard.</body>`
    );
    console.log(`\n✅ Logged in as ${account}. Token saved → token.json\n`);
    setTimeout(() => server.close(() => process.exit(0)), 500);
  } catch (err) {
    res.writeHead(500).end('Auth failed: ' + err.message);
    console.error('\n❌ Auth failed:', err.message, '\n');
    server.close(() => process.exit(1));
  }
});

server.listen(PORT, () => {
  console.log(`\nOpening browser to sign in…\nIf it doesn't open, paste this URL:\n${authUrl}\n`);
  openBrowser(authUrl);
});
