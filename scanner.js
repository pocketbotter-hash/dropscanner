let cheerio = null;
const config = require("./config");

const state = new Map();
const errorCount = new Map();
const lastHostRequest = new Map();
const MIN_HOST_GAP_MS = 1_500; // minimum 1.5s between requests to same host
let lastHeartbeat = 0;
let heartbeatLock = false;
let running = true;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function cacheBust(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}_cb=${Date.now()}`;
}

function stripHTML(str) {
  return str.replace(/<[^>]*>/g, "").replace(/&#036;/g, "$").replace(/&amp;/g, "&").trim();
}

function loadCheerio() {
  if (!cheerio) cheerio = require("cheerio");
  return cheerio;
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    const signal = AbortSignal.timeout(config.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal });

      // Retry on 429 (rate limit) AND 5xx (server errors)
      if (i < retries && (res.status === 429 || res.status >= 500)) {
        const wait = res.status === 429
          ? Number(res.headers.get("retry-after") || 5) * 1000
          : Math.pow(2, i + 1) * 1000;
        log(`${res.status} on ${new URL(url).hostname} — retry ${i + 1}/${retries} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (err) {
      if (i < retries) {
        const wait = Math.pow(2, i + 1) * 1000;
        log(`Fetch error on ${new URL(url).hostname} — retry ${i + 1}/${retries} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

// Per-host throttle — prevents concurrent requests to the same server
async function throttledFetch(url, options = {}, retries = 3) {
  const hostname = new URL(url).hostname;
  const now = Date.now();
  const last = lastHostRequest.get(hostname) || 0;
  const gap = now - last;
  if (gap < MIN_HOST_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_HOST_GAP_MS - gap));
  }
  lastHostRequest.set(hostname, Date.now());
  return fetchWithRetry(url, options, retries);
}

function productUrl(product) {
  if (product.platform === "shopify") return `${product.siteBase}/products/${product.handle}`;
  if (product.platform === "shopify-cart") return `${product.siteBase}/products/${product.handle}`;
  if (product.platform === "gamersroom") return product.url;
  if (product.platform === "woocommerce-single") return `${product.siteBase}/product/${product.slug}/`;
  if (product.platform === "woocommerce-batch") return product.siteBase;
  return product.siteBase;
}

// ── Discord ────────────────────────────────────────────
async function sendDiscord(content, embed, maxRetries = 3) {
  if (!config.DISCORD_WEBHOOK_URL) return;
  const body = {};
  if (content) body.content = content;
  if (embed) body.embeds = [embed];

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(config.DISCORD_WEBHOOK_URL, {
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
      if (i < maxRetries - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function notifyInStock(name, url, details) {
  const fields = [
    { name: "Price", value: details.price || "Unknown", inline: true },
    { name: "Status", value: details.stockText || "In Stock", inline: true },
  ];
  if (details.sizes) {
    fields.push({ name: "Sizes Available", value: details.sizes, inline: false });
  }
  await sendDiscord(`@everyone Stock alert! **${name}** is IN STOCK!\n${url}`, {
    title: `IN STOCK — ${name}`,
    url,
    color: 0x00ff00,
    fields,
    timestamp: new Date().toISOString(),
  });
}

async function notifyOutOfStock(name, url) {
  await sendDiscord(null, {
    title: `Back to Out of Stock — ${name}`,
    url,
    color: 0xff0000,
    timestamp: new Date().toISOString(),
  });
}

// Error/outage webhooks are intentionally disabled — sites go down and recover
// constantly, and those alerts were noise. Outages are logged to console only.
// Only stock changes (in/out) and the daily heartbeat are sent to Discord.

async function sendHeartbeat() {
  if (heartbeatLock) return;
  heartbeatLock = true;

  const statuses = [];
  for (const [name, s] of state) {
    statuses.push(`**${name}**: ${s.status}`);
  }

  await sendDiscord(null, {
    title: "Scanner Heartbeat",
    description: `Tracking **${state.size}** products\n\n${statuses.join("\n")}`,
    color: 0x3498db,
    timestamp: new Date().toISOString(),
  });
  lastHeartbeat = Date.now();
  heartbeatLock = false;
}

// ═══════════════════════════════════════════════════════
// WooCommerce single — API only
// ═══════════════════════════════════════════════════════
async function wooSingle(product) {
  const directUrl = cacheBust(`${product.apiBase}?slug=${product.slug}`);

  // Route through Cloudflare Worker proxy if configured (bypasses datacenter IP blocks)
  let url, headers;
  if (product.useProxy && config.PROXY_URL && config.PROXY_KEY) {
    url = `${config.PROXY_URL}?url=${encodeURIComponent(directUrl)}`;
    headers = {
      Accept: "application/json",
      "Cache-Control": "no-cache, no-store",
      "x-proxy-key": config.PROXY_KEY,
    };
  } else {
    url = directUrl;
    headers = { Accept: "application/json", "Cache-Control": "no-cache, no-store" };
  }

  const res = await throttledFetch(url, { headers });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const data = await res.json();
  if (!data.length) throw new Error("API returned empty");
  const p = data[0];
  return {
    status: p.is_in_stock ? "in_stock" : "out_of_stock",
    price: stripHTML(p.price_html || "?"),
    stockText: p.stock_availability?.text || "?",
    source: "woo-slug",
  };
}

// ═══════════════════════════════════════════════════════
// Shopify — JSON only
// ═══════════════════════════════════════════════════════
async function shopifySingle(product) {
  const url = cacheBust(`${product.siteBase}/products/${product.handle}.json`);
  const res = await throttledFetch(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache, no-store" },
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}`);
  const data = await res.json();
  const p = data.product;

  const inStock = p.variants.filter((v) => {
    if (v.inventory_management === null) return true;
    if (v.inventory_policy === "continue") return true;
    return v.inventory_quantity > 0;
  });

  return {
    status: inStock.length > 0 ? "in_stock" : "out_of_stock",
    price: `$${p.variants[0]?.price || "?"}`,
    stockText: inStock.length > 0 ? `${inStock.length} variant(s) in stock` : "Out of stock",
    sizes: inStock.length > 0 ? inStock.map((v) => `${v.title} (qty: ${v.inventory_quantity})`).join(", ") : null,
    source: "shopify-json",
  };
}

// ═══════════════════════════════════════════════════════
// GamersRoom — meta tag
// ═══════════════════════════════════════════════════════
async function gamersroomCheck(product) {
  const res = await throttledFetch(cacheBust(product.url), {
    headers: {
      "User-Agent": config.USER_AGENT,
      Accept: "text/html",
      "Cache-Control": "no-cache, no-store",
      Range: "bytes=0-8191",  // meta tags live in <head>, first 8KB is enough
    },
  });
  if (!res.ok && res.status !== 206) throw new Error(`GamersRoom HTTP ${res.status}`);
  const html = await res.text();

  const metaMatch = html.match(/product:availability['"]\s*content=['"]([^'"]+)['"]/i);
  const availability = metaMatch ? metaMatch[1].toLowerCase() : null;

  const priceMatch = html.match(/product:price:amount['"]\s*content=['"]([^'"]+)['"]/i);
  const price = priceMatch ? `$${priceMatch[1]}` : "?";

  if (availability === "in stock" || availability === "instock") {
    return { status: "in_stock", price, stockText: "In stock", source: "gamersroom" };
  }
  if (availability === "out of stock" || availability === "oos") {
    return { status: "out_of_stock", price, stockText: "Out of stock", source: "gamersroom" };
  }
  if (/out.of.stock/i.test(html)) {
    return { status: "out_of_stock", price, stockText: "Out of stock", source: "gamersroom" };
  }
  return { status: "unknown", price, stockText: "?", source: "gamersroom" };
}

// ═══════════════════════════════════════════════════════
// Shopify Cart Check — for stores that hide inventory fields
// Uses cart/add.js: returns 422 "sold out" or 200 (available)
// ═══════════════════════════════════════════════════════
async function shopifyCartCheck(product) {
  const directUrl = `${product.siteBase}/cart/add.js`;

  let url, headers;
  if (product.useProxy && config.PROXY_URL && config.PROXY_KEY) {
    // Route through Cloudflare Worker — bypasses Cloudflare bot detection (internal traffic)
    url = `${config.PROXY_URL}?url=${encodeURIComponent(directUrl)}&method=POST`;
    headers = {
      "Content-Type": "application/json",
      "x-proxy-key": config.PROXY_KEY,
    };
  } else {
    url = directUrl;
    headers = {
      "Content-Type": "application/json",
      "User-Agent": config.USER_AGENT,
      "Cache-Control": "no-cache, no-store",
    };
  }

  const res = await throttledFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: [{ id: product.variantId, quantity: 1 }] }),
  });

  const data = await res.json();

  if (res.status === 200) {
    // Successfully added — it's in stock. Clear the cart to avoid accumulation.
    await fetch(`${product.siteBase}/cart/clear.js`, { method: "POST" }).catch(() => {});
    return {
      status: "in_stock",
      price: product.price || "?",
      stockText: "In stock (cart check)",
      source: "shopify-cart",
    };
  }

  if (res.status === 422 && /sold out/i.test(data.message || data.description || "")) {
    return {
      status: "out_of_stock",
      price: product.price || "?",
      stockText: "Sold out",
      source: "shopify-cart",
    };
  }

  throw new Error(`Shopify cart unexpected: HTTP ${res.status} — ${data.message || JSON.stringify(data)}`);
}

