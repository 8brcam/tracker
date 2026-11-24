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

        // Fetch live index.html to verify real product prices
        const assetRes = await env.ASSETS.fetch(new Request(`${url.origin}/`));
        const html = await assetRes.text();
        const match = html.match(/const storeProducts\s*=\s*(\[[\s\S]*?\]);/);
        let catalog = [];
        if (match) {
          try {
            catalog = JSON.parse(match[1]);
          } catch (e) {
            catalog = [];
          }
        }

        const params = new URLSearchParams();
        params.append("mode", "payment");
        params.append("shipping_address_collection[allowed_countries][0]", "US");
        params.append("success_url", `${url.origin}/?success=true`);
        params.append("cancel_url", `${url.origin}/?canceled=true`);

        // Flat-rate US shipping charge (500 = $5.00)
        params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "500");
        params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
        params.append("shipping_options[0][shipping_rate_data][display_name]", "US Standard Shipping");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]", "business_day");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]", "3");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]", "business_day");
        params.append("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]", "7");

        items.forEach((item, index) => {
          const officialItem = catalog.find(p => p.id === item.id || p.name === item.name);
          const verifiedPrice = officialItem ? Number(officialItem.price) : Number(item.price);
          const verifiedName = officialItem ? officialItem.name : item.name;

          params.append(`line_items[${index}][price_data][currency]`, "usd");
          params.append(`line_items[${index}][price_data][product_data][name]`, verifiedName);
          params.append(`line_items[${index}][price_data][unit_amount]`, Math.round(verifiedPrice * 100));
          params.append(`line_items[${index}][quantity]`, item.qty || item.quantity || 1);
        });

        const response = await fetch("https://stripe.com", {
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
