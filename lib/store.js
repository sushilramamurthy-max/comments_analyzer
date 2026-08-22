// Simple JSON-file storage. Swap this module out for a real database later
// without touching server.js — every function here is the only thing that
// touches the filesystem.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const CACHE_FILE = path.join(DATA_DIR, 'classification-cache.json');
const BACKLOG_FILE = path.join(DATA_DIR, 'backlog-status.json');
const SNAPSHOTS_FILE = path.join(DATA_DIR, 'snapshots.json');

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error('Failed to read', file, e.message);
    return fallback;
  }
}

function writeJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

const CACHE_MAX_ENTRIES = 8000;

module.exports = {
  getCache() {
    return readJSON(CACHE_FILE, {});
  },
  saveCache(cache) {
    const keys = Object.keys(cache);
    if (keys.length > CACHE_MAX_ENTRIES) {
      keys.slice(0, keys.length - CACHE_MAX_ENTRIES).forEach(k => delete cache[k]);
    }
    writeJSON(CACHE_FILE, cache);
  },
  getBacklogStatus() {
    return readJSON(BACKLOG_FILE, {});
  },
  saveBacklogStatus(status) {
    writeJSON(BACKLOG_FILE, status);
  },
  getSnapshots() {
    return readJSON(SNAPSHOTS_FILE, []);
  },
  addSnapshot(snapshot) {
    const snapshots = readJSON(SNAPSHOTS_FILE, []);
    snapshots.push(snapshot);
    writeJSON(SNAPSHOTS_FILE, snapshots);
    return snapshots;
  },
  resetAll() {
    [CACHE_FILE, BACKLOG_FILE, SNAPSHOTS_FILE].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
  }
};
