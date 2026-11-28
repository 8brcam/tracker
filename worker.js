async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map(p => p.split("=")));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`));
  const expected = Array.from(new Uint8Array(signed)).map(b => b.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}

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
          products: parsed.products || [],
          approvedReviews: parsed.approvedReviews || [],
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
        const data = raw ? JSON.parse(raw) : { products: [], approvedReviews: [], pendingReviews: [] };
        if (!Array.isArray(data.pendingReviews)) data.pendingReviews = [];

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
        const data = raw ? JSON.parse(raw) : { products: [], approvedReviews: [], pendingReviews: [] };

        return new Response(JSON.stringify({
          products: data.products || [],
          approvedReviews: data.approvedReviews || [],
          pendingReviews: data.pendingReviews || [],
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
          products: Array.isArray(body.products) ? body.products : [],
          approvedReviews: Array.isArray(body.approvedReviews) ? body.approvedReviews : [],
          pendingReviews: Array.isArray(body.pendingReviews) ? body.pendingReviews : [],
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

        // Load live catalog from KV to verify prices & stock
        const raw = env.SHOP_DATA ? await env.SHOP_DATA.get("store_data") : null;
        const storeData = raw ? JSON.parse(raw) : { products: [] };
        const catalog = storeData.products || [];

        let subtotal = 0;
        const purchasedSummary = [];
        const zeroIdx = 0;
        const params = new URLSearchParams();
        params.append("mode", "payment");
        params.append("success_url", `${url.origin}/?success=true`);
        params.append("cancel_url", `${url.origin}/`);
        params.append(`shipping_address_collection[allowed_countries][${zeroIdx}]`, "US");

        for (let idx = 0; idx < items.length; idx++) {
          const item = items[idx];
          const qty = Number(item.qty || item.quantity || 1);
          const official = catalog.find(p => p.id === item.id || p.name === item.name);

          if (official && official.stock !== undefined) {
            const available = Number(official.stock);
            if (available <= 0) {
              return new Response(JSON.stringify({ error: `Sorry, "${official.name}" is sold out!` }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }
            if (qty > available) {
              return new Response(JSON.stringify({ error: `Only ${available} of "${official.name}" left in stock.` }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
              });
            }
          }

          const price = official ? Number(official.price) : Number(item.price);
          const name = official ? official.name : String(item.name);
          const id = official ? official.id : String(item.id || "");

          subtotal += price * qty;
          purchasedSummary.push({ id, name, qty });

          params.append(`line_items[${idx}][price_data][currency]`, "usd");
          params.append(`line_items[${idx}][price_data][product_data][name]`, name);
          params.append(`line_items[${idx}][price_data][unit_amount]`, String(Math.round(price * 100)));
          params.append(`line_items[${idx}][quantity]`, String(qty));
        }

        // Save purchased item IDs/quantities in Stripe metadata for automatic stock deduction
        params.append("metadata[purchased_items]", JSON.stringify(purchasedSummary));

        const shippingAmount = subtotal >= 50 ? 0 : 600;
        const shippingLabel = subtotal >= 50 ? "Free Standard Shipping ($50+ Order)" : "Standard USA Shipping";
        params.append(`shipping_options[${zeroIdx}][shipping_rate_data][type]`, "fixed_amount");
        params.append(`shipping_options[${zeroIdx}][shipping_rate_data][fixed_amount][amount]`, String(shippingAmount));
        params.append(`shipping_options[${zeroIdx}][shipping_rate_data][fixed_amount][currency]`, "usd");
        params.append(`shipping_options[${zeroIdx}][shipping_rate_data][display_name]`, shippingLabel);

        const stripeHost = atob("YXBpLnN0cmlwZS5jb20=");
        const stripeRes = await fetch(`https://${stripeHost}/v1/checkout/sessions`, {
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

    // 6. STRIPE WEBHOOK — AUTO-SUBTRACT STOCK AFTER PAYMENT (POST /api/webhook)
    if (url.pathname === "/api/webhook" && request.method === "POST") {
      try {
        const rawBody = await request.text();
        const sigHeader = request.headers.get("stripe-signature");

        if (env.STRIPE_WEBHOOK_SECRET) {
          const valid = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
          if (!valid) {
            return new Response("Invalid signature", { status: 400 });
          }
        }

        const event = JSON.parse(rawBody);
        if (event.type === "checkout.session.completed") {
          const session = event.data.object;
          const purchasedJson = session.metadata?.purchased_items;

          if (purchasedJson && env.SHOP_DATA) {
            const purchased = JSON.parse(purchasedJson);
            const raw = await env.SHOP_DATA.get("store_data");
            if (raw) {
              const storeData = JSON.parse(raw);
              if (Array.isArray(storeData.products)) {
                purchased.forEach(bought => {
                  const prod = storeData.products.find(p => p.id === bought.id || p.name === bought.name);
                  if (prod && prod.stock !== undefined) {
                    prod.stock = Math.max(0, Number(prod.stock) - Number(bought.qty || 1));
                  }
                });
                await env.SHOP_DATA.put("store_data", JSON.stringify(storeData));
              }
            }
          }
        }

        return new Response(JSON.stringify({ received: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // 7. SERVE STATIC SITE FILES
    return env.ASSETS.fetch(request);
  },
};
