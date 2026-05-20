// api/import-map.js — AI column-mapping proxy for spreadsheet import
// Accepts: POST { headers: string[] }
// Returns: { mapping: { "Header": "fieldName"|null, ... } }
// Env var required: ANTHROPIC_API_KEY

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Anthropic API not configured' });

  const { headers } = req.body || {};
  if (!Array.isArray(headers) || !headers.length) {
    return res.status(400).json({ error: 'headers array is required' });
  }

  const prompt = `You are mapping spreadsheet column headers to game assignment fields.

Headers from the spreadsheet: ${JSON.stringify(headers)}

Map each header to the closest matching field from this list:
- date (game date)
- time (game time)
- homeTeam (home team name)
- awayTeam (away team or visiting team name)
- division (age group or division like U10, U12, rec-5th6th, etc)
- location (field name or address)
- notes (any additional notes or comments)

Rules:
- Every header must map to exactly one field from the list above, or null if it clearly doesn't match anything
- Return ONLY a valid JSON object like: {"Header Name": "fieldName", "Another Header": null}
- No explanation, no markdown, no code fences — just the raw JSON object`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':       'application/json',
        'x-api-key':          apiKey,
        'anthropic-version':  '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const data = await aiRes.json();
    if (!aiRes.ok) {
      return res.status(aiRes.status).json({ error: data.error?.message || 'AI error' });
    }

    const text = data.content?.[0]?.text?.trim() || '{}';
    let mapping;
    try {
      mapping = JSON.parse(text);
    } catch(_) {
      // Try to extract JSON from the response if model added any text around it
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      mapping = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    }

    return res.status(200).json({ mapping });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
