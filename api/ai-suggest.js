// api/ai-suggest.js
// POST { game: {homeTeam, awayTeam, division, date, time}, refs: [{name, cert, scores[], lastAt}] }
// Returns { suggestions: [{name, reason}] }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { game, refs } = body || {};
  if (!game || !refs) {
    return res.status(400).json({ error: 'Missing game or refs' });
  }

  // Build ref summary for prompt
  const refSummary = refs.slice(0, 20).map(r => {
    const avg = r.scores && r.scores.length
      ? Math.round(r.scores.reduce((s, v) => s + v, 0) / r.scores.length)
      : null;
    return `- ${r.name}: cert=${r.cert || 'unknown'}, avg_quiz=${avg != null ? avg + '%' : 'no quizzes'}, last_active=${r.lastAt || 'unknown'}`;
  }).join('\n');

  const prompt = `You are a referee assignment assistant. Given this game and referee pool, recommend the top 3 best-fit referees.

GAME:
${game.homeTeam || 'TBD'} vs ${game.awayTeam || 'TBD'}
Division: ${game.division || 'Unknown'}
Date: ${game.date || 'TBD'}, Time: ${game.time || 'TBD'}

REFEREE POOL:
${refSummary}

Rank by: 1) certification level match, 2) quiz performance, 3) recent activity.
Return ONLY a JSON array (no markdown, no explanation outside JSON) of exactly up to 3 objects:
[{"name": "Exact Name From Pool", "reason": "One sentence reason"}]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: 'AI API error: ' + err });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '[]';

    // Parse JSON — strip any markdown fences if present
    let suggestions = [];
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        suggestions = JSON.parse(jsonMatch[0]);
      } catch {
        suggestions = [];
      }
    }

    return res.status(200).json({ suggestions: Array.isArray(suggestions) ? suggestions.slice(0, 3) : [] });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
