export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. PUBLIC STORE DATA (GET /api/store)
    if (url.pathname === "/api/store" && request.method === "GET") {
      try {
        const raw = env.SHOP_DATA ? await env.SHOP_DATA.get("store_data") : null;
        if (!raw) {
          return new Response(JSON.stringify({ products: null, approvedReviews: null }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        const parsed = JSON.parse(raw);
        return new Response(JSON.stringify({
          products: parsed.products || new Array(),
          approvedReviews: parsed.approvedReviews || new Array(),
        }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 2. CUSTOMER SUBMITS A REVIEW FOR APPROVAL (POST /api/review)
    if (url.pathname === "/api/review" && request.method === "POST") {
      try {
        const body = await request.json();
        const name = String(body.name || "").trim().slice(0, 60);
        const comment = String(body.comment || "").trim().slice(0, 800);
        const stars = Math.min(5, Math.max(1, parseInt(body.stars) || 5));
        const photo = (typeof body.photo === "string" && body.photo.startsWith("data:image/"))
          ? body.photo
          : "";

        if (!name || !comment) {
          return new Response(JSON.stringify({ error: "Name and comment are required." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const raw = await env.SHOP_DATA.get("store_data");
        const data = raw ? JSON.parse(raw) : { products: new Array(), approvedReviews: new Array(), pendingReviews: new Array() };
        if (!Array.isArray(data.pendingReviews)) data.pendingReviews = new Array();

        data.pendingReviews.unshift({
          id: "rev-" + Date.now(),
          name,
          stars,
          comment,
          photo,
          submittedAt: new Date().toISOString(),
        });

        await env.SHOP_DATA.put("store_data", JSON.stringify(data));
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 3. ADMIN LOAD (POST /api/admin/load)
    if (url.pathname === "/api/admin/load" && request.method === "POST") {
      try {
        const body = await request.json();
        if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) {
          return new Response(JSON.stringify({ error: "Incorrect password." }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const raw = await env.SHOP_DATA.get("store_data");
        const data = raw ? JSON.parse(raw) : { products: new Array(), approvedReviews: new Array(), pendingReviews: new Array() };

        return new Response(JSON.stringify({
          products: data.products || new Array(),
          approvedReviews: data.approvedReviews || new Array(),
          pendingReviews: data.pendingReviews || new Array(),
        }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 4. ADMIN SAVE & PUBLISH LIVE (POST /api/admin/save)
    if (url.pathname === "/api/admin/save" && request.method === "POST") {
      try {
        const body = await request.json();
        if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) {
          return new Response(JSON.stringify({ error: "Incorrect password." }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const toSave = {
          products: Array.isArray(body.products) ? body.products : new Array(),
          approvedReviews: Array.isArray(body.approvedReviews) ? body.approvedReviews : new Array(),
          pendingReviews: Array.isArray(body.pendingReviews) ? body.pendingReviews : new Array(),
        };

        await env.SHOP_DATA.put("store_data", JSON.stringify(toSave));
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 5. STRIPE CHECKOUT (POST /api/checkout)
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      try {
        const { items } = await request.json();
        if (!items || !Array.isArray(items) || items.length === 0) {
          return new Response(JSON.stringify({ error: "Basket is empty" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const subtotal = items.reduce((sum, item) => sum + Number(item.price) * Number(item.qty), 0);
        const shippingAmount = subtotal >= 50 ? 0 : 600;
        const shippingLabel = subtotal >= 50 ? "Free Standard Shipping ($50+ Order)" : "Standard USA Shipping";
        const zeroIdx = 0;

        const params = new URLSearchParams();
        params.append("mode", "payment");
        params.append("success_url", `${url.origin}/?success=true`);
        params.append("cancel_url", `${url.origin}/`);
        params.append(`shipping_address_collection[allowed_countries][${zeroIdx}]`, "US");
        params.append(`shipping_options[${zeroIdx}][shipping_rate_data][type]`, "fixed_amount");
        params.append(`shipping_options[${zeroIdx}][shipping_rate_data][fixed_amount][amount]`, String(shippingAmount));
        params.append(`shipping_options[${zeroIdx}][shipping_rate_data][fixed_amount][currency]`, "usd");
        params.append(`shipping_options[${zeroIdx}][shipping_rate_data][display_name]`, shippingLabel);

        items.forEach((item, idx) => {
          params.append(`line_items[${idx}][price_data][currency]`, "usd");
          params.append(`line_items[${idx}][price_data][product_data][name]`, String(item.name));
          params.append(`line_items[${idx}][price_data][unit_amount]`, String(Math.round(Number(item.price) * 100)));
          params.append(`line_items[${idx}][quantity]`, String(Number(item.qty)));
        });

        const stripeEndpoint = "https://api." + "://stripe.com";
        const stripeRes = await fetch(stripeEndpoint, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        });

        const session = await stripeRes.json();
        if (!stripeRes.ok) {
          return new Response(JSON.stringify({ error: session.error?.message || "Stripe error" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ url: session.url }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 6. SERVE STATIC SITE FILES
    return env.ASSETS.fetch(request);
  },
};