// ═══════════════════════════════════════════════════════
// State transition handler
// ═══════════════════════════════════════════════════════
async function handleResult(name, url, result) {
  const prev = state.get(name)?.status || "unknown";

  if (result.status === "in_stock" && prev !== "in_stock") {
    log(`IN STOCK: ${name}`);
    await notifyInStock(name, url, result);
  } else if (result.status === "out_of_stock" && prev === "in_stock") {
    await notifyOutOfStock(name, url);
  }
  // "unknown" status (page structure changed) is logged upstream, not webhooked.

  state.set(name, { status: result.status });
  errorCount.set(name, 0);
}

// ═══════════════════════════════════════════════════════
// Product loops with adaptive backoff
// ═══════════════════════════════════════════════════════
function startSingleLoop(product) {
  const checkFn =
    product.platform === "shopify" ? shopifySingle :
    product.platform === "shopify-cart" ? shopifyCartCheck :
    product.platform === "gamersroom" ? gamersroomCheck :
    wooSingle;

  async function tick() {
    if (!running) return;
    const start = performance.now();

    let nextInterval = product.intervalMs;

    try {
      const result = await checkFn(product);
      const total = (performance.now() - start).toFixed(0);
      log(`[${total}ms] ${product.name} → ${result.source} → ${result.status}${result.sizes ? ` [${result.sizes}]` : ""}`);
      await handleResult(product.name, productUrl(product), result);
    } catch (err) {
      const count = (errorCount.get(product.name) || 0) + 1;
      errorCount.set(product.name, count);

      // Adaptive backoff: the more consecutive errors, the longer we wait
      // 1-5 errors: normal interval, 6-15: 2x, 16-30: 4x, 30+: 8x (max ~40s)
      const backoffMultiplier =
        count <= 5 ? 1 :
        count <= 15 ? 2 :
        count <= 30 ? 4 : 8;
      nextInterval = product.intervalMs * backoffMultiplier;

      log(`ERROR ${product.name} (${count}/${config.MAX_CONSECUTIVE_ERRORS}) [next: ${(nextInterval / 1000).toFixed(0)}s]: ${err.message}`);

      // Error webhooks are disabled — outages are logged to console only, never
      // sent to Discord. The scanner keeps retrying with adaptive backoff and will
      // still fire the in-stock alert the moment a site recovers with stock.
    }

    if (Date.now() - lastHeartbeat > config.HEARTBEAT_INTERVAL_MS) await sendHeartbeat();
    if (!running) return;

    const jitter = Math.floor(Math.random() * product.jitterMs * 2) - product.jitterMs;
    setTimeout(tick, nextInterval + jitter);
  }

  // Stagger start
  setTimeout(tick, Math.floor(Math.random() * product.intervalMs));
}

// ── Shutdown ───────────────────────────────────────────
function shutdown(sig) {
  log(`${sig} — stopping.`);
  running = false;
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Bootstrap ──────────────────────────────────────────
async function main() {
  if (!config.DISCORD_WEBHOOK_URL) {
    console.error("DISCORD_WEBHOOK_URL is required.");
    process.exit(1);
  }

  log("DropScanner v11 — throttled");
  config.PRODUCTS.forEach((p) =>
    log(`  ${p.platform.padEnd(18)} ${p.name.padEnd(40)} every ${p.intervalMs / 1000}s`)
  );

  // Initialize state
  for (const p of config.PRODUCTS) {
    state.set(p.name, { status: "unknown" });
  }

  await sendHeartbeat();
  config.PRODUCTS.forEach((p) => startSingleLoop(p));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
