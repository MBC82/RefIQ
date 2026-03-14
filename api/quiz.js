// api/quiz.js — Anthropic API proxy for Vercel
// Env var required: ANTHROPIC_API_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid JSON.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: Math.min(body.max_tokens || 8000, 8000),
        system: (body.system || 'Return only valid JSON.') + ' Never create answer choices that are equivalent values in different units (e.g. 10 yards and 9.15 meters are the same distance — do not use both as separate options). Each answer choice must be clearly distinct and unambiguous. Only one answer should be correct and it must be unambiguously correct.',
        messages: body.messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data?.error?.message || JSON.stringify(data?.error) || `API error ${response.status}`;
      return res.status(response.status).json({ error: errMsg });
    }

    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
