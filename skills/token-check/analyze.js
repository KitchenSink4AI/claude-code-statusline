#!/usr/bin/env node
// token-check skill — analyze THIS window's context burn from its transcript plus
// the live status-line snapshot. Self-contained, read-only, safe anytime.
//
// Identifies THIS window's session via the CLAUDE_CODE_SESSION_ID env var (NOT the old
// "newest transcript" guess, which mis-fired across multiple open windows), reconstructs
// the full per-turn delta history, and reports usage, burn-rate, turns-of-headroom by task
// size, and the recent trend.
//
// Constants below mirror ~/.claude/statusline.js — keep in sync if those change.

const fs = require('fs');
const path = require('path');
const os = require('os');

const WALL_FRACTION = 0.97, WALL_CEILING = 970000; // mirrors statusline.js HARD_* (fallback if no snapshot)
const ATTACK = 0.55, RELEASE = 0.28;               // envelope follower (fast up, slow down)
const SIGMA_K = 1.0, SIGMA_WINDOW = 10;            // variance floor: rate = env + k*σ(last N deltas)
const FLAT_RATE_FLOOR = 1000;                       // mirrors statusline.js: flat/lean session (>=2 turns, no positive deltas)

function newestTranscript() {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let best = null, bestM = -1;
  try {
    for (const proj of fs.readdirSync(root)) {
      const pd = path.join(root, proj);
      let fl; try { fl = fs.readdirSync(pd); } catch { continue; }
      for (const f of fl) {
        if (!f.endsWith('.jsonl')) continue;
        let m; try { m = fs.statSync(path.join(pd, f)).mtimeMs; } catch { continue; }
        if (m > bestM) { bestM = m; best = { file: path.join(pd, f), sid: f.replace(/\.jsonl$/, '') }; }
      }
    }
  } catch { /* ignore */ }
  return best;
}

function currentTranscript() {
  // Authoritative: resolve THIS window's own session (env var set by Claude Code on Bash calls)
  // to its transcript file. The newest-mtime guess below mis-fires with multiple windows open
  // (it can grab another active window's transcript and report ITS burn as yours).
  const sid = (process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (sid) {
    const root = path.join(os.homedir(), '.claude', 'projects');
    try {
      for (const proj of fs.readdirSync(root)) {
        const fp = path.join(root, proj, sid + '.jsonl');
        if (fs.existsSync(fp)) return { file: fp, sid };
      }
    } catch { /* ignore */ }
  }
  return newestTranscript();    // fallback only when the env var is absent (older CLI).
}

function isRealPrompt(o) {
  if (o.isSidechain || o.isMeta) return false;
  const c = o.message && o.message.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return !c.some(b => b && b.type === 'tool_result');
  return false;
}

function parseDeltas(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let turn = 0;
  const totals = new Map();
  for (const l of lines) {
    if (!l.trim()) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.type === 'user') { if (isRealPrompt(o)) turn++; }
    else if (o.type === 'assistant' && o.message && o.message.usage) {
      const u = o.message.usage;
      const t = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
      if (t > (totals.get(turn) || 0)) totals.set(turn, t);
    }
  }
  const arr = [...totals.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  const deltas = [];
  for (let i = 1; i < arr.length; i++) { const d = arr[i] - arr[i - 1]; if (d > 0) deltas.push(d); }
  return { deltas, totals: arr };
}

function envelope(ds) {
  if (!ds.length) return 0;
  let e = ds[0];
  for (let i = 1; i < ds.length; i++) { const a = ds[i] > e ? ATTACK : RELEASE; e = a * ds[i] + (1 - a) * e; }
  const w = ds.slice(Math.max(0, ds.length - SIGMA_WINDOW));
  if (w.length >= 2) {
    const m = w.reduce((s, v) => s + v, 0) / w.length;
    const sigma = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / w.length);
    return e + SIGMA_K * sigma;
  }
  return e;
}

