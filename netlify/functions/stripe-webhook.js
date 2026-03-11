// stripe-webhook.js
// Handles Stripe webhook events and updates Firestore.
// Called by Stripe as POST to your webhook URL:
//   https://www.myrefiq.com/api/stripe-webhook
//
// Env vars required:
//   STRIPE_SECRET_KEY        — Stripe secret key
//   STRIPE_WEBHOOK_SECRET    — From Stripe Dashboard → Webhooks → Signing secret
//   FIREBASE_SERVICE_ACCOUNT — Full JSON of Firebase service account key file
//                              (Download from Firebase Console → Project Settings → Service Accounts)
//
// Events handled:
//   checkout.session.completed — activates the purchased plan in Firestore
//   customer.subscription.deleted — marks referee plan as expired

import { createHmac, timingSafeEqual, createSign } from 'crypto';

const FIREBASE_PROJECT_ID = 'refiq-b8142';

// ── Stripe signature verification ──────────────────────────────────────────
function verifyStripeSignature(rawBody, signatureHeader, secret) {
  let timestamp = null;
  const signatures = [];

  for (const part of signatureHeader.split(',')) {
    const eqIdx = part.indexOf('=');
    const key   = part.slice(0, eqIdx);
    const val   = part.slice(eqIdx + 1);
    if (key === 't')  timestamp = val;
    if (key === 'v1') signatures.push(val);
  }

  if (!timestamp || signatures.length === 0) {
    throw new Error('Malformed stripe-signature header');
  }

  // Reject requests older than 5 minutes (replay attack prevention)
  const ageSecs = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
  if (ageSecs > 300) {
    throw new Error(`Timestamp too old: ${ageSecs}s`);
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  const valid = signatures.some(sig => {
    try {
      const sigBuf = Buffer.from(sig, 'hex');
      return sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf);
    } catch { return false; }
  });

  if (!valid) throw new Error('No valid v1 signature found');
}

// ── Google Service Account → access token (zero npm deps) ──────────────────
async function getGoogleAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);

  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  })).toString('base64url');

  const message   = `${header}.${payload}`;
  const signer    = createSign('RSA-SHA256');
  signer.update(message);
  const signature = signer.sign(serviceAccount.private_key, 'base64url');
  const jwt       = `${message}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Google token exchange failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

// ── Firestore REST PATCH (merge / upsert) ───────────────────────────────────
function toFirestoreValue(v) {
  if (v instanceof Date)      return { timestampValue: v.toISOString() };
  if (typeof v === 'string')  return { stringValue: v };
  if (typeof v === 'number')  return { integerValue: String(v) };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (v === null)             return { nullValue: null };
  throw new Error(`Unsupported Firestore value type: ${typeof v}`);
}

async function firestorePatch(collection, docId, fields, token) {
  const fieldPaths = Object.keys(fields)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');

  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?${fieldPaths}`;

  const firestoreFields = {};
  for (const [k, v] of Object.entries(fields)) {
    firestoreFields[k] = toFirestoreValue(v);
  }

  const res = await fetch(url, {
    method:  'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ fields: firestoreFields }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firestore PATCH ${collection}/${docId} failed (${res.status}): ${text}`);
  }
}

// ── Main handler ────────────────────────────────────────────────────────────
export async function handler(event) {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripeSecret  = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const saRaw         = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!stripeSecret || !webhookSecret || !saRaw) {
    console.error('Missing required env vars: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / FIREBASE_SERVICE_ACCOUNT');
    return { statusCode: 500, body: 'Server misconfigured' };
  }

  const sig = event.headers['stripe-signature'];
  if (!sig) {
    return { statusCode: 400, body: 'Missing stripe-signature header' };
  }

  // Stripe requires the raw body for signature verification
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body || '');

  // Verify webhook signature
  try {
    verifyStripeSignature(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  console.log(`Received Stripe event: ${stripeEvent.type}`);

  // ── checkout.session.completed ──────────────────────────────────────────
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const { userId, plan, months } = session.metadata || {};

    if (!userId || !plan) {
      console.warn(`Session ${session.id} missing userId/plan metadata — skipping Firestore update`);
      return { statusCode: 200, body: 'OK' };
    }

    try {
      const sa    = JSON.parse(saRaw);
      const token = await getGoogleAccessToken(sa);

      const now       = new Date();
      const monthsNum = parseInt(months || '0', 10);

      let seasonEnd = null;
      if (monthsNum > 0) {
        seasonEnd = new Date(now);
        seasonEnd.setMonth(seasonEnd.getMonth() + monthsNum);
      }

      const fields = {
        plan,
        planPurchaseDate:  now,
        stripeCustomerId:  session.customer      || '',
        stripeSessionId:   session.id,
      };

      if (seasonEnd) {
        fields.seasonStart = now;
        fields.seasonEnd   = seasonEnd;
      }

      await firestorePatch('users', userId, fields, token);
      console.log(`✓ users/${userId} → plan=${plan}${seasonEnd ? `, seasonEnd=${seasonEnd.toISOString()}` : ''}`);
    } catch (err) {
      console.error('Firestore update failed:', err.message);
      return { statusCode: 500, body: 'Database update failed' };
    }
  }

  // ── customer.subscription.deleted (Referee plan cancellation) ────────────
  if (stripeEvent.type === 'customer.subscription.deleted') {
    const subscription = stripeEvent.data.object;
    // Fetch subscription metadata to get userId
    // (metadata set when creating checkout session carries over to subscription)
    const userId = subscription.metadata?.userId;

    if (userId) {
      try {
        const sa    = JSON.parse(saRaw);
        const token = await getGoogleAccessToken(sa);
        await firestorePatch('users', userId, { plan: 'expired' }, token);
        console.log(`✓ users/${userId} → plan=expired (subscription cancelled)`);
      } catch (err) {
        console.error('Subscription cancel Firestore update failed:', err.message);
        return { statusCode: 500, body: 'Database update failed' };
      }
    }
  }

  return { statusCode: 200, body: 'OK' };
}
