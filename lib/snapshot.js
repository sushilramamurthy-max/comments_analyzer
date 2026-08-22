const MC_CATEGORIES = ['xml', 'graphics', 'layout', 'text'];

function blankCategoryTotals() {
  const o = {};
  [...MC_CATEGORIES, 'uncategorized'].forEach(c => {
    o[c] = { count: 0, product: 0, content: 0, unclassified: 0 };
  });
  return o;
}

function buildSnapshot(groups, cache, filename, classifiedCount, longTailCount, usedApi) {
  const snap = {
    date: new Date().toISOString(),
    filename,
    used_api: usedApi,
    total: 0,
    role_counts: { au: 0, ed: 0, mc: 0, other: 0 },
    bucket_counts: { product: 0, content: 0, unclassified: 0 },
    owner_counts: { engineering: 0, design: 0, customer_success: 0, none: 0 },
    au_sentiment_counts: { positive: 0, neutral: 0, negative: 0 },
    theme_stats: {},
    mc_category_totals: blankCategoryTotals(),
    mc_category_themes: {}, // category -> theme -> {count, action, bucket, owner}
    classified_new: classifiedCount,
    long_tail: longTailCount
  };
  MC_CATEGORIES.concat('uncategorized').forEach(c => (snap.mc_category_themes[c] = {}));

  for (const g of groups) {
    const cls = cache[g.hashKey] || { theme: 'Unclassified', bucket: 'unclassified', owner: 'none', action: '', sentiment: 'neutral', severity: 0 };
    snap.total += g.count;
    snap.role_counts[g.role] = (snap.role_counts[g.role] || 0) + g.count;
    snap.bucket_counts[cls.bucket] = (snap.bucket_counts[cls.bucket] || 0) + g.count;
    snap.owner_counts[cls.owner] = (snap.owner_counts[cls.owner] || 0) + g.count;

    if (g.role === 'au' || g.role === 'ed') {
      snap.au_sentiment_counts[cls.sentiment] = (snap.au_sentiment_counts[cls.sentiment] || 0) + g.count;
    }

    const t = cls.theme || 'Unclassified';
    if (!snap.theme_stats[t]) {
      snap.theme_stats[t] = { count: 0, au: 0, ed: 0, mc: 0, other: 0, bucket: cls.bucket, owner: cls.owner, action: cls.action, sev_sum: 0, sev_n: 0 };
    }
    const ts = snap.theme_stats[t];
    ts.count += g.count;
    ts[g.role] = (ts[g.role] || 0) + g.count;
    if (cls.action && cls.action !== 'n/a') ts.action = cls.action;
    if (cls.severity) {
      ts.sev_sum += cls.severity * g.count;
      ts.sev_n += g.count;
    }

    if (g.role === 'mc') {
      const cat = MC_CATEGORIES.includes(g.category) ? g.category : 'uncategorized';
      const ct = snap.mc_category_totals[cat];
      ct.count += g.count;
      ct[cls.bucket] = (ct[cls.bucket] || 0) + g.count;

      const byTheme = snap.mc_category_themes[cat];
      if (!byTheme[t]) byTheme[t] = { count: 0, action: cls.action, bucket: cls.bucket, owner: cls.owner };
      byTheme[t].count += g.count;
      if (cls.action && cls.action !== 'n/a') byTheme[t].action = cls.action;
    }
  }

  return snap;
}

module.exports = { buildSnapshot, MC_CATEGORIES };