function readSnapshot(sid) {
  try {
    const dir = path.join(os.homedir(), '.claude', 'context-status');
    for (const fn of fs.readdirSync(dir)) {
      if (fn.replace(/\.json$/, '') === sid) return JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

const f = n => n == null ? '?' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'm' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : '' + Math.round(n);

// --- run ---
const sess = currentTranscript();
if (!sess) { console.log('No active session transcript found — cannot analyze burn.'); process.exit(0); }

const { deltas, totals } = parseDeltas(sess.file);
const snap = readSnapshot(sess.sid);

const wall = snap ? snap.wall : WALL_CEILING; // fallback assumes a 1M window
const ctx = snap ? snap.context_tokens : (totals[totals.length - 1] || 0);
// Rate: prefer the live snapshot (already carries statusline's flat-floor logic); else
// compute from deltas, and if a >=2-turn session has no positive deltas (flat/lean), fall
// back to FLAT_RATE_FLOOR instead of 0 — mirrors statusline.js so the rate never vanishes.
const rate = (snap && snap.rate) ? snap.rate
  : (deltas.length ? Math.round(envelope(deltas)) : (totals.length >= 2 ? FLAT_RATE_FLOOR : 0));
const free = Math.max(0, wall - ctx);
const pct = wall ? Math.floor(ctx * 100 / wall) : 0;
const turns = (snap && snap.turns_left != null) ? snap.turns_left : (rate > 0 ? Math.round(free / rate) : 0);
const status = snap ? snap.status : (pct >= 90 ? 'NEAR WALL' : pct >= 75 ? 'getting full' : 'OK');
// Turn 1 (no snapshot rate, <2 turns): a rate needs two turns to diff against — show "tbd".
const warming = rate === 0 && totals.length < 2;

console.log('=== CONTEXT BURN CHECK ===' + (snap ? '' : '  (no live snapshot — computed from transcript)'));
console.log(`Usage:   ${f(ctx)} / ${f(wall)} wall   (${pct}% used, ${f(free)} free)`);
if (warming) console.log('Rate:    tbd (needs 2 turns to compute a per-turn rate)');
else console.log(`Rate:    ${f(rate)}/turn (envelope)  ->  ~${turns} turns left at that rate`);
console.log(`Status:  ${status}`);
if (snap && snap.summary) {
  const adv = snap.summary.split('Status: ')[1];
  if (adv) console.log(`Advice:  ${adv.replace(/^[A-Z ]+\.\s*/, '')}`);
}

// --- memory save safety (stat-only; never loads file contents) ---
// Sizes memory files via fs.statSync (a filesystem stat, NOT a read), estimates tokens
// as bytes/4, and compares the largest to current free headroom. Output is ~3 lines, so
// the check is near-free even at the wall — the whole point is to never overflow a window
// just by measuring a file. Mirrors CLAUDE.md "Memory Saving".
(function memSafety() {
  const projDir = sess ? path.dirname(sess.file) : null;
  const memDir = projDir ? path.join(projDir, 'memory') : null;
  if (!memDir) return;
  let big = null;
  try {
    for (const fn of fs.readdirSync(memDir)) {
      if (!fn.endsWith('.md') || fn === 'MEMORY.md') continue;
      let st; try { st = fs.statSync(path.join(memDir, fn)); } catch { continue; }
      if (!st.isFile()) continue;
      const tok = Math.round(st.size / 4);            // bytes/4 estimate, NO content read
      if (!big || tok > big.tok) big = { fn, tok };
    }
  } catch { return; }
  if (!big) return;
  let v;
  if (big.tok > free) v = 'APPEND-ONLY: a full read of it would exceed free headroom and overflow. Never read it whole.';
  else if (big.tok > free * 0.5) v = 'APPEND-ONLY recommended: a full read would eat >half your headroom.';
  else v = 'OK: a full read or rewrite of even the largest memory file fits comfortably.';
  console.log(`\nMemory save safety: largest file ${big.fn} ~${f(big.tok)} tok vs ~${f(free)} free.`);
  console.log(`  ${v}`);
  console.log('  (sized via stat, not a read; never load a memory file just to measure it.)');
})();

const recent = deltas.slice(-15);
if (recent.length) {
  console.log(`\nPer-turn deltas (k), last ${recent.length} of ${deltas.length}  ([..] = heavy >=150k):`);
  console.log('  ' + recent.map(d => { const k = Math.round(d / 1000); return d >= 150000 ? `[${k}]` : '' + k; }).join(' '));
}

if (deltas.length) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const tt = c => c > 0 ? Math.round(free / c) : 0;
  console.log('\nHeadroom by task size (turns until the wall):');
  console.log(`  at current burn (~${f(rate)}/turn): ~${tt(rate)}`);
  console.log(`  typical turn    (~${f(median)}/turn): ~${tt(median)}`);
  console.log(`  small task      (~10k/turn): ~${tt(10000)}`);
}

if (deltas.length >= 4) {
  const a = deltas.slice(-4, -2), b = deltas.slice(-2);
  const am = a.reduce((x, y) => x + y, 0) / a.length, bm = b.reduce((x, y) => x + y, 0) / b.length;
  const dir = bm > am * 1.3 ? 'RISING (recent turns heavier — be deliberate before the next big task)'
            : bm < am * 0.7 ? 'falling (recent turns lighter)'
            : 'steady';
  console.log(`\nTrend:   per-turn cost ${dir}.`);
}

// --- prompt cache health (from snapshot) ---
if (snap && snap.cache_hit_pct != null) {
  const ttl = (snap.cache_ttl || 3600);
  const ttlLabel = ttl >= 3600 ? '1 hour' : '5 minutes';
  const ageMin = Math.floor((snap.cache_age_sec || 0) / 60);
  const ageSec = snap.cache_age_sec || 0;
  const ageFrac = ttl > 0 ? ageSec / ttl : 0;
  const expired = snap.cache_expired;

  console.log(`\n=== PROMPT CACHE ===`);
  console.log(`Hit rate:  ${snap.cache_hit_pct}% (last turn — higher = warm, lower = cold/expensive)`);
  console.log(`TTL:       ${ttlLabel} (detected from cache_creation breakdown)`);
  console.log(`Age:       ${ageMin}m since last API response (${Math.round(ageFrac * 100)}% of TTL elapsed)`);

  if (expired) {
    console.log(`\n*** CACHE EXPIRED ***`);
    console.log('The prompt cache has expired. The next API call will RE-CACHE the entire context');
    console.log('at 1.25-2x the normal input token cost. For a large context this can be significant.');
    console.log('This is why resuming an old conversation costs more — every cached token is re-written.');
  } else if (ageFrac >= 0.85) {
    console.log(`\n* CACHE EXPIRING (${Math.round((ttl - ageSec) / 60)}m remaining) — activity refreshes it, but a long pause will cause a cold re-cache. *`);
  }
}

// --- rate-limit awareness (from snapshot, refreshed every ~2.5 min via OAuth cache) ---
if (snap && snap.five_hour_pct != null) {
  const rl5 = snap.five_hour_pct;
  const rl7 = snap.seven_day_pct || 0;
  const rlStatus = snap.rate_limit_status || 'OK';
  const resetStr = snap.five_hour_resets_at ? new Date(snap.five_hour_resets_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '?';
  const model = (snap.model || '').toLowerCase();
  const isFable = model.includes('fable');
  const stopAgentPct = isFable ? 92 : 95;

  console.log(`\n=== RATE LIMITS ===`);
  console.log(`5hr:     ${rl5.toFixed(1)}%  ${rlStatus}  (resets ${resetStr})`);
  console.log(`weekly:  ${rl7.toFixed(1)}%`);

  if (rl5 >= 97) {
    console.log(`\n*** 5HR CRITICAL (${rl5.toFixed(1)}%) ***`);
    console.log('ACTION REQUIRED: save state and memory NOW. Do NOT launch agents or start large tasks.');
    console.log('Pause work and schedule resume for 5 minutes after the reset time above.');
  } else if (rl5 >= stopAgentPct) {
    console.log(`\n** 5HR WARNING (${rl5.toFixed(1)}% — agent-launch cutoff is ${stopAgentPct}% for ${isFable ? 'Fable' : 'this model'}) **`);
    console.log('STOP launching new agents. Finish current work only. Save state after each task.');
    console.log('Re-check before any further tool-heavy work.');
  } else if (rl5 >= 90) {
    console.log(`\n* 5HR CAUTION (${rl5.toFixed(1)}%) — approaching the ${stopAgentPct}% agent-launch cutoff *`);
    console.log('Be deliberate about new agent batches. Check here before each batch.');
  }

  if (rl7 >= 90) {
    console.log(`\n* WEEKLY CAUTION (${rl7.toFixed(1)}%) — weekly limit approaching. Pace your work. *`);
  }
}
