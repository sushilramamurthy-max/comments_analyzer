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
    long_tail: longTailCount,
    // Rate-based KPIs — comparable across uploads regardless of batch size,
    // unlike raw counts. These are the two numbers that should trend down
    // as fixes ship.
    total_articles: 0,
    articles_with_product_comment: 0,
    pct_product: 0,
    pct_articles_with_product: 0
  };
  MC_CATEGORIES.concat('uncategorized').forEach(c => (snap.mc_category_themes[c] = {}));

  const allArticles = new Set();
  const productArticles = new Set();

  for (const g of groups) {
    const cls = cache[g.hashKey] || { theme: 'Unclassified', bucket: 'unclassified', owner: 'none', action: '', sentiment: 'neutral', severity: 0 };
    snap.total += g.count;
    snap.role_counts[g.role] = (snap.role_counts[g.role] || 0) + g.count;
    snap.bucket_counts[cls.bucket] = (snap.bucket_counts[cls.bucket] || 0) + g.count;
    snap.owner_counts[cls.owner] = (snap.owner_counts[cls.owner] || 0) + g.count;

    if (g.articles) {
      g.articles.forEach(aid => {
        allArticles.add(aid);
        if (cls.bucket === 'product') productArticles.add(aid);
      });
    }

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

  snap.total_articles = allArticles.size;
  snap.articles_with_product_comment = productArticles.size;
  snap.pct_product = snap.total ? Math.round(1000 * snap.bucket_counts.product / snap.total) / 10 : 0;
  snap.pct_articles_with_product = snap.total_articles ? Math.round(1000 * productArticles.size / snap.total_articles) / 10 : 0;

  return snap;
}

module.exports = { buildSnapshot, MC_CATEGORIES };
