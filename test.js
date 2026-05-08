const cheerio = require("cheerio");

let passed = 0;
let failed = 0;

function assert(name, actual, expected) {
  if (actual === expected) {
    passed++;
  } else {
    console.log(`  FAIL: ${name} — expected "${expected}", got "${actual}"`);
    failed++;
  }
}

// ── HTML regex fast-path (mirrors scanner logic) ───────
function checkHTMLFast(html) {
  if (/class="[^"]*out-of-stock[^"]*"/.test(html)) {
    const priceMatch = html.match(/woocommerce-Price-amount[^>]*>([^<]+)/);
    return {
      status: "out_of_stock",
      price: priceMatch ? priceMatch[1].replace(/<[^>]*>/g, "").trim() : "?",
      source: "html-fast",
    };
  }

  const $ = cheerio.load(html);
  const stockEl = $(".stock");
  const isInStock =
    stockEl.hasClass("in-stock") || stockEl.text().toLowerCase().includes("in stock");
  const hasCartButton =
    $("button.single_add_to_cart_button").length > 0 ||
    $('form.cart button[type="submit"]').length > 0;

  return {
    status: isInStock || hasCartButton ? "in_stock" : "unknown",
    price: $(".price .woocommerce-Price-amount").first().text().trim(),
    source: "html-full",
  };
}

// ── API response parser (mirrors scanner logic) ────────
function checkAPI(product) {
  return {
    status: product.is_in_stock ? "in_stock" : "out_of_stock",
    price: product.price_html || "?",
    source: "api",
  };
}

// ── Dual-channel merge (mirrors scanner logic) ─────────
function mergeResults(api, html) {
  if (!api && !html) return null;
  if (api?.status === "in_stock" || html?.status === "in_stock") {
    return api?.status === "in_stock" ? api : html;
  }
  if (
    (api?.status === "out_of_stock" || !api) &&
    (html?.status === "out_of_stock" || !html)
  ) {
    return api || html;
  }
  return api || html;
}

// ═══════════════════════════════════════════════════════
console.log("── HTML fast-path tests ──");

console.log("1: Out of stock (regex fast-path)");
let r = checkHTMLFast(`<p class="stock out-of-stock">Out of stock</p>
  <span class="woocommerce-Price-amount"><bdi>$35.00</bdi></span>`);
assert("status", r.status, "out_of_stock");
assert("source", r.source, "html-fast");

console.log("2: In stock (cheerio fallback)");
r = checkHTMLFast(`<p class="stock in-stock">In stock</p>
  <span class="woocommerce-Price-amount"><bdi>$35.00</bdi></span>
  <form class="cart"><button type="submit" class="single_add_to_cart_button">Add to cart</button></form>`);
assert("status", r.status, "in_stock");
assert("source", r.source, "html-full");

console.log("3: Cart button only (no stock class)");
r = checkHTMLFast(`<form class="cart"><button type="submit" class="single_add_to_cart_button">Add to cart</button></form>`);
assert("status", r.status, "in_stock");

console.log("4: Empty page (unknown)");
r = checkHTMLFast(`<div>nothing here</div>`);
assert("status", r.status, "unknown");

// ═══════════════════════════════════════════════════════
console.log("\n── API response tests ──");

console.log("5: API out of stock");
r = checkAPI({ is_in_stock: false, price_html: "$35.00" });
assert("status", r.status, "out_of_stock");

console.log("6: API in stock");
r = checkAPI({ is_in_stock: true, price_html: "$35.00" });
assert("status", r.status, "in_stock");

// ═══════════════════════════════════════════════════════
console.log("\n── Dual-channel merge tests ──");

console.log("7: Both out of stock");
r = mergeResults({ status: "out_of_stock", source: "api" }, { status: "out_of_stock", source: "html-fast" });
assert("status", r.status, "out_of_stock");

console.log("8: API says in_stock, HTML says out_of_stock → trust in_stock");
r = mergeResults({ status: "in_stock", source: "api" }, { status: "out_of_stock", source: "html-fast" });
assert("status", r.status, "in_stock");
assert("source", r.source, "api");

console.log("9: API says out_of_stock, HTML says in_stock → trust in_stock");
r = mergeResults({ status: "out_of_stock", source: "api" }, { status: "in_stock", source: "html-full" });
assert("status", r.status, "in_stock");
assert("source", r.source, "html-full");

console.log("10: API failed, HTML says out_of_stock → use HTML");
r = mergeResults(null, { status: "out_of_stock", source: "html-fast" });
assert("status", r.status, "out_of_stock");

console.log("11: API failed, HTML says in_stock → use HTML");
r = mergeResults(null, { status: "in_stock", source: "html-full" });
assert("status", r.status, "in_stock");

console.log("12: Both failed");
r = mergeResults(null, null);
assert("null", r, null);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
