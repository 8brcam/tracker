export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Helper: Load store data from KV (falls back to index.html defaults on first run)
    async function getStoreData() {
      let data = env.SHOP_DATA ? await env.SHOP_DATA.get("store_data", "json") : null;
      if (!data) {
        const assetRes = await env.ASSETS.fetch(new Request(`${url.origin}/`));
        const html = await assetRes.text();
        const prodMatch = html.match(/const storeProducts\s*=\s*(\[[\s\S]*?\]);/);
        const revMatch = html.match(/const approvedReviews\s*=\s*(\[[\s\S]*?\]);/);
        data = {
          products: prodMatch ? JSON.parse(prodMatch[1]) : [],
          approvedReviews: revMatch ? JSON.parse(revMatch[1]) : [],
          pendingReviews: []
        };
      }
      return data;
    }

    // 1. PUBLIC API: Fetch live products & approved reviews
    if (url.pathname === "/api/store" && request.method === "GET") {
      const data = await getStoreData();
      return new Response(JSON.stringify({
        products: data.products || [],
        approvedReviews: data.approvedReviews || []
      }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. PUBLIC API: Customer submits a review (with optional photo) -> Pending queue
    if (url.pathname === "/api/review" && request.method === "POST") {
      try {
        const body = await request.json();
        const name = (body.name || "").trim().slice(0, 60);
        const comment = (body.comment || "").trim().slice(0, 500);
        const stars = Math.min(5, Math.max(1, parseInt(body.stars || 5, 10)));
        const photo = typeof body.photo === "string" && body.photo.startsWith("data:image/")
          ? body.photo.slice(0, 350000)
          : "";

        if (!name || !comment) {
          return new Response(JSON.stringify({ error: "Please enter your name and review." }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const data = await getStoreData();
        data.pendingReviews = data.pendingReviews || [];
        data.pendingReviews.unshift({
          id: Date.now().toString(),
          name,
          stars,
          comment,
          photo
        });

        await env.SHOP_DATA.put("store_data", JSON.stringify(data));
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 3. ADMIN API: Load products + approved + pending reviews for Michal's Editor
    if (url.pathname === "/api/admin/load" && request.method === "POST") {
      const { password } = await request.json();
      if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Incorrect password" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
      const data = await getStoreData();
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" }
      });
    }
    // 4. ADMIN API: Save all changes live instantly
    if (url.pathname === "/api/admin/save" && request.method === "POST") {
      try {
        const { password, products, approvedReviews, pendingReviews } = await request.json();
        if (!env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) {
          return new Response(JSON.stringify({ error: "Incorrect password" }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }

        await env.SHOP_DATA.put("store_data", JSON.stringify({
          products: products || [],
          approvedReviews: approvedReviews || [],
          pendingReviews: pendingReviews || []
        }));

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 5. STRIPE CHECKOUT API: Verifies real prices from live KV catalog
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      try {
        const { items } = await request.json();
        const stripeKey = env.STRIPE_SECRET_KEY;

        if (!stripeKey) {
          return new Response(JSON.stringify({ error: "Missing STRIPE_SECRET_KEY in Cloudflare" }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }

        if (!Array.isArray(items) || items.length === 0) {
          return new Response(JSON.stringify({ error: "Your cart is empty" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        const storeData = await getStoreData();
        const catalog = storeData.products || [];

        const params = new URLSearchParams();
        params.append("mode", "payment");
        params.append("shipping_address_collection[allowed_countries]", "US");
        params.append("success_url", `${url.origin}/?success=true`);
        params.append("cancel_url", `${url.origin}/?canceled=true`);

        let subtotalCents = 0;

        items.forEach((item, index) => {
          const officialItem = catalog.find(p => p.id === item.id || p.name === item.name);
          const verifiedPrice = officialItem ? Number(officialItem.price) : Number(item.price);
          const verifiedName = officialItem ? officialItem.name : item.name;
          const qty = Math.max(1, parseInt(item.qty || item.quantity || 1, 10));
          const unitAmount = Math.round(verifiedPrice * 100);

          subtotalCents += unitAmount * qty;

          params.append(`line_items[${index}][price_data][currency]`, "usd");
          params.append(`line_items[${index}][price_data][product_data][name]`, verifiedName);
          params.append(`line_items[${index}][price_data][unit_amount]`, unitAmount);
          params.append(`line_items[${index}][quantity]`, qty);
        });

        // ============================================================
        // CHANGE YOUR SHIPPING PRICES HERE LATER (in cents)
        // Examples: $1.00 = 100 | $3.50 = 350 | $6.00 = 600 | Free = 0
        // ============================================================
        const THRESHOLD_CENTS = 5000;          // Spend $50.00+ for free shipping
        const STANDARD_SHIPPING_CENTS = 600;   // $6.00 shipping if under $50.00
        const DISCOUNTED_SHIPPING_CENTS = 0;   // $0.00 (Free) shipping if $50.00 or more
        // ============================================================

        const qualifiesForDiscount = subtotalCents >= THRESHOLD_CENTS;
        const finalShippingCents = qualifiesForDiscount ? DISCOUNTED_SHIPPING_CENTS : STANDARD_SHIPPING_CENTS;
        const shippingName = qualifiesForDiscount
          ? (finalShippingCents === 0 ? "Free Standard Shipping" : "Discounted Standard Shipping")
          : "US Standard Shipping";

        params.append("shipping_options[shipping_rate_data][type]", "fixed_amount");
        params.append("shipping_options[shipping_rate_data][fixed_amount][amount]", finalShippingCents.toString());
        params.append("shipping_options[shipping_rate_data][fixed_amount][currency]", "usd");
        params.append("shipping_options[shipping_rate_data][display_name]", shippingName);
        params.append("shipping_options[shipping_rate_data][delivery_estimate][minimum][unit]", "business_day");
        params.append("shipping_options[shipping_rate_data][delivery_estimate][minimum][value]", "3");
        params.append("shipping_options[shipping_rate_data][delivery_estimate][maximum][unit]", "business_day");
        params.append("shipping_options[shipping_rate_data][delivery_estimate][maximum][value]", "7");

        const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${stripeKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        });

        const session = await response.json();
        if (session.error) {
          return new Response(JSON.stringify({ error: session.error.message }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
          });
        }

        return new Response(JSON.stringify({ url: session.url }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // Serve your normal website files (index.html, banner image, etc.)
    return env.ASSETS.fetch(request);
  }
};
