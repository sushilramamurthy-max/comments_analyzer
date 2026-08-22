const BATCH_SIZE = 10;
const CLASSIFY_BUDGET = 300; // new patterns classified per upload, keeps each upload fast & bounded
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

const SYSTEM_PROMPT = `You triage comments left on manuscript proofs in a scholarly publishing production workflow. Comments come from three roles: "au" (author), "ed" (editor), and "mc" (mastercopier — production staff who finalize the file). Mastercopier comments are additionally tagged with a production category: xml, graphics, layout, or text.

For EACH comment in the numbered list, respond with ONLY a JSON array (no markdown fences, no prose before or after), one object per comment in the same order:

{"theme": "2-4 word category, reuse consistent labels across similar comments (e.g. 'Section renumbering', 'Figure replacement', 'Reference formatting', 'Keyword addition', 'XML tagging', 'Equation numbering')", "bucket": "product" or "content", "owner": "engineering" or "design" or "customer_success" or "none", "action": "one short, concrete sentence describing what to build or change so this comment stops being necessary, or 'n/a' if bucket is content", "severity": integer 1-5 for how much manual effort/friction this represents}

Bucket definitions:
- "product": this comment exists because the person can't do this themselves in the tool — a missing self-service action, formatting control, tagging automation, or in-app editor. The fix is something the product team could build.
- "content": a genuine correction to the manuscript's substance — wording, data, references, typos, missing keywords — that a human would always need to specify by hand regardless of tooling. Use this ONLY when no realistic product feature would remove the need for a human to type this.

Owner definitions (only set when bucket is "product"; otherwise use "none"):
- "engineering": the fix is backend logic, automation, or data processing (auto-numbering, auto-linking, auto-tagging, validation rules).
- "design": the fix is a new or improved interface — an editor, upload flow, drag-and-drop tool, inline control.
- "customer_success": the fix isn't a product build at all — it's better author/editor guidance, templates, or submission instructions that would prevent the comment in the first place.

Be decisive and consistent. Most comments are clearly one bucket or the other.`;

function heuristicClassify(items) {
  // Used only if no ANTHROPIC_API_KEY is configured, so the app still works
  // in a degraded "demo" mode. Much cruder than the AI classifier.
  const rules = [
    [/section (no|number|numbering)|renumber/i, 'Section renumbering', 'product', 'engineering'],
    [/\btag as\b|xml tag|apply tag/i, 'XML tagging', 'product', 'engineering'],
    [/\breplac\w*\b.*\bfig|low resolution|vector.*(pdf|quality)|figure size|dimensions of fig/i, 'Figure replacement', 'product', 'design'],
    [/\bequation\b|\beq\.|label for the following eq/i, 'Equation numbering', 'product', 'engineering'],
    [/hyperlink|\blink\b|supplementary/i, 'Hyperlink / supplementary link', 'product', 'engineering'],
    [/\breference\b|\bcitation\b|volume number|page range/i, 'Reference formatting', 'content', 'none'],
    [/affiliation|author group/i, 'Affiliation / author metadata', 'product', 'design'],
    [/grant number|funding/i, 'Grant number tagging', 'product', 'engineering'],
    [/keyword/i, 'Keyword addition', 'content', 'none'],
    [/typo|misspell|typographical/i, 'Typo / text correction', 'content', 'none'],
    [/\btable\b.*(align|format|indent|layout|cell|row)/i, 'Table formatting', 'product', 'design'],
    [/placed within|place.*(figure|table)|position of fig/i, 'Figure/table placement', 'content', 'none']
  ];
  return items.map(it => {
    for (const [pattern, theme, bucket, owner] of rules) {
      if (pattern.test(it.text)) {
        return { theme, bucket, owner, action: bucket === 'product' ? 'Reviewed automatically — verify with the AI classifier once an API key is configured.' : 'n/a', sentiment: 'neutral', severity: 3 };
      }
    }
    return { theme: 'Unclassified', bucket: 'unclassified', owner: 'none', action: '', sentiment: 'neutral', severity: 0 };
  });
}

async function classifyBatchViaApi(items) {
  const listStr = items
    .map((it, i) => `${i + 1}. [role=${it.role}${it.role === 'mc' ? ', category=' + it.category : ''}] ${it.text.slice(0, 300).replace(/\s+/g, ' ')}`)
    .join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: listStr }]
    })
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Anthropic API ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  const textBlocks = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const clean = textBlocks.replace(/```json|```/g, '').trim();
  const arr = JSON.parse(clean);
  if (!Array.isArray(arr) || arr.length !== items.length) throw new Error('shape mismatch');

  return arr.map(o => ({
    theme: (o.theme || 'Unclassified').toString().trim().slice(0, 40),
    bucket: ['product', 'content'].includes(o.bucket) ? o.bucket : 'unclassified',
    owner: ['engineering', 'design', 'customer_success'].includes(o.owner) ? o.owner : 'none',
    sentiment: ['positive', 'neutral', 'negative'].includes(o.sentiment) ? o.sentiment : 'neutral',
    action: (o.action || '').toString().trim().slice(0, 240),
    severity: Number.isFinite(+o.severity) ? Math.max(1, Math.min(5, Math.round(+o.severity))) : 3
  }));
}

async function classifyBatch(items) {
  if (!API_KEY) return heuristicClassify(items);
  try {
    return await classifyBatchViaApi(items);
  } catch (e) {
    console.error('Classification batch failed, marking unclassified:', e.message);
    return items.map(() => ({ theme: 'Unclassified', bucket: 'unclassified', owner: 'none', action: '', sentiment: 'neutral', severity: 0 }));
  }
}

// Classifies only groups not already in `cache`, up to CLASSIFY_BUDGET,
// mutating `cache` in place. Returns counts for the caller to report.
async function classifyNewGroups(groups, cache, onProgress) {
  const uncached = groups.filter(g => !cache[g.hashKey]).sort((a, b) => b.count - a.count);
  const toClassify = uncached.slice(0, CLASSIFY_BUDGET);
  const longTailCount = uncached.length - toClassify.length;
  const totalBatches = Math.ceil(toClassify.length / BATCH_SIZE);

  for (let i = 0; i < toClassify.length; i += BATCH_SIZE) {
    const batch = toClassify.slice(i, i + BATCH_SIZE);
    const results = await classifyBatch(batch);
    batch.forEach((g, idx) => {
      cache[g.hashKey] = results[idx];
    });
    if (onProgress) onProgress(Math.floor(i / BATCH_SIZE) + 1, totalBatches);
  }

  return { classifiedCount: toClassify.length, longTailCount, usedApi: !!API_KEY };
}

module.exports = { classifyNewGroups, CLASSIFY_BUDGET, hasApiKey: () => !!API_KEY, MODEL };
