# CardPlus Checker

CardPlus (`cardplustcg.com`) sits behind **hCDN**, which serves a JavaScript
proof-of-work challenge to any client that doesn't run JS. That defeats plain
HTTP requests, GitHub Actions, and Cloudflare Workers — all get a `403`
"Checking your browser" page. This is why CardPlus can't run in the main
GitHub Actions scanner.

This standalone checker beats the challenge by driving a **real headless browser**
(Playwright) to solve it, caching the clearance cookie, then polling the fast
wp-json API with that cookie. It only re-launches the browser when the cookie
expires.

## Where to run it

Run it on a machine with a **stable, clean IP that stays on 24/7**. Your
**Sydney VPS is ideal** — an Australian IP matches the store and won't look like
datacenter traffic the way GitHub Actions does. (Your Virginia VPS also works,
but AU is a better fit.)

## Setup (on the VPS)

```bash
cd cardplus
npm install
npx playwright install --with-deps chromium
export DISCORD_WEBHOOK_URL="<your webhook url>"
node checker.js
```

## Keep it running 24/7 with pm2

```bash
npm install -g pm2
DISCORD_WEBHOOK_URL="<your webhook url>" pm2 start checker.js --name cardplus
pm2 save
pm2 startup   # follow the printed command so it survives reboots
```

## Notes

- Uses the **same Discord webhook** as the main scanner, so alerts land in the
  same channel with the same `@everyone` format.
- Polls every ~5s. The browser only runs to (re)solve the challenge; normal
  checks are lightweight `fetch()` calls.
- If CardPlus rotates their challenge and the selector wait times out, the
  checker still grabs whatever cookies exist and tries the API; on repeated
  403s it re-solves automatically.
