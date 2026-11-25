export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle Stripe Checkout API requests
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

        // Fetch live index.html to verify real product prices
        const assetRes = await env.ASSETS.fetch(new Request(`${url.origin}/`));
        const html = await assetRes.text();
        const match = html.match(/const storeProducts\s*=\s*(\[[\s\S]*?\]);/);
        let catalog = [];
        if (match) {
          try {
            catalog = JSON.parse(match);
          } catch (e) {
            catalog = [];
          }
        }

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
        // Examples: $1.00 = 100 | $3.50 = 350 | $4.99 = 499 | Free = 0
        // ============================================================
        const THRESHOLD_CENTS = 3000;          // Spend $30.00+ for the cheaper rate
        const STANDARD_SHIPPING_CENTS = 100;   // $1.00 shipping if under $30.00
        const DISCOUNTED_SHIPPING_CENTS = 0;   // $0.00 (Free) shipping if $30.00 or more
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
