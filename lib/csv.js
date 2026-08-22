const Papa = require('papaparse');

function findCol(fields, patterns) {
  for (const f of fields) {
    for (const p of patterns) {
      if (p.test(f)) return f;
    }
  }
  return null;
}

function normRole(r) {
  r = String(r || '').trim().toLowerCase();
  if (/^au/.test(r)) return 'au';
  if (/^ed/.test(r)) return 'ed';
  if (/^mc/.test(r)) return 'mc';
  return 'other';
}

// Collapses numbers so "add label as (8)" and "...(9)" hash the same way,
// so recurring instructions get classified once and cached.
function normText(t) {
  return String(t)
    .toLowerCase()
    .replace(/["'\u201c\u201d]/g, '')
    .replace(/\d+([.:]\d+)?/g, '#')
    .replace(/[^a-z#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function parseCsv(csvString) {
  const results = Papa.parse(csvString, { header: true, skipEmptyLines: true });
  const fields = results.meta.fields || [];
  const colJid = findCol(fields, [/^jid$/i, /journal/i]);
  const colAid = findCol(fields, [/^aid$/i, /article/i]);
  const colRole = findCol(fields, [/role/i]);
  const colCat = findCol(fields, [/categ/i]);
  const colText = findCol(fields, [/comment.*text/i, /^comment$/i, /^text$/i, /note/i]);

  if (!colRole || !colText) {
    return {
      error:
        'Could not find role and comment-text columns. Expected headers like jid, aid, role_code, category, comment_text.'
    };
  }

  const rows = results.data
    .map(r => ({
      jid: colJid ? String(r[colJid] || '').trim() : '',
      aid: colAid ? String(r[colAid] || '').trim() : '',
      role: normRole(r[colRole]),
      category: colCat ? String(r[colCat] || '').trim().toLowerCase() || 'uncategorized' : 'uncategorized',
      text: String(r[colText] || '').trim()
    }))
    .filter(r => r.text);

  return { rows };
}

// Groups near-duplicate comments (same role+category+normalized text) into
// one "pattern" with an occurrence count, so classification & caching work
// on patterns rather than raw rows.
function groupRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const nt = normText(r.text);
    if (!nt) continue;
    const key = r.role + '|' + r.category + '|' + djb2(nt);
    if (!map.has(key)) {
      map.set(key, {
        hashKey: key,
        role: r.role,
        category: r.category,
        text: r.text.slice(0, 2000),
        count: 0,
        articles: new Set()
      });
    }
    const g = map.get(key);
    g.count++;
    if (r.aid) g.articles.add(r.aid);
  }
  return Array.from(map.values()).map(g => ({ ...g, articleCount: g.articles.size, articles: undefined }));
}

module.exports = { parseCsv, groupRows, normRole, normText, djb2 };
