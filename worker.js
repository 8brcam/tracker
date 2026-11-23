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

        const params = new URLSearchParams();
        params.append("mode", "payment");
        params.append("shipping_address_collection[allowed_countries]", "US");
        params.append("success_url", `${url.origin}/?success=true`);
        params.append("cancel_url", `${url.origin}/?canceled=true`);

        items.forEach((item, index) => {
          params.append(`line_items[${index}][price_data][currency]`, "usd");
          params.append(`line_items[${index}][price_data][product_data][name]`, item.name);
          params.append(`line_items[${index}][price_data][unit_amount]`, Math.round(item.price * 100));
          params.append(`line_items[${index}][quantity]`, item.qty || 1);
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
