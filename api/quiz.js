// api/quiz.js — Anthropic API proxy for Vercel
// Env var required: ANTHROPIC_API_KEY (and FIREBASE_API_KEY, to check sign-ins)
// Callers: a signed-in person (Bearer token) or a referee opening a live shared quiz link (quizLinkId). Nobody else.
import { authorize, badQuizBody } from '../lib/guard.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const body = req.body;
  const bad = badQuizBody(body);
  if (bad) return res.status(400).json({ error: bad });

  const gate = await authorize(req, body, { allowQuizLink: true });
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: Math.min(body.max_tokens || 8000, 8000),
        system: (body.system || 'Return only valid JSON.') + (body.division ? ` Generate questions appropriate for ${body.division} referees — adjust complexity and scenario types accordingly. For youth recreational divisions, focus on common youth match situations.` : '') + ' Generate questions based on TWO sources in priority order: (1) any custom rule documents or league-specific rules provided in the request, which take precedence over everything else, and (2) the official IFAB Laws of the Game 2025/26. If a league rule contradicts IFAB, follow the league rule and generate questions accordingly. Never create answer choices that are equivalent values in different units (e.g. 10 yards and 9.15 meters are the same distance — do not use both as separate options). Each answer choice must be clearly distinct and unambiguous. Only one answer should be correct and it must be unambiguously correct.',
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
