#!/usr/bin/env node
// Claude Code statusline v3 — transcript-parsed delta tracking
// Line 1: Model | <ctxbar> used/total % | last: +Xk avg: Xk ~N turns | repo
// Line 2: current: <bar> % | weekly: <bar> % | extra: <bar> $/$
// Line 3: resets <time> | resets <datetime> | resets <date>

const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { execSync } = require('child_process');

// ANSI colors matching oh-my-posh theme
const C = {
  blue:   '\x1b[38;2;0;153;255m',
  orange: '\x1b[38;2;255;176;85m',
  green:  '\x1b[38;2;0;160;0m',
  cyan:   '\x1b[38;2;46;149;153m',
  red:    '\x1b[38;2;255;85;85m',
  yellow: '\x1b[38;2;230;200;0m',
  white:  '\x1b[38;2;220;220;220m',
  grey:   '\x1b[38;2;160;160;160m', // lighter than the dim SGR (which renders quite dark)
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  reset:  '\x1b[0m',
};

const sep = ` ${C.dim}|${C.reset} `;

// The full context window is never fully spendable, but the exact crash point is
// UNKNOWN — the user probes upward and has run reliably past 800k (839k, 870k) on
// a 1M window with no crash. Live data: a window ran safely to 920k (102% of the
// old 900k wall). With MCP servers replacing per-edit Python scripts, turns are
// LEANER, so real usage fills close to the true 1M input ceiling. So the wall now
// sits just below 1M, leaving ~30k for one final turn's growth (you literally
// cannot exceed 1M input tokens; the envelope turns-estimate handles big spikes
// dynamically; >wall still renders as an informative >100%). HARD_* is a MOVING
// estimate — bump it as safe runs go higher; if a real crash occurs, set CEILING
// to that count. Scales to smaller windows via the fraction; CEILING caps big.
//   1M   -> 970k wall          200k -> 194k wall
// 2026-06-22: a GENUINE engine auto-compaction was observed at preTokens=1,006,317
// (graceful, ~2.4min pause, no crash), so the real intervention point is ~1,006k. The wall
// was briefly set to 990k, but 2026-06-24 the user reverted to 970k — prefers the larger
// (~36k) buffer below auto-compact for comfort, even though pushing higher is technically safe.
// NOTE: the 1M window reports size=1,000,000, so barLimit=min(size*FRACTION, CEILING) — to
// move the wall, change BOTH together (CEILING = FRACTION*1,000,000), not just one.
const HARD_FRACTION = 0.97;
const HARD_CEILING = 970000;
// Alert tiers, as fractions of the wall — BACKUP indicators that fire before the
// crash point (the turns estimate is the primary signal, so these sit early).
// On a 1M window (~970k wall): CAUTION ~845k, WARNING ~895k, CRITICAL ~926k.
const CAUTION_FRACTION = 0.871;  // ~845k of the 970k wall
const WARNING_FRACTION = 0.923;  // ~895k of the 970k wall
const CRITICAL_FRACTION = 0.955; // ~926k of the 970k wall (~80k below the ~1,006k auto-compact)

// When a session is very flat/lean (MCP-era turns where context barely grows), the
// per-turn deltas can ALL net non-positive and get dropped by computeTurnDeltas' d>0
// filter — which used to hide the entire burn-rate block even with several turns.
// In that case fall back to this small nominal per-turn cost so the rate still shows
// (with a large, honest turns-left) instead of vanishing. Growing sessions never hit
// this path (they have positive deltas), so their tuned envelope estimate is untouched.
const FLAT_RATE_FLOOR = 1000;

// --- Helpers ---

function formatTokens(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'm';
  if (num >= 1_000) return Math.round(num / 1_000) + 'k';
  return String(Math.round(num)); // rate is a float; round so sub-1k never shows a long decimal
}

function buildBar(pct, width, frame = 0) {
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  const filled = Math.floor(pct * width / 100);
  const empty = width - filled;

  // <=60 green, 61-90 yellow, >90 flashing red/yellow (the filled dots alternate
  // each frame; pair with refreshInterval:1 so it flips ~1x/sec even when idle).
  let barColor;
  if (pct > 90) barColor = (frame % 2 === 0) ? C.red : C.yellow;
  else if (pct > 60) barColor = C.yellow;
  else barColor = C.green;

  return barColor + '\u25CF'.repeat(filled) + C.dim + '\u25CB'.repeat(empty) + C.reset;
}

function padColumn(text, visibleLen, colWidth) {
  const padding = colWidth - visibleLen;
  return padding > 0 ? text + ' '.repeat(padding) : text;
}

function currentFrame() {
  // Animation frame = whole seconds since the epoch. Time-based, NOT a persisted
  // counter: every window and every render computes the same value with no shared
  // state, so there is no cross-window race (an earlier file-counter version
  // stuttered because concurrent windows bumped it unevenly). Flips once per
  // second, matching the refreshInterval:1 idle cadence; even second = phase 0.
  return Math.floor(Date.now() / 1000);
}

function buildCritical(frame) {
  // Animated CRITICAL flag. Blink (SGR 5) was dropped: Windows Terminal renders
  // it as a subtle dim-flicker tied to the cursor blink rate (and off entirely
  // if cursor blink is disabled), so it does not grab attention. Instead:
  //   1. Reverse video (SGR 7) + bold -> a solid high-contrast color block,
  //      loud even when motionless. Reliably supported (Ink/Windows Terminal).
  //   2. Per-letter red<->yellow whose phase advances one step each refresh via
  //      nextFrame(). Paired with "refreshInterval": 1 in settings.json, the
  //      status line re-runs every second even when idle, so the colors visibly
  //      march/flash continuously instead of only during active work.
  const label = '⚠ CRITICAL';
  const colors = [C.red, C.orange, C.yellow]; // 3-step wave marches each frame
  let out = C.bold + '\x1b[7m'; // bold + reverse persist until reset
  let i = 0;
  for (const ch of label) {
    if (ch === ' ') { out += ' '; continue; }
    // (i - frame) scrolls the wave left-to-right; +len keeps the modulo positive
    out += colors[((i - frame) % colors.length + colors.length) % colors.length] + ch;
    i++;
  }
  return out + C.reset;
}

