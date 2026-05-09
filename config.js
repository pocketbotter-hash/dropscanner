module.exports = {
  PRODUCTS: [
    // ── WooCommerce (cardplustcg.com) ──
    {
      name: "OP-17 Booster Box",
      platform: "woocommerce",
      slug: "one-piece-cg-op-17-booster-display-box-english-release-date-sept-2026",
      id: 13708,
      siteBase: "https://cardplustcg.com",
      apiBase: "https://cardplustcg.com/wp-json/wc/store/v1/products",
      intervalMs: 5_000,
      jitterMs: 500,
    },
    {
      name: "EB-05 Extra Booster",
      platform: "woocommerce",
      slug: "one-piece-card-game-extra-booster-display-tba-eb-05-pre-order",
      id: 14565,
      siteBase: "https://cardplustcg.com",
      apiBase: "https://cardplustcg.com/wp-json/wc/store/v1/products",
      intervalMs: 5_000,
      jitterMs: 500,
    },
  ],

  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || "",

  HEARTBEAT_INTERVAL_MS: 24 * 60 * 60_000,

  REQUEST_TIMEOUT_MS: 10_000,

  MAX_CONSECUTIVE_ERRORS: 10,

  USER_AGENT:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};
