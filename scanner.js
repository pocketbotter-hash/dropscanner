const cheerio = require("cheerio");
const config = require("./config");

const state = new Map();
const errorCount = new Map();
let lastHeartbeat = 0;
let running = true;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function cacheBust(url) {
  const u = new URL(url);
  u.searchParams.set("_cb", Date.now());
  return u.toString();
}

function stripHTML(str) {
  return str.replace(/<[^>]*>/g, "").replace(/&#036;/g, "$").replace(/&amp;/g, "&").trim();
}

async function fetchWithRetry(url, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
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
        log(`Fetch error on ${new URL(url).hostname} — retry ${i + 1}/${retries} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

function productUrl(product) {
  if (product.platform === "shopify") {
    return `${product.siteBase}/products/${product.handle}`;
  }
  return `${product.siteBase}/product/${product.slug}/`;
}

// ── Discord ────────────────────────────────────────────
async function sendDiscord(content, embed) {
  if (!config.DISCORD_WEBHOOK_URL) return;
  const body = {};
  if (content) body.content = content;
  if (embed) body.embeds = [embed];
  try {
    const res = await fetch(config.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") || 5) * 1000;
      await new Promise((r) => setTimeout(r, retry));
      return sendDiscord(content, embed);
    }
  } catch {}
}

async function notifyInStock(product, details) {
  const url = productUrl(product);
  const fields = [
    { name: "Price", value: details.price || "Unknown", inline: true },
    { name: "Status", value: details.stockText || "In Stock", inline: true },
  ];
  if (details.sizes) {
    fields.push({ name: "Sizes Available", value: details.sizes, inline: false });
  }

  await sendDiscord(`@everyone Stock alert! **${product.name}** is IN STOCK!\n${url}`, {
    title: `IN STOCK — ${product.name}`,
    url,
    color: 0x00ff00,
    fields,
    timestamp: new Date().toISOString(),
  });
}

async function notifyOutOfStock(product) {
  await sendDiscord(null, {
    title: `Back to Out of Stock — ${product.name}`,
    url: productUrl(product),
    color: 0xff0000,
    timestamp: new Date().toISOString(),
  });
}

async function notifyError(product, error) {
  const count = errorCount.get(product.name) || 0;
  await sendDiscord(null, {
    title: `Scanner Error — ${product.name}`,
    description: `Failed ${count}x.\n\`\`\`${error.message}\`\`\``,
    color: 0xffaa00,
    timestamp: new Date().toISOString(),
  });
}

async function sendHeartbeat() {
  const statuses = config.PRODUCTS.map(
    (p) => `**${p.name}** (${p.intervalMs / 1000}s): ${state.get(p.name)?.status || "unknown"}`
  ).join("\n");

  await sendDiscord(null, {
    title: "Scanner Heartbeat",
    description: `Tracking **${config.PRODUCTS.length}** products — independent timers\n\n${statuses}`,
    color: 0x3498db,
    timestamp: new Date().toISOString(),
  });
  lastHeartbeat = Date.now();
}

