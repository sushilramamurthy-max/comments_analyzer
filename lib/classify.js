const BATCH_SIZE = 10;
const CLASSIFY_BUDGET = 300; // only applies in AI mode — keeps each upload's API cost/time bounded
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

// Real, specific rules so the app is genuinely useful with no API key —
// not just a placeholder waiting for AI. Patterns and actions here are
// grounded in a real comment export (a scholarly-publishing proof
// workflow); adjust freely for your own data. Checked top-to-bottom,
// first match wins.
const RULES = [
  {
    pattern: /section (no|number|numbering)|renumber/i,
    theme: 'Section renumbering', bucket: 'product', owner: 'engineering', severity: 5,
    action: 'Auto-renumber sections and their cross-references whenever a section is inserted, deleted, or reordered. This is usually the single largest source of manual mastercopier work.'
  },
  {
    pattern: /\btag as\b|xml tag|apply tag|break tag/i,
    theme: 'XML tagging', bucket: 'product', owner: 'engineering', severity: 5,
    action: "Let mastercopiers apply structural tags (section, paragraph, grant number, break) with a right-click or dropdown, instead of typing a comment for someone else to tag."
  },
  {
    pattern: /\breplac\w*\b.*\bfig|low resolution|vector.*(pdf|quality)|figure size|dimensions of fig/i,
    theme: 'Figure replacement', bucket: 'product', owner: 'design', severity: 4,
    action: 'Add a one-click "replace figure" upload that keeps the existing caption and numbering, so a low-res or outdated figure never needs a comment to swap.'
  },
  {
    pattern: /\bequation\b|\beq\.|label for the following eq/i,
    theme: 'Equation numbering', bucket: 'product', owner: 'engineering', severity: 4,
    action: 'Auto-number equations sequentially as they are added, removed, or reordered — the same way most editors already auto-number footnotes.'
  },
  {
    pattern: /hyperlink|\blink\b|supplementary/i,
    theme: 'Hyperlink / supplementary link', bucket: 'product', owner: 'engineering', severity: 4,
    action: 'Auto-link supplementary files the moment they are uploaded, so pointing text at them is never a separate manual instruction.'
  },
  {
    pattern: /reference (order|list)|renumber.*reference|new reference order/i,
    theme: 'Reference reordering', bucket: 'product', owner: 'engineering', severity: 3,
    action: 'Auto-reorder and renumber the reference list whenever citation order changes in the body text.'
  },
  {
    pattern: /\breference\b|\bcitation\b|volume number|page range/i,
    theme: 'Reference formatting', bucket: 'content', owner: 'none', severity: 0,
    action: 'n/a'
  },
  {
    pattern: /affiliation|author group/i,
    theme: 'Affiliation / author metadata', bucket: 'product', owner: 'design', severity: 3,
    action: 'Let authors and editors edit affiliations and author order directly in a metadata panel instead of describing the change in a comment.'
  },
  {
    pattern: /grant number|funding/i,
    theme: 'Grant number tagging', bucket: 'product', owner: 'engineering', severity: 3,
    action: 'Auto-detect and tag grant/funding numbers from the acknowledgments text — they are almost always already a clean, comma-separated list.'
  },
  {
    pattern: /keyword/i,
    theme: 'Keyword addition', bucket: 'content', owner: 'none', severity: 0,
    action: 'n/a'
  },
  {
    pattern: /typo|misspell|typographical/i,
    theme: 'Typo / text correction', bucket: 'content', owner: 'none', severity: 0,
    action: 'n/a'
  },
  {
    pattern: /\btable\b.*(align|format|indent|layout|cell|row)|indent this (row|cell)/i,
    theme: 'Table formatting', bucket: 'product', owner: 'design', severity: 3,
    action: 'Add indent, align, and merge controls directly to the table editor so formatting fixes never need to be described in words.'
  },
  {
    pattern: /placed within|place.*(figure|table)|position of fig/i,
    theme: 'Figure/table placement', bucket: 'product', owner: 'design', severity: 2,
    action: 'Add drag-and-drop placement for figures and tables so positioning is a direct action, not an instruction to someone else.'
  },
  {
    pattern: /article type|manuscript above the title/i,
    theme: 'Article type / front matter', bucket: 'product', owner: 'design', severity: 2,
    action: 'Expose article type and front-matter fields as editable metadata at the top of the workflow instead of a comment.'
  },
  {
    pattern: /bond line|chemical structure|chemdraw/i,
    theme: 'Chemistry figure styling', bucket: 'product', owner: 'design', severity: 2,
    action: 'Add line-weight and bond-style controls to the figure editor for chemical structures.'
  },
  {
    pattern: /caption|change label to/i,
    theme: 'Caption / label editing', bucket: 'product', owner: 'design', severity: 3,
    action: 'Make captions and figure/table labels directly editable inline, instead of requiring a comment to change them.'
  }
];

function heuristicClassify(items) {
  // No API key configured — this is what actually classifies every
  // comment. It's rule-based, not AI, so it will miss nuance an LLM
  // would catch, but every "product" rule below has a real, specific
  // action a product team can act on today.
  return items.map(it => {
    for (const r of RULES) {
      if (r.pattern.test(it.text)) {
        return { theme: r.theme, bucket: r.bucket, owner: r.owner, action: r.action, sentiment: 'neutral', severity: r.severity };
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
  try {
    return await classifyBatchViaApi(items);
  } catch (e) {
    console.error('Classification batch failed, marking unclassified:', e.message);
    return items.map(() => ({ theme: 'Unclassified', bucket: 'unclassified', owner: 'none', action: '', sentiment: 'neutral', severity: 0 }));
  }
}

// Classifies groups not already in `cache`, mutating `cache` in place.
// Without an API key, classification is free and instant, so every new
// pattern is classified — no budget, no long tail. With an API key, each
// upload is capped at CLASSIFY_BUDGET new patterns (highest-frequency
// first) to keep cost and latency bounded; anything past the cap is
// picked up on a later upload if it keeps recurring.
async function classifyNewGroups(groups, cache, onProgress) {
  const uncached = groups.filter(g => !cache[g.hashKey]);

  if (!API_KEY) {
    const results = heuristicClassify(uncached);
    uncached.forEach((g, i) => { cache[g.hashKey] = results[i]; });
    if (onProgress) onProgress(1, 1);
    return { classifiedCount: uncached.length, longTailCount: 0, usedApi: false };
  }

  uncached.sort((a, b) => b.count - a.count);
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

  return { classifiedCount: toClassify.length, longTailCount, usedApi: true };
}

module.exports = { classifyNewGroups, CLASSIFY_BUDGET, hasApiKey: () => !!API_KEY, MODEL };
