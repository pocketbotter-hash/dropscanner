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
    },
    {
      name: "EB-05 Extra Booster",
      platform: "woocommerce",
      slug: "one-piece-card-game-extra-booster-display-tba-eb-05-pre-order",
      id: 14565,
      siteBase: "https://cardplustcg.com",
      apiBase: "https://cardplustcg.com/wp-json/wc/store/v1/products",
    },

    // ── Shopify (sptfootball.com.au) ──
    {
      name: "Nike Mind 001 Slides - White",
      platform: "shopify",
      handle: "nike-mind-001-adults-pregame-slides-white",
      siteBase: "https://sptfootball.com.au",
    },
    {
      name: "Nike Mind 001 Slides - Red",
      platform: "shopify",
      handle: "nike-mind-001-adults-pregame-slides-red",
      siteBase: "https://sptfootball.com.au",
    },
    {
      name: "Nike Mind 001 Slides - Blue",
      platform: "shopify",
      handle: "nike-mind-001-adults-pregame-slides-blue",
      siteBase: "https://sptfootball.com.au",
    },
  ],

  DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL || "",

  POLL_INTERVAL_MS: 5_000,
  JITTER_MS: 500,

  HEARTBEAT_INTERVAL_MS: 24 * 60 * 60_000,

  REQUEST_TIMEOUT_MS: 10_000,

  MAX_CONSECUTIVE_ERRORS: 10,

  USER_AGENT:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};
