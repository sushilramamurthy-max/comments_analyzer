const express = require('express');
const multer = require('multer');
const path = require('path');

const store = require('./lib/store');
const { parseCsv, groupRows } = require('./lib/csv');
const { classifyNewGroups, hasApiKey, MODEL } = require('./lib/classify');
const { buildSnapshot } = require('./lib/snapshot');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---------- Initial app state (snapshots history, backlog statuses, config) ----------
app.get('/api/state', (req, res) => {
  const cache = store.getCache();
  res.json({
    snapshots: store.getSnapshots(),
    backlogStatus: store.getBacklogStatus(),
    latestGroups: store.getLatestGroups(),
    hasApiKey: hasApiKey(),
    model: MODEL,
    cachedPatterns: Object.keys(cache).length
  });
});

// ---------- Update a backlog item's status ----------
app.post('/api/backlog/:theme', (req, res) => {
  const theme = decodeURIComponent(req.params.theme);
  const { status } = req.body || {};
  if (!['New', 'Investigating', 'Planned', 'Shipped'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const backlogStatus = store.getBacklogStatus();
  backlogStatus[theme] = { status, updatedAt: new Date().toISOString() };
  store.saveBacklogStatus(backlogStatus);
  res.json({ ok: true });
});

// ---------- Reset everything (dev / demo convenience) ----------
app.post('/api/reset', (req, res) => {
  store.resetAll();
  res.json({ ok: true });
});

// ---------- Upload + classify, streamed as newline-delimited JSON ----------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no'
  });
  const send = obj => res.write(JSON.stringify(obj) + '\n');

  try {
    if (!req.file) {
      send({ type: 'error', message: 'No file uploaded.' });
      return res.end();
    }

    send({ type: 'status', message: 'Reading ' + req.file.originalname + '…' });
    const csvString = req.file.buffer.toString('utf8');
    const parsed = parseCsv(csvString);
    if (parsed.error) {
      send({ type: 'error', message: parsed.error });
      return res.end();
    }
    if (!parsed.rows.length) {
      send({ type: 'error', message: 'No comment rows found in that file.' });
      return res.end();
    }

    send({ type: 'status', message: 'Grouping ' + parsed.rows.length.toLocaleString() + ' comments into patterns…' });
    const groups = groupRows(parsed.rows);
    const cache = store.getCache();
    const newCount = groups.filter(g => !cache[g.hashKey]).length;

    if (newCount > 0) {
      send({ type: 'status', message: hasApiKey() ? 'Classifying new patterns with Claude…' : 'No API key set — classifying with built-in rules instead (instant, less nuanced than AI).' });
    } else {
      send({ type: 'status', message: 'Every pattern already classified from a previous upload — nothing new to send to the model.' });
    }

    const { classifiedCount, longTailCount, usedApi } = await classifyNewGroups(groups, cache, (batchNum, total) => {
      send({ type: 'progress', batch: batchNum, total });
    });

    store.saveCache(cache);

    send({ type: 'status', message: 'Saving snapshot…' });
    const snapshot = buildSnapshot(groups, cache, req.file.originalname, classifiedCount, longTailCount, usedApi);
    store.addSnapshot(snapshot);

    // Also return the classified groups so the client can populate the
    // per-upload explorer without a second request, and persist them so
    // the Explorer still works after a page refresh, not just this session.
    const explorerGroups = groups.map(g => ({
      role: g.role,
      category: g.category,
      text: g.text,
      count: g.count,
      articleCount: g.articles ? g.articles.size : 0,
      classification: cache[g.hashKey] || { theme: 'Unclassified', bucket: 'unclassified', owner: 'none', action: '', sentiment: 'neutral', severity: 0 }
    }));
    store.saveLatestGroups(explorerGroups);

    send({ type: 'done', snapshot, groups: explorerGroups });
    res.end();
  } catch (e) {
    console.error(e);
    send({ type: 'error', message: 'Unexpected error: ' + e.message });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Comment Ledger listening on :${PORT}`);
  console.log(hasApiKey() ? `Using Claude (${MODEL}) for classification.` : 'No ANTHROPIC_API_KEY set — running in fallback/demo classification mode.');
});
