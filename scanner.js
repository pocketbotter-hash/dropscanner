let cheerio = null; // Lazy-loaded only when needed
const config = require("./config");

const state = new Map();
const errorCount = new Map();
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

async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const signal = AbortSignal.timeout(config.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal });
      if (res.status === 429 && i < retries) {
        const wait = Math.pow(2, i + 1) * 1000;
        log(`429 on ${new URL(url).hostname} — retry in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (err) {
      if (i < retries) {
        const wait = Math.pow(2, i + 1) * 1000;
        log(`Fetch error — retry ${i + 1}/${retries} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

function productUrl(product) {
  if (product.platform === "shopify") return `${product.siteBase}/products/${product.handle}`;
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

async function notifyError(name, error) {
  const count = errorCount.get(name) || 0;
  await sendDiscord(null, {
    title: `Scanner Error — ${name}`,
    description: `Failed ${count}x.\n\`\`\`${error.message}\`\`\``,
    color: 0xffaa00,
    timestamp: new Date().toISOString(),
  });
}

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
// WooCommerce batch — single request, multiple products
// ═══════════════════════════════════════════════════════
async function wooBatch(product) {
  const url = cacheBust(`${product.apiBase}?include=${product.ids.join(",")}`);
  const res = await fetchWithRetry(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache, no-store" },
  });
  if (!res.ok) throw new Error(`Batch HTTP ${res.status}`);
  const products = await res.json();

  // Return results for each product in the batch
  return product.ids.map((id, i) => {
    const p = products.find((x) => x.id === id);
    if (!p) return { name: product.names[i], status: "error", source: "batch-missing" };
    return {
      name: product.names[i],
      status: p.is_in_stock ? "in_stock" : "out_of_stock",
      price: stripHTML(p.price_html || "?"),
      stockText: p.stock_availability?.text || "?",
      url: `${product.siteBase}/product/${p.slug}/`,
      source: "woo-batch",
    };
  });
}

// ═══════════════════════════════════════════════════════
// WooCommerce single — API only (fast sites like M-G)
// ═══════════════════════════════════════════════════════
async function wooSingle(product) {
  // Use slug endpoint (benchmarked faster for M-G)
  const url = cacheBust(`${product.apiBase}?slug=${product.slug}`);
  const res = await fetchWithRetry(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache, no-store" },
  });
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
// Shopify — JSON endpoint only (single variant, no HTML needed)
// ═══════════════════════════════════════════════════════
async function shopifySingle(product) {
  const url = cacheBust(`${product.siteBase}/products/${product.handle}.json`);
  const res = await fetchWithRetry(url, {
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
// GamersRoom — meta tag (single fast request)
// ═══════════════════════════════════════════════════════
async function gamersroomCheck(product) {
  const res = await fetchWithRetry(cacheBust(product.url), {
    headers: { "User-Agent": config.USER_AGENT, Accept: "text/html", "Cache-Control": "no-cache, no-store" },
  });
  if (!res.ok) throw new Error(`GamersRoom HTTP ${res.status}`);
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
// State transition handler
// ═══════════════════════════════════════════════════════
async function handleResult(name, url, result) {
  const prev = state.get(name)?.status || "unknown";

  if (result.status === "in_stock" && prev !== "in_stock") {
    log(`🚨 IN STOCK: ${name}`);
    await notifyInStock(name, url, result);
  } else if (result.status === "out_of_stock" && prev === "in_stock") {
    await notifyOutOfStock(name, url);
  } else if (result.status === "unknown" && prev !== "unknown") {
    await notifyError(name, new Error("Page structure changed."));
  }

  state.set(name, { status: result.status });
  errorCount.set(name, 0);
}

// ═══════════════════════════════════════════════════════
// Product loops
// ═══════════════════════════════════════════════════════
function startBatchLoop(product) {
  async function tick() {
    if (!running) return;
    const start = performance.now();

    try {
      const results = await wooBatch(product);
      const total = (performance.now() - start).toFixed(0);

      for (const r of results) {
        if (r.status === "error") {
          log(`[${total}ms] ${r.name} → ${r.source} → MISSING`);
          continue;
        }
        log(`[${total}ms] ${r.name} → ${r.source} → ${r.status}`);
        await handleResult(r.name, r.url, r);
      }
    } catch (err) {
      // Apply error to all products in the batch
      for (const name of product.names) {
        const count = (errorCount.get(name) || 0) + 1;
        errorCount.set(name, count);
        log(`ERROR ${name} (${count}/${config.MAX_CONSECUTIVE_ERRORS}): ${err.message}`);
        if (count > 0 && count % config.MAX_CONSECUTIVE_ERRORS === 0) {
          await notifyError(name, err);
        }
      }
    }

    if (Date.now() - lastHeartbeat > config.HEARTBEAT_INTERVAL_MS) await sendHeartbeat();
    if (!running) return;
    const jitter = Math.floor(Math.random() * product.jitterMs * 2) - product.jitterMs;
    setTimeout(tick, product.intervalMs + jitter);
  }

  setTimeout(tick, Math.floor(Math.random() * product.intervalMs));
}

function startSingleLoop(product) {
  const checkFn =
    product.platform === "shopify" ? shopifySingle :
    product.platform === "gamersroom" ? gamersroomCheck :
    wooSingle;

  async function tick() {
    if (!running) return;
    const start = performance.now();

    try {
      const result = await checkFn(product);
      const total = (performance.now() - start).toFixed(0);
      log(`[${total}ms] ${product.name} → ${result.source} → ${result.status}${result.sizes ? ` [${result.sizes}]` : ""}`);
      await handleResult(product.name, productUrl(product), result);
    } catch (err) {
      const count = (errorCount.get(product.name) || 0) + 1;
      errorCount.set(product.name, count);
      log(`ERROR ${product.name} (${count}/${config.MAX_CONSECUTIVE_ERRORS}): ${err.message}`);
      if (count > 0 && count % config.MAX_CONSECUTIVE_ERRORS === 0) {
        await notifyError(product.name, err);
      }
    }

    if (Date.now() - lastHeartbeat > config.HEARTBEAT_INTERVAL_MS) await sendHeartbeat();
    if (!running) return;
    const jitter = Math.floor(Math.random() * product.jitterMs * 2) - product.jitterMs;
    setTimeout(tick, product.intervalMs + jitter);
  }

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

  log("DropScanner v9 — optimised");

  // Initialize state for all tracked product names
  for (const p of config.PRODUCTS) {
    if (p.platform === "woocommerce-batch") {
      for (const name of p.names) state.set(name, { status: "unknown" });
      log(`  batch(${p.ids.length})    ${p.names.join(", ").padEnd(50)} every ${p.intervalMs / 1000}s`);
    } else {
      state.set(p.name, { status: "unknown" });
      log(`  ${p.platform.padEnd(12)} ${p.name.padEnd(40)} every ${p.intervalMs / 1000}s`);
    }
  }

  await sendHeartbeat();

  for (const p of config.PRODUCTS) {
    if (p.platform === "woocommerce-batch") {
      startBatchLoop(p);
    } else {
      startSingleLoop(p);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
