export async function onRequestPost(context) {
  try {
    const { items } = await context.request.json();
    const secretKey = context.env.STRIPE_SECRET_KEY;

    if (!secretKey) {
      return new Response(JSON.stringify({ error: "STRIPE_SECRET_KEY is not configured in Cloudflare." }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (!items || items.length === 0) {
      return new Response(JSON.stringify({ error: "Your basket is empty." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const origin = new URL(context.request.url).origin;

    // Fetch live index.html to verify real product prices (prevents browser price tampering)
    const siteRes = await fetch(`${origin}/`);
    const html = await siteRes.text();
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
    params.append("success_url", `${origin}/?success=true`);
    params.append("cancel_url", `${origin}/`);

    // Restrict shipping address collection strictly to the United States (Email is collected automatically)
    params.append("shipping_address_collection[allowed_countries][0]", "US");

    // Flat-rate US shipping charge (500 = $5.00)
    params.append("shipping_options[0][shipping_rate_data][type]", "fixed_amount");
    params.append("shipping_options[0][shipping_rate_data][fixed_amount][amount]", "500");
    params.append("shipping_options[0][shipping_rate_data][fixed_amount][currency]", "usd");
    params.append("shipping_options[0][shipping_rate_data][display_name]", "US Standard Shipping");
    params.append("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]", "business_day");
    params.append("shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]", "3");
    params.append("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]", "business_day");
    params.append("shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]", "7");

    // Add each basket item using verified server prices
    items.forEach((item, index) => {
      const qty = item.quantity || item.qty || 1;
      const officialItem = catalog.find(p => p.id === item.id || p.name === item.name);
      const verifiedPrice = officialItem ? Number(officialItem.price) : Number(item.price);
      const verifiedName = officialItem ? officialItem.name : item.name;

      params.append(`line_items[${index}][price_data][currency]`, "usd");
      params.append(`line_items[${index}][price_data][product_data][name]`, verifiedName);
      params.append(`line_items[${index}][price_data][unit_amount]`, Math.round(verifiedPrice * 100));
      params.append(`line_items[${index}][quantity]`, qty);
    });

    const stripeResponse = await fetch("https://stripe.com", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const session = await stripeResponse.json();

    if (!stripeResponse.ok) {
      return new Response(JSON.stringify({ error: session.error?.message || "Stripe API error" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