function formatResetTime(isoStr, style) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';

  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  const mm = String(m).padStart(2, '0');

  switch (style) {
    case 'time':
      return `${h12}:${mm}${ampm}`;
    case 'datetime':
      return `${months[d.getMonth()]} ${d.getDate()}, ${h12}:${mm}${ampm}`;
    default:
      return `${months[d.getMonth()]} ${d.getDate()}`;
  }
}

function getGitBranch(dir) {
  try {
    return execSync('git branch --show-current', {
      cwd: dir, timeout: 2000, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch { return ''; }
}

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function writeJsonFileAtomic(filePath, data) {
  // Write to a per-PID temp file then rename. Rename is atomic on NTFS, so an
  // interrupted write corrupts only the temp file while the original stays intact.
  // Per-PID temp path prevents 6+ concurrent windows from colliding on the same .tmp.
  const tmp = filePath + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

function getClaudeVersion() {
  try {
    return execSync('claude --version', {
      timeout: 2000, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim().replace(/^claude\s+/i, '');
  } catch { return '0.0.0'; }
}

function getOAuthToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  const creds = readJsonFile(credsPath);
  const token = creds?.claudeAiOauth?.accessToken;
  if (token && token !== 'null') return token;
  return '';
}

function fetchUsage(token) {
  return new Promise((resolve) => {
    const req = https.request('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `claude-code/${getClaudeVersion()}`,
      },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// --- Transcript-based turn analysis ---

function isRealUserPrompt(obj) {
  // A transcript "user" entry is either a typed human prompt or a tool_result
  // returned to the model. Tool results carry type:"user" too, so naively
  // counting them inflates the turn count (badly, under the tool-heavy CLI).
  // Only genuine prompts mark a new conversational turn.
  if (obj.isSidechain || obj.isMeta) return false;
  const content = obj.message?.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    return !content.some(b => b && b.type === 'tool_result');
  }
  return false;
}

function parseTranscriptTurns(transcriptPath) {
  // Returns { turns, processed, processedNew, cache }.
  //  - turns: per-turn PEAK context totals (peak usage at the END of each user turn),
  //    used for delta/turns-remaining math. Includes the model id so model switches
  //    can be detected and their anomalous deltas excluded from the burn-rate estimate.
  //  - processed: SUM of every assistant message's total tokens = total processed by
  //    the main thread this session (cache re-reads counted each turn, so it far
  //    exceeds the live window). Computed here in the same pass so the large main
  //    transcript is read only ONCE per refresh; feeds the session-burn tracker.
  //  - cache: { hitPct, lastTs, ttl } from the LAST assistant message with usage —
  //    hitPct = % of input served from cache (high=warm, low=cold),
  //    lastTs = unix-ms timestamp of that message (for cache-age computation),
  //    ttl = detected TTL in seconds (3600 for 1h, 300 for 5m) from the
  //    cache_creation sub-object's ephemeral_1h/5m breakdown.
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.split('\n');

    let userTurn = 0;
    let processed = 0;    // total metric (cache-inclusive)
    let processedNew = 0; // new-work metric (excludes cache re-reads)
    const turnTotals = new Map();  // userTurn -> { total, model }
    let lastModel = '';

    let lastCacheRead = 0;
    let lastCacheCreate = 0;
    let lastInput = 0;
    let lastTs = 0;
    let lastTtl = 3600;   // default 1h; overridden if the breakdown says 5m

    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      if (obj.type === 'user') {
        if (isRealUserPrompt(obj)) userTurn++;
      } else if (obj.type === 'assistant' && obj.message?.usage) {
        const u = obj.message.usage;
        const total = (u.input_tokens || 0)
          + (u.cache_creation_input_tokens || 0)
          + (u.cache_read_input_tokens || 0)
          + (u.output_tokens || 0);
        processed += total;
        processedNew += (u.input_tokens || 0)
          + (u.cache_creation_input_tokens || 0)
          + (u.output_tokens || 0);

        if (obj.message.model) lastModel = obj.message.model;
        const prev = turnTotals.get(userTurn);
        if (!prev || total > prev.total) {
          turnTotals.set(userTurn, { total, model: lastModel });
        }

        lastCacheRead = u.cache_read_input_tokens || 0;
        lastCacheCreate = u.cache_creation_input_tokens || 0;
        lastInput = u.input_tokens || 0;
        if (obj.timestamp) lastTs = new Date(obj.timestamp).getTime();

        const cc = u.cache_creation;
        if (cc) {
          const h1 = cc.ephemeral_1h_input_tokens || 0;
          const m5 = cc.ephemeral_5m_input_tokens || 0;
          if (h1 + m5 > 0) lastTtl = h1 >= m5 ? 3600 : 300;
        }
      }
    }

    const inputTotal = lastCacheRead + lastCacheCreate + lastInput;
    const hitPct = inputTotal > 0 ? Math.round(lastCacheRead * 100 / inputTotal) : 0;

    // Convert to sorted array
    const sorted = Array.from(turnTotals.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([turn, entry]) => ({ turn, total: entry.total, model: entry.model }));

    return {
      turns: sorted, processed, processedNew,
      cache: { hitPct, lastTs, ttl: lastTtl },
    };
  } catch {
    return { turns: [], processed: 0, processedNew: 0, cache: { hitPct: 0, lastTs: 0, ttl: 3600 } };
  }
}

function computeTurnDeltas(turnTotals) {
  // Compute the per-turn context growth (delta between consecutive turns).
  // Model switches (e.g. Opus→Fable) cause a massive context restructuring that
  // looks like a 100k+ delta but is not real per-turn burn. Excluding these prevents
  // the envelope follower from being poisoned for 10-20 turns after a switch.
  if (turnTotals.length < 2) return [];
  const deltas = [];
  for (let i = 1; i < turnTotals.length; i++) {
    const d = turnTotals[i].total - turnTotals[i - 1].total;
    if (d <= 0) continue;
    if (turnTotals[i].model && turnTotals[i - 1].model
        && turnTotals[i].model !== turnTotals[i - 1].model) continue;
    deltas.push(d);
  }
  return deltas;
}

function envelopeRate(deltas) {
  // Per-turn cost via an ENVELOPE FOLLOWER (peak meter) + VARIANCE FLOOR.
  // Envelope: rises fast (ATTACK), falls slow (RELEASE) — drops low-side outliers,
  // keeps heavy turns weighted, drifts with recency.
  // Sigma floor: adds k * σ(last SIGMA_WINDOW deltas) so that a session with
  // demonstrated spikes can't release the rate below the session's actual variance.
  // Without the floor, a string of lean turns after a heavy burst drops the rate to
  // ~7k and shows 16+ turns at 850k — misleadingly optimistic when the session has
  // proven it can spike to 165k. The floor keeps the rate honest about burstiness.
  // σ self-extinguishes during consistent lean endings (uniform deltas → σ→0), so
  // "0 turns" still coincides with the wall regardless of SIGMA_K.
  const n = deltas.length;
  if (n === 0) return 0;
  const ATTACK = 0.55;
  const RELEASE = 0.28;
  const SIGMA_K = 1.0;
  const SIGMA_WINDOW = 10;
  let env = deltas[0];
  for (let i = 1; i < n; i++) {
    const a = deltas[i] > env ? ATTACK : RELEASE;
    env = a * deltas[i] + (1 - a) * env;
  }
  const window = deltas.slice(Math.max(0, n - SIGMA_WINDOW));
  if (window.length >= 2) {
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    const sigma = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length);
    return env + SIGMA_K * sigma;
  }
  return env;
}

function logTokenSnapshot(snap) {
  // OPT-IN per-turn diagnostic logger. Completely inert unless the flag file
  // ~/.claude/statusline-tokenlog.on exists (touch to enable, rm to disable).
  // Appends ONE compact JSONL line per NEW user turn (deduped per session via a
  // tiny temp state file) — never per refresh, so it stays light. Rotates the log
  // once at ~1MB. Fully guarded: a logging failure must never affect the bar.
  try {
    const home = os.homedir();
    if (!fs.existsSync(path.join(home, '.claude', 'statusline-tokenlog.on'))) return;

    const stateDir = path.join(os.tmpdir(), 'claude');
    const stateFile = path.join(stateDir, 'statusline-tokenlog-state.json');
    const state = readJsonFile(stateFile) || {};
    // Log once per turn. Use !== (NOT >=) so a /compact or /clear — which makes the
    // turn count DROP — is seen as a new turn and logging RESUMES, instead of being
    // skipped forever because the old (higher) count is still stored. Append-only
    // log is independent of the transcript, so compacting the chat never loses it.
    if (state[snap.sid] === snap.tn) return; // already logged this exact turn

    const logFile = path.join(home, '.claude', 'statusline-tokenlog.jsonl');
    // Rotate at 5MB (~30k turns) so the diagnostic window never self-truncates; the
    // prior chunk is preserved as .prev. Pull/archive before a 2nd rotation if needed.
    try { if (fs.statSync(logFile).size > 5_000_000) fs.renameSync(logFile, logFile + '.prev'); } catch { /* no file yet */ }
    fs.appendFileSync(logFile, JSON.stringify(snap) + '\n');

    state[snap.sid] = snap.tn;
    try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* ignore */ }
  } catch { /* never throw */ }
}

function writeContextSnapshot(snap) {
  // Always-on tiny real-time snapshot of the computed context status, so the MODEL
  // can self-check its budget on demand (via context-status.js) instead of guessing.
  // One small file per session at ~/.claude/context-status/<session_id>.json,
  // overwritten each refresh (~1s fresh). Fully guarded: must never affect the bar.
  try {
    if (!snap.session_id) return;
    const dir = path.join(os.homedir(), '.claude', 'context-status');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, snap.session_id + '.json'), JSON.stringify(snap));
  } catch { /* never throw */ }
}

// --- Token metrics: two ways to count ---
// Every turn, the API re-reads the ENTIRE context from the prompt cache (cheap, but
// it still counts as tokens processed). So there are two honest numbers:
//   total  = input + cache_create + cache_read + output  — full throughput, counts
//            the context re-read each turn (the big, cache-inflated number). Drives
//            the lifetime "high score" and the line-3 per-session "compute" figure.
//   newTok = input + cache_create + output               — new work only, EXCLUDES
//            cache re-reads. Matches the CLI's per-agent number and your rate-limit
//            intuition. Drives the line-2 "session" figure (real work this session).
const LIFETIME_TTL = 120; // seconds between delta scans; raised from 15s to reduce concurrent-window write collisions

function sumTranscriptTokens(filePath) {
  // Sum BOTH metrics across all assistant usage entries in one transcript, so callers
  // pick without a second pass. Returns { total, newTok }.
  let total = 0, newTok = 0;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== 'assistant') continue;
      const u = obj.message?.usage;
      if (!u) continue;
      const inp = u.input_tokens || 0;
      const cc = u.cache_creation_input_tokens || 0;
      const cr = u.cache_read_input_tokens || 0;
      const out = u.output_tokens || 0;
      total += inp + cc + cr + out;
      newTok += inp + cc + out; // excludes cache re-reads
    }
  } catch { /* skip unreadable file */ }
  return { total, newTok };
}

