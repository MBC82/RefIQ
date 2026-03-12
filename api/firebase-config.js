// api/firebase-config.js — serves Firebase client config from Vercel env vars
// Set these in Vercel Dashboard → Project Settings → Environment Variables:
//   FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID,
//   FIREBASE_STORAGE_BUCKET, FIREBASE_MESSAGING_SENDER_ID, FIREBASE_APP_ID

export default function handler(req, res) {
  const config = {
    apiKey:            process.env.FIREBASE_API_KEY,
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
    projectId:         process.env.FIREBASE_PROJECT_ID,
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId:             process.env.FIREBASE_APP_ID,
  };

  // Guard: if env vars aren't set the values are undefined, which JSON strips,
  // leaving an empty object that causes Firebase initializeApp() to throw.
  if (!config.apiKey) {
    return res.status(500).json({
      error: 'Firebase env vars not configured. Add FIREBASE_API_KEY and the other FIREBASE_* variables in the Vercel project settings (Settings → Environment Variables).',
    });
  }

  res.setHeader('Cache-Control', 'public, max-age=3600');
  return res.status(200).json(config);
}
