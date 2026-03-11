// create-checkout.js
// Creates a Stripe Checkout session and returns the redirect URL.
// Called from the client as POST /api/create-checkout
// Env vars required: STRIPE_SECRET_KEY

const PRICE_CONFIG = {
  'price_1T8Z15JlYByErfPaTpRf3xic': { plan: 'league',     mode: 'payment',      months: 6  },
  'price_1T8Z4lJlYByErfPaulsRF7EZ': { plan: 'individual', mode: 'payment',      months: 6  },
  'price_1RV06yJIYByErfPa9kZDaCaR': { plan: 'referee',    mode: 'subscription', months: null },
};

const BASE_URL = 'https://www.myrefiq.com';

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY env var not set');
    return { statusCode: 500, body: JSON.stringify({ error: 'Stripe not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { priceId, userId, userEmail, successPath = '/admin', returnPath = '/admin' } = body;

  if (!priceId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'priceId is required' }) };
  }

  const config = PRICE_CONFIG[priceId];
  if (!config) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown price ID' }) };
  }

  // Build URL-encoded params for Stripe API
  const params = new URLSearchParams({
    mode:                       config.mode,
    'line_items[0][price]':     priceId,
    'line_items[0][quantity]':  '1',
    success_url:                `${BASE_URL}${successPath}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:                 `${BASE_URL}${returnPath}`,
    'metadata[userId]':         userId  || '',
    'metadata[plan]':           config.plan,
    'metadata[months]':         String(config.months || 0),
    allow_promotion_codes:      'true',
    // Billing address for compliance
    'billing_address_collection': 'auto',
  });

  if (userEmail) params.set('customer_email', userEmail);

  // For subscriptions, collect payment method upfront
  if (config.mode === 'subscription') {
    params.set('payment_method_collection', 'always');
  }

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${secretKey}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
      },
      body: params.toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Stripe API error:', JSON.stringify(data));
      return {
        statusCode: res.status,
        body: JSON.stringify({ error: data.error?.message || 'Stripe error' }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: data.url }),
    };
  } catch (err) {
    console.error('create-checkout error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