// ═══════════════════════════════════════════════════════
// WooCommerce channels
// ═══════════════════════════════════════════════════════
async function wooApiDirect(product) {
  const res = await fetchWithRetry(cacheBust(`${product.apiBase}/${product.id}`), {
    headers: { Accept: "application/json", "Cache-Control": "no-cache, no-store" },
    signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`API-ID HTTP ${res.status}`);
  const p = await res.json();
  return {
    status: p.is_in_stock ? "in_stock" : "out_of_stock",
    price: stripHTML(p.price_html || `$${(Number(p.prices?.price) / 100).toFixed(2)}`),
    stockText: p.stock_availability?.text || "?",
    source: "woo-api-id",
  };
}

async function wooApiSlug(product) {
  const res = await fetchWithRetry(cacheBust(`${product.apiBase}?slug=${product.slug}`), {
    headers: { Accept: "application/json", "Cache-Control": "no-cache, no-store" },
    signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`API-slug HTTP ${res.status}`);
  const products = await res.json();
  if (!products.length) throw new Error("API-slug empty");
  const p = products[0];
  return {
    status: p.is_in_stock ? "in_stock" : "out_of_stock",
    price: stripHTML(p.price_html || "?"),
    stockText: p.stock_availability?.text || "?",
    source: "woo-api-slug",
  };
}

async function wooHTML(product) {
  const url = cacheBust(productUrl(product));
  const res = await fetchWithRetry(url, {
    headers: { "User-Agent": config.USER_AGENT, Accept: "text/html", "Cache-Control": "no-cache, no-store" },
    signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTML HTTP ${res.status}`);
  const html = await res.text();

  if (/class="[^"]*out-of-stock[^"]*"/.test(html)) {
    return { status: "out_of_stock", price: "—", stockText: "Out of stock", source: "woo-html" };
  }

  const $ = cheerio.load(html);
  const isInStock =
    $(".stock").hasClass("in-stock") || $(".stock").text().toLowerCase().includes("in stock");
  const hasCart =
    $("button.single_add_to_cart_button").length > 0 ||
    $('form.cart button[type="submit"]').length > 0;

  return {
    status: isInStock || hasCart ? "in_stock" : "unknown",
    price: $(".price .woocommerce-Price-amount").first().text().trim(),
    stockText: $(".stock").text().trim(),
    source: "woo-html-full",
  };
}

// ═══════════════════════════════════════════════════════
// Shopify channels
// ═══════════════════════════════════════════════════════
async function shopifyJSON(product) {
  const url = cacheBust(`${product.siteBase}/products/${product.handle}.json`);
  const res = await fetch(url, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache, no-store" },
    signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Shopify JSON HTTP ${res.status}`);
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
    stockText: inStock.length > 0 ? `${inStock.length} size(s) in stock` : "Out of stock",
    sizes: inStock.length > 0 ? inStock.map((v) => `${v.title} (${v.inventory_quantity})`).join(", ") : null,
    source: "shopify-json",
  };
}

async function shopifyHTML(product) {
  const url = cacheBust(`${product.siteBase}/products/${product.handle}`);
  const res = await fetch(url, {
    headers: { "User-Agent": config.USER_AGENT, Accept: "text/html", "Cache-Control": "no-cache, no-store" },
    signal: AbortSignal.timeout(config.REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Shopify HTML HTTP ${res.status}`);
  const html = await res.text();

  const variantMatch = html.match(/"variants"\s*:\s*\[(.*?)\]/s);
  if (variantMatch) {
    try {
      const variants = JSON.parse(`[${variantMatch[1]}]`);
      const available = variants.filter((v) => v.available === true);
      if (available.length > 0) {
        return {
          status: "in_stock",
          price: available[0].price ? `$${(available[0].price / 100).toFixed(2)}` : "?",
          stockText: `${available.length} size(s) available`,
          sizes: available.map((v) => v.title || v.option1).join(", "),
          source: "shopify-html-json",
        };
      }
    } catch {}
  }

  const soldOut = /Sold\s*[Oo]ut|Out of [Ss]tock|Unavailable/i.test(html);
  const addToCart = /Add to [Cc]art/i.test(html);

  if (addToCart && !soldOut) {
    return { status: "in_stock", price: "—", stockText: "Available", source: "shopify-html" };
  }
  return { status: "out_of_stock", price: "—", stockText: "Sold out", source: "shopify-html" };
}

// ═══════════════════════════════════════════════════════
// Race: first "in_stock" wins
// ═══════════════════════════════════════════════════════
function getChannels(product) {
  if (product.platform === "woocommerce") {
    return [wooApiDirect(product), wooApiSlug(product), wooHTML(product)];
  }
  return [shopifyJSON(product), shopifyHTML(product)];
}

async function checkProduct(product) {
  const channels = getChannels(product);

  const raceResult = await new Promise((resolve) => {
    let settled = 0;
    const results = [];

    channels.forEach((p) => {
      p.then((r) => {
        if (r.status === "in_stock") {
          resolve({ winner: r });
          return;
        }
        results.push(r);
        settled++;
        if (settled === channels.length) resolve({ winner: null, all: results });
      }).catch((err) => {
        results.push({ status: "error", source: err.message });
        settled++;
        if (settled === channels.length) resolve({ winner: null, all: results });
      });
    });
  });

  if (raceResult.winner) return raceResult.winner;

  const valid = raceResult.all.filter((r) => r.status !== "error");
  if (!valid.length) {
    const errors = raceResult.all.map((r) => r.source).join(", ");
    throw new Error(`All channels failed: ${errors}`);
  }
  return valid[0];
}

// ═══════════════════════════════════════════════════════
// Independent loop per product
// ═══════════════════════════════════════════════════════
function startProductLoop(product) {
  async function tick() {
    if (!running) return;
    const start = performance.now();

    try {
      const result = await checkProduct(product);
      errorCount.set(product.name, 0);
      const total = (performance.now() - start).toFixed(0);

      log(`[${total}ms] ${product.name} → ${result.source} → ${result.status}${result.sizes ? ` [${result.sizes}]` : ""}`);

      const prev = state.get(product.name)?.status || "unknown";

      if (result.status === "in_stock" && prev !== "in_stock") {
        log(`IN STOCK: ${product.name} — SENDING ALERT`);
        await notifyInStock(product, result);
      } else if (result.status === "out_of_stock" && prev === "in_stock") {
        await notifyOutOfStock(product);
      } else if (result.status === "unknown" && prev !== "unknown") {
        await notifyError(product, new Error("Page structure changed."));
      }

      state.set(product.name, { status: result.status });
    } catch (err) {
      const count = (errorCount.get(product.name) || 0) + 1;
      errorCount.set(product.name, count);
      log(`ERROR ${product.name} (${count}/${config.MAX_CONSECUTIVE_ERRORS}): ${err.message}`);
      if (count === config.MAX_CONSECUTIVE_ERRORS) await notifyError(product, err);
    }

    // Heartbeat check (only one product needs to trigger it)
    if (Date.now() - lastHeartbeat > config.HEARTBEAT_INTERVAL_MS) await sendHeartbeat();

    if (!running) return;
    const jitter = Math.floor(Math.random() * product.jitterMs * 2) - product.jitterMs;
    setTimeout(tick, product.intervalMs + jitter);
  }

  // Stagger start: random offset so products don't all fire at once
  const offset = Math.floor(Math.random() * product.intervalMs);
  setTimeout(tick, offset);
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

  log("DropScanner v7 — independent timers");
  config.PRODUCTS.forEach((p) =>
    log(`  ${p.platform.padEnd(12)} ${p.name.padEnd(30)} every ${p.intervalMs / 1000}s`)
  );

  await sendHeartbeat();

  // Each product gets its own independent loop
  config.PRODUCTS.forEach((p) => startProductLoop(p));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
