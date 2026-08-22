# Comment Ledger

An insights engine for proof-comment CSV exports. Upload a comment export (daily,
weekly, or monthly), and it sorts every comment into **product** (the tool made
someone type an instruction it should have let them do themselves) or **content**
(a genuine editorial correction), assigns an owner (Engineering / Design /
Customer Success), and tracks the trend across every upload so you can tell
whether the count is actually going down.

Two dedicated views:

- **Author & Editor** — the feedback loop from comment → classification → owner
  → tracked fix, aimed at reducing friction earlier in the workflow.
- **Mastercopier** — a self-service scorecard broken out by the existing
  `xml` / `graphics` / `layout` / `text` categories. Layout is the only
  category expected to stay manual; the rest should trend to zero.

Plus a combined, filterable **Backlog** (status tracking per theme) and an
**Explorer** to browse the raw comments behind any number.

---

## 1. Run it locally

```bash
npm install
cp .env.example .env        # then edit .env and add your ANTHROPIC_API_KEY
npm start
```

Open **http://localhost:3000**. Without an `ANTHROPIC_API_KEY` set, the app
still runs — it falls back to a rough keyword-based classifier so you can
try the UI, but classification quality will be much lower than the live model.

## 2. How data is stored

Everything is written as JSON files under `DATA_DIR` (defaults to `./data`):

- `classification-cache.json` — every comment pattern ever classified, so
  re-uploads only pay for genuinely new patterns.
- `snapshots.json` — one entry per upload, used for the trend charts and backlog.
- `backlog-status.json` — the status you set per theme (New/Investigating/Planned/Shipped).

This is intentionally simple (no database to stand up). `lib/store.js` is the
only file that touches the filesystem — swap it for a real database later
without touching anything else.

**Important:** on most hosts, a plain filesystem write does **not** survive a
redeploy or container restart unless you attach a persistent disk. Render's
free tier doesn't support disks at all, so on free tier treat this app as
stateful *within* a running instance but not across deploys — fine for
trying it out and for uploads within the same day, but attach a disk (paid
tier — see the deploy section below) before relying on long-term history.

## 3. Push this to your own GitHub repo

This folder is already a git repository with an initial commit. To push it
to your own GitHub:

```bash
# create an empty repo on GitHub first (no README/license, so there's no conflict), then:
git remote add origin https://github.com/<your-username>/<your-repo>.git
git branch -M main
git push -u origin main
```

## 4. Deploy on Render

**Option A — Blueprint (recommended):** this repo includes `render.yaml`.
In the Render dashboard, choose **New → Blueprint**, point it at your GitHub
repo, and Render will create the web service from the file automatically.
You'll be prompted to fill in the `ANTHROPIC_API_KEY` secret (it's marked
`sync: false` in the blueprint so it's never committed to git). This deploys
on the **free** tier with no attached disk — see the note below on what
that means for history.

**Option B — Manual:**
1. **New → Web Service**, connect your GitHub repo.
2. Build command: `npm install`. Start command: `node server.js`.
3. Add an environment variable `ANTHROPIC_API_KEY` with your key
   (get one at https://console.anthropic.com).

**Keeping snapshot history across deploys (optional):** Render's free tier
does not support attached disks at all — trying to add one (including via
`render.yaml`) will fail to deploy, which is the error you'll hit if you
keep the `disk:` block from an earlier version of this file. To persist
history permanently: upgrade the service to a paid instance type in the
Render dashboard, then go to your service → **Disks** → **Add Disk**
(e.g. mount path `/var/data`), and set the `DATA_DIR` environment variable
to that same path. Until then, the app works fine but its snapshot history
resets on every redeploy or restart.

Once deployed, Render gives you a public `https://<your-service>.onrender.com`
URL — that's the live app.

## 5. Project structure

```
server.js              Express app + API routes
lib/csv.js              CSV parsing, column detection, comment grouping
lib/classify.js          Batched Claude classification (+ fallback mode)
lib/snapshot.js         Turns classified groups into a saved snapshot
lib/store.js             JSON-file persistence (swap for a real DB later)
public/                 Frontend (no build step — plain HTML/CSS/JS)
```

## 6. Notes & limits

- Classification is capped at 300 new comment patterns per upload to keep
  each upload fast. Anything beyond that is counted in the totals as
  "unclassified / long tail" and gets classified automatically on a later
  upload if it keeps recurring — the budget always spends on the
  highest-frequency unclassified patterns first.
- Comments are grouped by role + category + normalized text (numbers
  collapsed), so "add label as (8)" and "...(9)" are recognized as the same
  recurring instruction and classified once.
- The classifier is a language model — spot-check its calls in the Explorer
  tab, especially early on, and adjust the prompt in `lib/classify.js` if a
  theme or bucket looks consistently wrong.