// --- Lifetime token counter ---
// Two separate files, two separate concerns:
//   LIFETIME file (~30 bytes): the monotonic accumulator, only modified when real growth
//   is detected. Tiny = nearly atomic writes, extremely unlikely to corrupt.
//   TRACKING file (~91KB): per-file baselines (path → mtime/size/tokens + ts). Large,
//   written every cycle, corruption-prone with concurrent windows. If it corrupts, baselines
//   are rebuilt WITHOUT touching lifetime — growth during the corrupt cycle is lost (minor
//   under-count) but the accumulated total is never inflated or reset.
function computeLifetimeTokens() {
  const lifetimeFile = path.join(os.homedir(), '.claude', 'statusline-lifetime-sentinel.json');
  const trackingFile = path.join(os.homedir(), '.claude', 'statusline-lifetime-cache.json');
  try {
    const lifeData = readJsonFile(lifetimeFile) || { lifetime: 0 };
    const tracking = readJsonFile(trackingFile);
    const now = Math.floor(Date.now() / 1000);
    // Lifetime lives in the sentinel (primary) with a backup copy in the tracking
    // file. If either corrupts, the other preserves the value. Both corrupting
    // simultaneously requires two atomic-write failures in the same cycle.
    let lifetime = Math.max(lifeData.lifetime || 0, tracking?.lifetime || 0);

    const trackingValid = tracking && tracking.files && typeof tracking.ts === 'number';
    // Per-PID jitter (0-29s) spreads scan times across windows so 5 concurrent
    // windows don't all hit the TTL boundary in the same second and double-count.
    const jitter = process.pid % 30;
    if (trackingValid && (now - tracking.ts) < LIFETIME_TTL + jitter) return lifetime;

    const prevFiles = trackingValid ? tracking.files : {};
    const trackingWasRebuilt = !trackingValid;
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const files = {};
    let growth = 0;

    for (const proj of fs.readdirSync(projectsDir)) {
      const pdir = path.join(projectsDir, proj);
      let entries;
      try { entries = fs.readdirSync(pdir); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(pdir, f);
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        const prev = prevFiles[fp];
        if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
          files[fp] = prev;
          continue;
        }
        const tokens = sumTranscriptTokens(fp).total;
        if (!trackingWasRebuilt) {
          const delta = tokens - (prev?.tokens || 0);
          if (delta > 0) growth += delta;
        }
        files[fp] = { mtime: st.mtimeMs, size: st.size, tokens };
      }
      for (const sub of entries) {
        const subDir = path.join(pdir, sub, 'subagents');
        let agentFiles;
        try { agentFiles = fs.readdirSync(subDir); } catch { continue; }
        for (const af of agentFiles) {
          if (!af.endsWith('.jsonl')) continue;
          const fp = path.join(subDir, af);
          let st;
          try { st = fs.statSync(fp); } catch { continue; }
          const prev = prevFiles[fp];
          if (prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
            files[fp] = prev;
            continue;
          }
          const tokens = sumTranscriptTokens(fp).total;
          if (!trackingWasRebuilt) {
            const delta = tokens - (prev?.tokens || 0);
            if (delta > 0) growth += delta;
          }
          files[fp] = { mtime: st.mtimeMs, size: st.size, tokens };
        }
      }
    }
    // Compare-and-swap: re-read tracking to see if another window already wrote
    // updated baselines during our scan. If so, recompute deltas against the fresh
    // baselines — any growth the other window already counted shows as delta=0.
    if (growth > 0 && !trackingWasRebuilt) {
      const freshTracking = readJsonFile(trackingFile);
      if (freshTracking && freshTracking.ts > (tracking?.ts || 0)) {
        growth = 0;
        for (const [fp, entry] of Object.entries(files)) {
          const freshPrev = freshTracking.files?.[fp];
          const delta = entry.tokens - (freshPrev?.tokens || entry.tokens);
          if (delta > 0) growth += delta;
        }
      }
    }
    // Write tracking file with a BACKUP copy of lifetime (belt and suspenders)
    try { writeJsonFileAtomic(trackingFile, { files, ts: now, lifetime }); } catch {}
    // Only touch the sentinel when there's actual growth
    if (growth > 0) {
      const freshLife = readJsonFile(lifetimeFile) || lifeData;
      lifetime = Math.max(lifetime, freshLife.lifetime || 0) + growth;
      try { writeJsonFileAtomic(lifetimeFile, { lifetime }); } catch {}
      // Update the tracking backup too
      try { writeJsonFileAtomic(trackingFile, { files, ts: now, lifetime }); } catch {}
    }
    return lifetime;
  } catch {
    const l = readJsonFile(lifetimeFile);
    const t = readJsonFile(trackingFile);
    return Math.max(l?.lifetime || 0, t?.lifetime || 0);
  }
}

