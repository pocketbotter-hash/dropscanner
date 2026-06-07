// Cloudflare Worker — lightweight proxy for stores that block datacenter IPs
// or have aggressive Cloudflare bot detection.
// Free tier: 100,000 requests/day (we use ~50K)

const ALLOWED_HOSTS = [
  "cardplustcg.com",
  "treasurecollectables.com.au",
];

export default {
  async fetch(request, env) {
    // Auth: require a secret header to prevent abuse
    if (request.headers.get("x-proxy-key") !== env.PROXY_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }

    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) return new Response("Missing ?url= param", { status: 400 });

    // Allowlist check
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("Invalid URL", { status: 400 });
    }
    if (!ALLOWED_HOSTS.some((h) => targetUrl.hostname.endsWith(h))) {
      return new Response("Host not allowed", { status: 403 });
    }

    // Support both GET and POST proxying
    const method = url.searchParams.get("method") || request.method;
    const fetchOptions = {
      method,
      headers: {
        Accept: request.headers.get("Accept") || "application/json",
        "Cache-Control": "no-cache, no-store",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      },
    };

    // Forward body for POST requests
    if (method === "POST") {
      fetchOptions.headers["Content-Type"] = request.headers.get("Content-Type") || "application/json";
      fetchOptions.body = await request.text();
    }

    try {
      const res = await fetch(target, fetchOptions);

      return new Response(res.body, {
        status: res.status,
        headers: {
          "Content-Type": res.headers.get("Content-Type") || "application/json",
          "X-Proxy": "cf-worker",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
};
