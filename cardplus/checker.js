// CardPlus checker — beats the hCDN JavaScript challenge with a real browser.
//
// CardPlus (cardplustcg.com) sits behind hCDN, which serves a JS proof-of-work
// challenge to any client that doesn't execute JavaScript. Plain fetch(),
// GitHub Actions, and Cloudflare Workers all get a 403 challenge page.
//
// Strategy:
//   1. Launch a headless browser and load the product page. Playwright executes
//      the challenge JS, which sets an hCDN clearance cookie.
//   2. Grab that cookie + the browser's User-Agent.
//   3. Poll the lightweight wp-json Store API with plain fetch() using the cookie
//      (fast — no browser needed per check).
//   4. When the cookie expires (API returns 403 challenge again), re-solve with
//      the browser. Clearance typically lasts a while, so this is infrequent.
//
// Run this on a machine with a stable, clean IP (your Sydney VPS is ideal —
// an AU IP matches the store).

const { chromium } = require("playwright");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

const PRODUCTS = [
  {
    name: "EB-05 Booster (CardPlus)",
    slug: "one-piece-card-game-extra-booster-display-tba-eb-05-pre-order",
    pageUrl: "https://cardplustcg.com/product/one-piece-card-game-extra-booster-display-tba-eb-05-pre-order/",
  },
  {
    name: "OP-18 Booster (CardPlus)",
    slug: "one-piece-cg-op-18-booster-display-box-english-release-date-20-nov-2026-pre-order",
    pageUrl: "https://cardplustcg.com/product/one-piece-cg-op-18-booster-display-box-english-release-date-20-nov-2026-pre-order/",
  },
];

const API_BASE = "https://cardplustcg.com/wp-json/wc/store/v1/products";
const INTERVAL_MS = 5_000;
const JITTER_MS = 500;

const state = new Map();
let cookieHeader = "";
let userAgent = "";
let browser = null;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function stripHTML(str) {
  return str.replace(/<[^>]*>/g, "").replace(/&#036;/g, "$").replace(/&amp;/g, "&").trim();
}

// ── Solve the hCDN challenge with a real browser, cache cookie + UA ──
async function solveChallenge() {
  log("Solving hCDN challenge with browser…");
  if (!browser) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  }
  const context = await browser.newContext();
  const page = await context.newPage();

  // Load a product page and wait for the challenge JS to run + reload
  await page.goto(PRODUCTS[0].pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // The challenge auto-reloads once solved; wait for real content (add-to-cart form)
  try {
    await page.waitForSelector("form.cart, .single_add_to_cart_button, .out-of-stock", { timeout: 30_000 });
  } catch {
    // Some pages differ; give the challenge a beat regardless
    await page.waitForTimeout(6_000);
  }

  const cookies = await context.cookies();
  cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  userAgent = await page.evaluate(() => navigator.userAgent);

  await context.close();
  log(`Challenge solved — ${cookies.length} cookies cached.`);
}

// ── Poll the API with the cached clearance cookie ──
async function checkProduct(product) {
  const url = `${API_BASE}?slug=${product.slug}&_cb=${Date.now()}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": userAgent,
      Cookie: cookieHeader,
      "Cache-Control": "no-cache, no-store",
      Referer: "https://cardplustcg.com/",
    },
  });

  // 403 = clearance expired, re-solve
  if (res.status === 403) {
    throw new Error("CHALLENGE_EXPIRED");
  }
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);

  const data = await res.json();
  if (!data.length) throw new Error("API returned empty");
  const p = data[0];
  return {
    status: p.is_in_stock ? "in_stock" : "out_of_stock",
    price: stripHTML(p.price_html || "?"),
    stockText: p.stock_availability?.text || "?",
  };
}

// ── Discord ──
async function sendDiscord(content, embed) {
  if (!DISCORD_WEBHOOK_URL) return;
  const body = {};
  if (content) body.content = content;
  if (embed) body.embeds = [embed];
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after") || 5) * 1000;
        await new Promise((r) => setTimeout(r, retry));
        continue;
      }
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function notifyInStock(product, details) {
  await sendDiscord(`@everyone Stock alert! **${product.name}** is IN STOCK!\n${product.pageUrl}`, {
    title: `IN STOCK — ${product.name}`,
    url: product.pageUrl,
    color: 0x00ff00,
    fields: [
      { name: "Price", value: details.price || "Unknown", inline: true },
      { name: "Status", value: details.stockText || "In Stock", inline: true },
    ],
    timestamp: new Date().toISOString(),
  });
}

async function handleResult(product, result) {
  const prev = state.get(product.name) || "unknown";
  if (result.status === "in_stock" && prev !== "in_stock") {
    log(`IN STOCK: ${product.name}`);
    await notifyInStock(product, result);
  }
  state.set(product.name, result.status);
}

// ── Independent poll loop per product with re-solve on expiry ──
function startLoop(product) {
  async function tick() {
    try {
      const result = await checkProduct(product);
      log(`${product.name} → ${result.status}`);
      await handleResult(product, result);
    } catch (err) {
      if (err.message === "CHALLENGE_EXPIRED") {
        log("Clearance expired — re-solving.");
        try {
          await solveChallenge();
        } catch (e) {
          log(`Re-solve failed: ${e.message}`);
        }
      } else {
        log(`ERROR ${product.name}: ${err.message}`);
      }
    }
    const jitter = Math.floor(Math.random() * JITTER_MS * 2) - JITTER_MS;
    setTimeout(tick, INTERVAL_MS + jitter);
  }
  setTimeout(tick, Math.floor(Math.random() * INTERVAL_MS));
}

async function main() {
  if (!DISCORD_WEBHOOK_URL) {
    console.error("DISCORD_WEBHOOK_URL is required.");
    process.exit(1);
  }
  log("CardPlus checker starting…");
  for (const p of PRODUCTS) state.set(p.name, "unknown");

  await solveChallenge();
  PRODUCTS.forEach(startLoop);
}

process.on("SIGINT", async () => { if (browser) await browser.close(); process.exit(0); });
process.on("SIGTERM", async () => { if (browser) await browser.close(); process.exit(0); });

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