function formatLifetime(n) {
  // Full comma-grouped number for the "high score" feel (e.g. 1,234,567,890).
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// --- Session burn tracker (main thread + subagents) ---
// The context window only reflects the MAIN thread, so tokens burned by subagents
// are invisible there — running N agents that each chew through hundreds of k is
// wildly more consumption than the context bar shows. This tracks the true session
// burn by adding this session's subagent token usage to the main thread's.
//
// HEDGING (critical): everything is scoped to the DISPLAYED window's session id.
// Subagent transcripts live at <project>/<session_id>/subagents/agent-*.jsonl (the
// folder is named after the PARENT session, and each agent file's internal sessionId
// is the parent too), so we only ever sum THIS window's agents — another window's
// usage can never leak in. The main-thread portion is passed in from the single
// transcript parse (not re-read here). Only the agent files are read, incrementally.
function computeSessionAgents(transcriptPath, sid) {
  // Returns { agentsTotal, agentsNew, agentCount } for THIS session's subagents only.
  //   agentsTotal = cache-inclusive throughput (feeds line-3 "compute")
  //   agentsNew   = new work, excludes cache re-reads (feeds line-2 "session"; matches CLI)
  // Per-file incremental cache keyed by session id: unchanged agent transcripts are
  // never re-read (stat-only), so this stays cheap even while agents run. The cache
  // is namespaced per sid, so concurrent windows never clobber each other's totals.
  const cacheFile = path.join(os.homedir(), '.claude', 'statusline-sessionburn-cache.json');
  const out = { agentsTotal: 0, agentsNew: 0, agentCount: 0 };
  try {
    if (!transcriptPath || !sid) return out;
    const subDir = path.join(path.dirname(transcriptPath), sid, 'subagents');
    let entries;
    try { entries = fs.readdirSync(subDir); } catch { return out; } // no agents yet

    const allCache = readJsonFile(cacheFile) || {};
    const prev = allCache[sid]?.files || {};
    const files = {};
    let agentsTotal = 0, agentsNew = 0, agentCount = 0;
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const fp = path.join(subDir, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      const p = prev[fp];
      const rec = (p && p.mtime === st.mtimeMs && p.size === st.size && typeof p.total === 'number')
        ? { total: p.total, newTok: p.newTok || 0 }
        : sumTranscriptTokens(fp);
      files[fp] = { mtime: st.mtimeMs, size: st.size, total: rec.total, newTok: rec.newTok };
      agentsTotal += rec.total;
      agentsNew += rec.newTok;
      agentCount++;
    }
    const now = Math.floor(Date.now() / 1000);
    allCache[sid] = { files, agentsTotal, agentsNew, ts: now };
    // Prune sid entries not touched in 3 days so the cache can't grow without bound.
    for (const k of Object.keys(allCache)) {
      if (now - (allCache[k]?.ts || 0) > 3 * 86400) delete allCache[k];
    }
    try { writeJsonFileAtomic(cacheFile, allCache); } catch { /* ignore */ }
    out.agentsTotal = agentsTotal;
    out.agentsNew = agentsNew;
    out.agentCount = agentCount;
  } catch { /* return zeros */ }
  return out;
}

// --- Main ---

async function main() {
  let input;
  try { input = fs.readFileSync(0, 'utf8').trim(); }
  catch { process.stdout.write('Claude'); return; }

  if (!input) { process.stdout.write('Claude'); return; }

  let data;
  try { data = JSON.parse(input); }
  catch { process.stdout.write('Claude'); return; }

  // ===== Context data from stdin =====
  const modelName = data.model?.display_name || 'Claude';
  const size = data.context_window?.context_window_size || 200000;
  const inputTokens = data.context_window?.current_usage?.input_tokens || 0;
  const cacheCreate = data.context_window?.current_usage?.cache_creation_input_tokens || 0;
  const cacheRead = data.context_window?.current_usage?.cache_read_input_tokens || 0;
  const outputTokens = data.context_window?.current_usage?.output_tokens || 0;
  const current = inputTokens + cacheCreate + cacheRead + outputTokens;

  // Use total_input_tokens + total_output_tokens when available — these are the
  // backend's precise token counts (not rounded like used_percentage). Falls back
  // to the current_usage sum when those fields are absent.
  const totalIn = data.context_window?.total_input_tokens;
  const totalOut = data.context_window?.total_output_tokens;
  const hasTotals = typeof totalIn === 'number' && typeof totalOut === 'number';
  const effectiveCurrent = hasTotals ? (totalIn + totalOut) : current;

  // One animation frame (whole seconds), shared by every animated element
  // (flashing bars, CRITICAL) so they stay in sync and flip once per second.
  const frame = currentFrame();

  // The VISIBLE context bar now measures against the ACTUAL window size (e.g. 1.0m),
  // not the crash wall — the model name no longer prints "(1M Context)", so the bar
  // is where you read your true window limit. The burn tracker (turns-left + alerts)
  // still measures against barLimit (the wall) and is what warns you before it.
  const barLimit = Math.min(size * HARD_FRACTION, HARD_CEILING);


  // The bar shows true position in the FULL window (e.g. 966k/1m 96%). The popup's
  // higher % is Anthropic's built-in early warning against a usable ceiling — redundant
  // here because CAUTION/WARNING/CRITICAL + turns-left already do that job against the
  // wall. pctUsed (wall-based) still drives alerts, remaining, and the model self-check.
  const usedTokens = formatTokens(effectiveCurrent).replace(/\.0m$/, 'm');
  const totalTokens = formatTokens(size).replace(/\.0m$/, 'm');
  const winPct = size > 0 ? Math.round(effectiveCurrent * 100 / size) : 0;
  const pctUsed = barLimit > 0 ? Math.floor(effectiveCurrent * 100 / barLimit) : 0;

  // Shared column widths for the first two rate-limit columns, so the first separator
  // lines up on all three rows (line-1 model+effort prefix, line-2 5hr bar, line-3 5hr
  // reset) and the second lines up (weekly / weekly-reset). Computed DYNAMICALLY in the
  // usageData block below = the MAX width of each column's rows THIS render, so the
  // longest row (usually the bar) hugs its separator with just the sep's single space
  // and nothing is over-padded. 0 until computed (no-usage case then pads nothing).
  let COL1_W = 0;
  let COL2_W = 0;

  // Project dir & working folder
  const projectDir = data.workspace?.project_dir || data.cwd || '';
  const currentDir = data.workspace?.current_dir || data.cwd || '';
  const repoName = projectDir ? path.basename(projectDir) : '';
  const workDir = (projectDir && currentDir && currentDir.startsWith(projectDir))
    ? currentDir.slice(projectDir.length + 1) || '.'
    : currentDir ? path.basename(currentDir) : '';

  // ===== Transcript-based delta analysis =====
  const transcriptPath = data.transcript_path || '';
  // Runway counts down to the hard wall: "turns until the crash point".
  const remaining = barLimit - effectiveCurrent;

  let lastDelta = 0;
  let rate = 0;
  let turnsLeft = 0;
  let turnCount = 0;
  let ctxT = 0;
  let hasData = false;
  let mainProcessed = 0; // main thread, total metric (cache-inclusive)
  let mainNew = 0;       // main thread, new-work metric (excludes cache re-reads)
  let cacheHitPct = 0;   // last turn's cache hit rate (0-100)
  let cacheAgeSec = 0;   // seconds since the last API response
  let cacheTtl = 3600;   // detected TTL (3600=1h, 300=5m)

  if (transcriptPath) {
    const parsed = parseTranscriptTurns(transcriptPath);
    const turnTotals = parsed.turns;
    mainProcessed = parsed.processed;
    mainNew = parsed.processedNew;

    if (parsed.cache) {
      cacheHitPct = parsed.cache.hitPct;
      cacheTtl = parsed.cache.ttl;
      if (parsed.cache.lastTs > 0) {
        cacheAgeSec = Math.max(0, Math.floor((Date.now() - parsed.cache.lastTs) / 1000));
      }
    }
    turnCount = turnTotals.length;

    if (turnTotals.length >= 2) {
      const deltas = computeTurnDeltas(turnTotals);
      ctxT = turnTotals.reduce((m, t) => Math.max(m, t.total), 0); // transcript-accurate context peak
      if (deltas.length > 0) {
        hasData = true;
        lastDelta = deltas[deltas.length - 1];
        rate = envelopeRate(deltas); // envelope-follower per-turn cost (the "rate")
        turnsLeft = (remaining > 0 && rate > 0) ? Math.round(remaining / rate) : 0;
      } else {
        // FLAT/LEAN session: >=2 turns but no positive growth between them (small cache
        // fluctuations netted non-positive and were all filtered). Context isn't really
        // growing, so show a small honest rate + large turns-left rather than hide the
        // whole block. Never triggers for a growing session (it has positive deltas).
        hasData = true;
        lastDelta = Math.max(0, turnTotals[turnTotals.length - 1].total - turnTotals[turnTotals.length - 2].total);
        rate = FLAT_RATE_FLOOR;
        turnsLeft = (remaining > 0) ? Math.round(remaining / rate) : 0;
      }
    }
  }

  // Session token counters, scoped to the displayed window's session id (main thread
  // + this session's subagents; no other window can leak in):
  //   sessionNew     = new work (excludes cache re-reads) -> line 2 "session", matches CLI
  //   sessionCompute = full throughput (incl. cache re-reads) -> line 3 "compute"
  const sessionAgents = computeSessionAgents(transcriptPath, data.session_id || '');
  const sessionNew = mainNew + sessionAgents.agentsNew;
  const sessionCompute = mainProcessed + sessionAgents.agentsTotal;

  // Opt-in per-turn diagnostic logging (no-op unless ~/.claude/statusline-tokenlog.on exists).
  if (hasData) {
    logTokenSnapshot({
      ts: Math.floor(Date.now() / 1000),
      sid: (data.session_id || 'unknown').slice(-12),
      m: modelName,
      tn: turnCount,
      ctx: current,   // stdin current_usage sum (raw diagnostic)
      ctxE: effectiveCurrent, // effective (from total_input+total_output when available)
      ctxT: ctxT,     // transcript peak total (per-turn-accurate; use this for delta reconstruction)
      d: lastDelta,
      r: rate,
      L: turnsLeft,
      w: barLimit,
    });
  }

  // Effort level (reasoning effort) from stdin, shown as a GREY parenthetical after
  // the model name (e.g. "Opus 4.8 (high)"). The word alone (medium/high/max) conveys
  // the level and changes when it does, so no "effort:" label and no color coding.
  // Empty when the field is absent.
  let effortStr = '';
  const effortLevel = data.effort?.level;
  if (effortLevel) {
    effortStr = `${C.grey}(${String(effortLevel).toLowerCase()})${C.reset}`;
  }

  // Strip any trailing parenthetical from the model name (e.g. "Opus 4.8 (1M Context)")
  // — the window size is already shown by the context bar, so it's duplicative; the
  // grey effort parenthetical takes its place.
  const modelClean = modelName.replace(/\s*\([^)]*\)\s*$/, '');

  // ===== LINE 1: Model (effort) | context bar | delta info | repo =====
  // Build the model+effort prefix now (its width feeds COL1_W), but PREPEND it padded
  // only after the usageData block computes COL1_W, so "| context" lines up with the
  // first separators on lines 2 & 3. line1 starts at the context field for now.
  let prefix = `${C.blue}${modelClean}${C.reset}`;
  let prefixVis = modelClean.length;
  if (effortStr) {
    prefix += ` ${effortStr}`;
    prefixVis += 1 + String(effortLevel).toLowerCase().length + 2; // " (lvl)"
  }
  let line1 = `${C.white}context:${C.reset} ${buildBar(winPct, 10, frame)} ${C.orange}${usedTokens}/${totalTokens}${C.reset} ${C.cyan}${winPct}%${C.reset}`;

  // Current turn number (informational). turnCount = distinct real user turns seen with
  // assistant usage, so it includes the in-flight turn once it has produced any output —
  // it reads as "you are on turn N". Shown once the session has at least one turn.
  if (turnCount > 0) {
    line1 += `${sep}${C.white}turn:${C.reset} ${C.cyan}${turnCount}${C.reset}`;
  }

  // Cache health: hit rate on the last turn + staleness relative to detected TTL.
  // hitPct tells you how warm the cache is RIGHT NOW (95%=warm, <10%=cold start).
  // Cache age vs TTL tells you whether the NEXT turn will pay a re-cache penalty.
  if (turnCount > 0 && cacheAgeSec >= 0) {
    const ttlLabel = cacheTtl >= 3600 ? '1h' : '5m';
    const ageFrac = cacheTtl > 0 ? cacheAgeSec / cacheTtl : 0;

    if (ageFrac >= 1.0) {
      // Cache expired — don't show a meaningless age counter (could be days old).
      // Just show "COLD" in flashing red/yellow so it's immediately obvious.
      const flashColor = (frame % 2 === 0) ? C.red : C.yellow;
      line1 += `${sep}${C.white}cache:${C.reset} ${flashColor}COLD${C.reset}`;
    } else {
      const ageMin = Math.floor(cacheAgeSec / 60);
      let cacheColor = C.green;
      let cacheWarn = '';
      if (ageFrac >= 0.85) {
        cacheColor = C.red;
        cacheWarn = ` ${C.yellow}expiring${C.reset}`;
      } else if (ageFrac >= 0.67) {
        cacheColor = C.yellow;
      }

      // Cache hit rate color: >=80% green (good discount), 40-79% yellow (partial),
      // <40% flashing red/yellow (you're paying near full price — same flash as >90% bars).
      let hitStr;
      if (cacheHitPct < 40) {
        const flashColor = (frame % 2 === 0) ? C.red : C.yellow;
        hitStr = `${flashColor}${cacheHitPct}%${C.reset}`;
      } else {
        const hitColor = cacheHitPct >= 80 ? C.green : C.yellow;
        hitStr = `${hitColor}${cacheHitPct}%${C.reset}`;
      }
      line1 += `${sep}${C.white}cache:${C.reset} ${hitStr} ${cacheColor}${ageMin}m/${ttlLabel}${C.reset}${cacheWarn}`;
    }
  }

  // ===== Alert level = more severe of two signals =====
  // Token tiers: absolute position toward the hard wall (the lines the user set,
  // ~700k/740k/775k on 1M). Turns tiers: anti-blowout protection \u2014 if the burn
  // rate leaves few turns of headroom, escalate early even below the token lines
  // (this feature exists because a single oversized prompt once blew a session).
  let tokenLevel = 0;
  if (effectiveCurrent >= barLimit * CRITICAL_FRACTION) tokenLevel = 3;
  else if (effectiveCurrent >= barLimit * WARNING_FRACTION) tokenLevel = 2;
  else if (effectiveCurrent >= barLimit * CAUTION_FRACTION) tokenLevel = 1;

  let turnsLevel = 0;
  if (hasData) {
    if (turnsLeft <= 1) turnsLevel = 3;
    else if (turnsLeft <= 3) turnsLevel = 2;
    else if (turnsLeft <= 7) turnsLevel = 1;
  }
  const alertLevel = Math.max(tokenLevel, turnsLevel);
  // Shared by the turns count and the alert badge so they always agree.
  const levelColor = [C.green, C.yellow, C.red, C.bold + C.red][alertLevel];

  if (hasData) {
    line1 += sep;

    // Color delta by how much of remaining context it consumed
    let deltaColor = C.green;
    if (lastDelta > remaining * 0.5) deltaColor = C.red;
    else if (lastDelta > remaining * 0.25) deltaColor = C.yellow;
    else if (lastDelta > remaining * 0.1) deltaColor = C.orange;

    line1 += `${C.white}last:${C.reset} ${deltaColor}+${formatTokens(lastDelta)}${C.reset}`;
    line1 += `${sep}${C.white}rate:${C.reset} ${C.cyan}${formatTokens(rate)}${C.reset}`;

    const turnWord = turnsLeft === 1 ? 'turn' : 'turns';
    line1 += ` ${C.white}~${C.reset}${levelColor}${turnsLeft} ${turnWord} left${C.reset}`;
  } else if (transcriptPath) {
    // Turn 1: a rate needs two turns to diff against, so it cannot exist yet. Show a
    // short placeholder so a fresh/warming-up window doesn't read as broken. Cyan to
    // match the real rate value it stands in for (grey vs cyan is hard for the user to
    // tell apart, so keep this field's placeholder and value the same color).
    line1 += `${sep}${C.white}rate:${C.reset} ${C.cyan}tbd${C.reset}`;
  }

  // Alert badge \u2014 token thresholds apply even without turn data.
  //   1 caution (\u203C, heads-up)   2 warning (\u26A0)   3 critical (\u26A0, animated)
  if (alertLevel === 3) {
    line1 += ` ${buildCritical(frame)}`;
  } else if (alertLevel === 2) {
    line1 += ` ${C.red}\u26A0 WARNING${C.reset}`;
  } else if (alertLevel === 1) {
    line1 += ` ${C.yellow}\u203C CAUTION${C.reset}`;
  }

  // Real-time context snapshot for the MODEL to self-check (read via context-status.js).
  {
    const statusName = ['OK', 'CAUTION', 'WARNING', 'CRITICAL'][alertLevel] || 'OK';
    const pctRemain = Math.max(0, 100 - pctUsed);
    const tokensFree = Math.max(0, barLimit - effectiveCurrent);
    const nearWall = pctUsed >= 90; // genuinely close to the ceiling
    const turnStr = hasData ? `~${turnsLeft} turn(s) at current burn (~${formatTokens(rate)}/turn)` : 'turn estimate pending';
    // The alert level can be driven by BURN RATE (turns) even when lots of absolute
    // context is still free. Distinguish "actually near the wall" (stop large work,
    // save state) from "high burn but roomy" (keep doing SMALL tasks, just save
    // memory after each). Do NOT halt small tasks on a burn-rate flag alone.
    let advice;
    if (alertLevel === 0) {
      advice = 'No context concern. Proceed normally; do not ration or rush on account of context.';
    } else if (nearWall) {
      advice = `NEAR THE WALL (${pctUsed}% used, only ${formatTokens(tokensFree)} free). Update memory / save state now and stop taking LARGE turns — the next big one may not fit. Small wrap-up tasks are still OK.`;
    } else {
      advice = `This ${statusName} reflects BURN RATE, not crowding: ${formatTokens(tokensFree)} (${pctRemain}%) is still free. Even at ${statusName}, keep doing SMALL / non-critical tasks — do NOT halt on them just because turns-left shows 0-1. Rules: update memory after EVERY task (so an overflow costs nothing), and re-check here before any LARGE task (a few big tasks back-to-back are what would overflow).`;
    }
    // Build snapshot object now; the write is DEFERRED to after usageData is fetched
    // so rate-limit fields can be included in the same snapshot.
    const cacheTtlLabel = cacheTtl >= 3600 ? '1h' : '5m';
    const cacheAgeFrac = cacheTtl > 0 ? cacheAgeSec / cacheTtl : 0;
    const cacheSummary = turnCount > 0
      ? `Cache: ${cacheHitPct}% hit rate on last turn, age ${Math.floor(cacheAgeSec/60)}m of ${cacheTtlLabel} TTL${cacheAgeFrac >= 1.0 ? ' — EXPIRED, next turn will re-cache the full context at write cost' : cacheAgeFrac >= 0.85 ? ' — expiring soon, activity will refresh it' : ''}.`
      : '';
    var ctxSnap = {
      ts: frame,
      session_id: data.session_id || '',
      model: modelName,
      context_tokens: effectiveCurrent,
      wall: barLimit,
      pct: pctUsed,
      pct_remaining: pctRemain,
      tokens_free: tokensFree,
      near_wall: nearWall,
      turns_left: hasData ? turnsLeft : null,
      rate: hasData ? Math.round(rate) : null,
      status: statusName,
      cache_hit_pct: cacheHitPct,
      cache_age_sec: cacheAgeSec,
      cache_ttl: cacheTtl,
      cache_expired: cacheAgeFrac >= 1.0,
      summary: `Context ${formatTokens(current)} / ${formatTokens(barLimit)} usable (${pctUsed}% used, ${pctRemain}% free). ${turnStr}. Status: ${statusName}. ${advice}${cacheSummary ? ' ' + cacheSummary : ''}`,
    };
  }

  if (repoName) {
    line1 += sep;
    line1 += `${C.blue}${repoName}${C.reset}`;
    const branch = getGitBranch(projectDir);
    if (branch) line1 += `  ${C.cyan}\uE0A0 ${branch}${C.reset}`;
    if (workDir && workDir !== '.') line1 += ` ${C.green}${workDir}${C.reset}`;
  }

  // ===== LINES 2 & 3: Rate limit usage =====
  let line2 = '';
  let line3 = '';

  const cacheDir = path.join(os.tmpdir(), 'claude');
  const cacheFile = path.join(cacheDir, 'statusline-usage-cache.json');
  const cacheMaxAge = 60;

  let usageData = null;
  let needsRefresh = true;

  try {
    const stat = fs.statSync(cacheFile);
    if ((Date.now() - stat.mtimeMs) / 1000 < cacheMaxAge) {
      needsRefresh = false;
      usageData = readJsonFile(cacheFile);
    }
  } catch { /* no cache yet */ }

  if (needsRefresh) {
    const token = getOAuthToken();
    if (token) {
      const response = await fetchUsage(token);
      if (response && !response.error) {
        usageData = response;
        try {
          fs.mkdirSync(cacheDir, { recursive: true });
          writeJsonFileAtomic(cacheFile, response);
        } catch { /* continue */ }
      }
    }
    if (!usageData) usageData = readJsonFile(cacheFile);
  }

  if (usageData) {
    const barWidth = 10;

    // Compute each column's row contents + their visible widths FIRST, so the column
    // can be sized to its longest row before anything is padded.
    // 5-hour (current)
    const fiveHourPct = Math.round(usageData.five_hour?.utilization || 0);
    const fiveHourReset = formatResetTime(usageData.five_hour?.resets_at, 'time');
    const col1BarVisLen = 5 + barWidth + 1 + String(fiveHourPct).length + 1; // "5hr: " = 5
    const col1ResetPlain = `resets ${fiveHourReset}`;

    // 7-day (weekly)
    const sevenDayPct = Math.round(usageData.seven_day?.utilization || 0);
    const sevenDayReset = formatResetTime(usageData.seven_day?.resets_at, 'datetime');
    const col2BarVisLen = 8 + barWidth + 1 + String(sevenDayPct).length + 1; // "weekly: " = 8
    const col2ResetPlain = `resets ${sevenDayReset}`;

    // Size each column to its longest row THIS render (col1 also considers the line-1
    // model+effort prefix), so the longest row sits ~1 space from its separator.
    COL1_W = Math.max(prefixVis, col1BarVisLen, col1ResetPlain.length);
    COL2_W = Math.max(col2BarVisLen, col2ResetPlain.length);

    const fiveHourBar = buildBar(fiveHourPct, barWidth, frame);
    let col1Bar = `${C.white}5hr:${C.reset} ${fiveHourBar} ${C.cyan}${fiveHourPct}%${C.reset}`;
    col1Bar = padColumn(col1Bar, col1BarVisLen, COL1_W);
    let col1Reset = `${C.white}resets ${fiveHourReset}${C.reset}`;
    col1Reset = padColumn(col1Reset, col1ResetPlain.length, COL1_W);

    const sevenDayBar = buildBar(sevenDayPct, barWidth, frame);
    let col2Bar = `${C.white}weekly:${C.reset} ${sevenDayBar} ${C.cyan}${sevenDayPct}%${C.reset}`;
    col2Bar = padColumn(col2Bar, col2BarVisLen, COL2_W);
    let col2Reset = `${C.white}resets ${sevenDayReset}${C.reset}`;
    col2Reset = padColumn(col2Reset, col2ResetPlain.length, COL2_W);

    // Extra usage
    let col3Bar = '';
    let col3Reset = '';
    if (usageData.extra_usage?.is_enabled) {
      const extraPct = Math.round(usageData.extra_usage.utilization || 0);
      const extraUsed = ((usageData.extra_usage.used_credits || 0) / 100).toFixed(2);
      const extraLimit = ((usageData.extra_usage.monthly_limit || 0) / 100).toFixed(2);
      const extraBar = buildBar(extraPct, barWidth, frame);

      const now = new Date();
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      const extraReset = `${months[nextMonth.getMonth()]} ${nextMonth.getDate()}`;

      col3Bar = `${C.white}extra:${C.reset} ${extraBar} ${C.cyan}$${extraUsed}/$${extraLimit}${C.reset}`;
      col3Reset = `${C.white}resets ${extraReset}${C.reset}`;
    }

    line2 = col1Bar + sep + col2Bar;
    if (col3Bar) line2 += sep + col3Bar;

    line3 = col1Reset + sep + col2Reset;
    if (col3Reset) line3 += sep + col3Reset;
  }

  // LINE 3: session (new work) | compute (full throughput) | lifetime (high score)
  // All three token counters grouped on line 3. "session" = new work only (input +
  // cache_create + output, excludes cache re-reads) — what counts against rate limits.
  // "compute" = full throughput incl. cache re-reads. "lifetime" = all-sessions total.
  // session/compute pad to a shared width so their separators align.
  const VAL_W = Math.max(formatTokens(sessionNew).length, formatTokens(sessionCompute).length);
  if (sessionNew > 0) {
    const sessStr = `${C.white}session:${C.reset} ${C.cyan}${formatTokens(sessionNew).padEnd(VAL_W)}${C.reset}`;
    line3 = (line3 ? line3 + sep : '') + sessStr;
  }
  if (sessionCompute > 0) {
    line3 = (line3 ? line3 + sep : '') + `${C.white}compute:${C.reset} ${C.cyan}${formatTokens(sessionCompute).padEnd(VAL_W)}${C.reset}`;
  }
  {
    const lifetime = computeLifetimeTokens();
    if (lifetime > 0) {
      const lifeStr = `${C.white}lifetime:${C.reset} ${C.orange}${formatLifetime(lifetime)}${C.reset}`;
      line3 = line3 ? line3 + sep + lifeStr : lifeStr;
    }
  }

  // Prepend the model+effort prefix, padded to COL1_W so "| context" aligns with the
  // first separators on lines 2 & 3. COL1_W already includes prefixVis, so the pad is
  // never negative; with no usageData COL1_W is 0 → max() falls back to no padding.
  line1 = padColumn(prefix, prefixVis, Math.max(COL1_W, prefixVis)) + sep + line1;

  // Write the deferred context snapshot, now enriched with rate-limit data.
  if (usageData) {
    ctxSnap.five_hour_pct = usageData.five_hour?.utilization || 0;
    ctxSnap.five_hour_resets_at = usageData.five_hour?.resets_at || null;
    ctxSnap.seven_day_pct = usageData.seven_day?.utilization || 0;
    ctxSnap.seven_day_resets_at = usageData.seven_day?.resets_at || null;
    const rl5 = ctxSnap.five_hour_pct;
    ctxSnap.rate_limit_status = rl5 >= 97 ? 'CRITICAL' : rl5 >= 95 ? 'WARNING' : rl5 >= 90 ? 'CAUTION' : 'OK';
  }
  writeContextSnapshot(ctxSnap);

  // ===== Output =====
  process.stdout.write(line1);
  if (line2) process.stdout.write('\n' + line2);
  if (line3) process.stdout.write('\n' + line3);
}

main().catch(() => process.stdout.write('Claude'));
