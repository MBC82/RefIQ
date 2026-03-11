// api/create-checkout.js — Stripe Checkout session creator for Vercel
// Env var required: STRIPE_SECRET_KEY

const PRICE_CONFIG = {
  'price_1T8Z15JlYByErfPaTpRf3xic': { plan: 'league',     mode: 'payment',      months: 6  },
  'price_1T8Z4lJlYByErfPaulsRF7EZ': { plan: 'individual', mode: 'payment',      months: 6  },
  'price_1RV06yJIYByErfPa9kZDaCaR': { plan: 'referee',    mode: 'subscription', months: null },
};

const BASE_URL = 'https://www.myrefiq.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end('Method Not Allowed');
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY env var not set');
    return res.status(500).json({ error: 'Stripe not configured' });
  }

  const body = req.body;
  if (!body) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { priceId, userId, userEmail, successPath = '/admin', returnPath = '/admin' } = body;

  if (!priceId) {
    return res.status(400).json({ error: 'priceId is required' });
  }

  const config = PRICE_CONFIG[priceId];
  if (!config) {
    return res.status(400).json({ error: 'Unknown price ID' });
  }

  const params = new URLSearchParams({
    mode:                         config.mode,
    'line_items[0][price]':       priceId,
    'line_items[0][quantity]':    '1',
    success_url:                  `${BASE_URL}${successPath}?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:                   `${BASE_URL}${returnPath}`,
    'metadata[userId]':           userId  || '',
    'metadata[plan]':             config.plan,
    'metadata[months]':           String(config.months || 0),
    allow_promotion_codes:        'true',
    'billing_address_collection': 'auto',
  });

  if (userEmail) params.set('customer_email', userEmail);

  if (config.mode === 'subscription') {
    params.set('payment_method_collection', 'always');
  }

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${secretKey}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Stripe-Version': '2024-06-20',
      },
      body: params.toString(),
    });

    const data = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error('Stripe API error:', JSON.stringify(data));
      return res.status(stripeRes.status).json({ error: data.error?.message || 'Stripe error' });
    }

    return res.status(200).json({ url: data.url });
  } catch (err) {
    console.error('create-checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
