module.exports = {
  PRODUCTS: [
    // ── Gameology (Shopify) ──
    {
      name: "OP-17 Booster (Gameology)",
      platform: "shopify",
      handle: "one-piece-card-game-op-17-booster-box",
      siteBase: "https://www.gameology.com.au",
      intervalMs: 3_000,
      jitterMs: 300,
    },
    {
      name: "OP-18 Booster (Gameology)",
      platform: "shopify",
      handle: "one-piece-card-game-op-18-booster-box",
      siteBase: "https://www.gameology.com.au",
      intervalMs: 3_000,
      jitterMs: 300,
    },
    {
      name: "EB-05 Booster (Gameology)",
      platform: "shopify",
      handle: "one-piece-card-game-eb-05-booster-box",
      siteBase: "https://www.gameology.com.au",
      intervalMs: 3_000,
      jitterMs: 300,
    },

    // ── Collectible Madness (Shopify) ──
    {
      name: "OP-17 Booster (Collectible Madness)",
      platform: "shopify",
      handle: "one-piece-card-game-tba-op-17-booster-box",
      siteBase: "https://collectiblemadness.com.au",
      intervalMs: 3_000,
      jitterMs: 300,
    },

    // ── GameTraders (Shopify) ──
    {
      name: "OP-18 Booster (GameTraders)",
      platform: "shopify",
      handle: "pre-order-one-piece-card-game-booster-display-tba-op-18-20th-november",
      siteBase: "https://www.gametradersinglefarm.com.au",
      intervalMs: 3_000,
      jitterMs: 300,
    },
    {
      name: "EB-05 Booster (GameTraders)",
      platform: "shopify",
      handle: "pre-order-one-piece-card-game-extra-booster-box-tba-eb-05-30th-october",
      siteBase: "https://www.gametradersinglefarm.com.au",
      intervalMs: 3_000,
      jitterMs: 300,
    },

    // ── M-G (WooCommerce) ──
    {
      name: "OP-17 Booster (M-G)",
      platform: "woocommerce-single",
      slug: "one-piece-card-game-tba-op-17-booster-box-limit-1",
      id: 116375,
      siteBase: "https://www.m-g.com.au",
      apiBase: "https://www.m-g.com.au/wp-json/wc/store/v1/products",
      intervalMs: 3_000,
      jitterMs: 300,
    },
    {
      name: "EB-05 Booster (M-G)",
      platform: "woocommerce-single",
      slug: "one-piece-card-game-tba-eb-05-booster-box",
      id: 121797,
      siteBase: "https://www.m-g.com.au",
      apiBase: "https://www.m-g.com.au/wp-json/wc/store/v1/products",
      intervalMs: 3_000,
      jitterMs: 300,
    },

    // ── CardPlus (WooCommerce) ──
    {
      name: "EB-05 Booster (CardPlus)",
      platform: "woocommerce-single",
      slug: "one-piece-card-game-extra-booster-display-tba-eb-05-pre-order",
      id: 14565,
      siteBase: "https://cardplustcg.com",
      apiBase: "https://cardplustcg.com/wp-json/wc/store/v1/products",
      intervalMs: 5_000,
      jitterMs: 500,
    },
    {
      name: "OP-18 Booster (CardPlus)",
      platform: "woocommerce-single",
      slug: "one-piece-cg-op-18-booster-display-box-english-release-date-20-nov-2026-pre-order",
      id: 15244,
      siteBase: "https://cardplustcg.com",
      apiBase: "https://cardplustcg.com/wp-json/wc/store/v1/products",
      intervalMs: 5_000,
      jitterMs: 500,
    },

    // ── GamersRoom (custom) ──
    {
      name: "OP-17 Booster (GamersRoom)",
      platform: "gamersroom",
      url: "https://www.gamersroom.com.au/shop/one-piece-card-game-booster-display-tba-op-17/276222",
      intervalMs: 3_000,
      jitterMs: 300,
    },
    {
      name: "EB-05 Extra Booster (GamersRoom)",
      platform: "gamersroom",
      url: "https://www.gamersroom.com.au/shop/one-piece-card-game-extra-booster-display-tba-eb-05pre-order/2882601",
      intervalMs: 3_000,
      jitterMs: 300,
    },
  ],

  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || "",

  HEARTBEAT_INTERVAL_MS: 24 * 60 * 60_000,

  REQUEST_TIMEOUT_MS: 10_000,

  MAX_CONSECUTIVE_ERRORS: 30,

  USER_AGENT:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};
