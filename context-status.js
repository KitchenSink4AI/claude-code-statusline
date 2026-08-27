#!/usr/bin/env node
// context-status.js — lets the MODEL self-check its real context budget.
//
// The custom status line (statusline.js) writes a tiny live snapshot per session
// to ~/.claude/context-status/<session_id>.json on every refresh. This script
// identifies THIS window's session via the CLAUDE_CODE_SESSION_ID env var that Claude
// Code sets on Bash tool calls, then prints that session's real numbers: usage, % of
// the usable wall, turns of headroom, and the OK/CAUTION/WARNING/CRITICAL state.
//
// HISTORY (2026-06-24): previously this guessed the session as "the most-recently-written
// transcript across all projects." That FAILS with multiple windows open — another active
// window's transcript can be newer than yours (and your own Bash result isn't written until
// AFTER this script runs), so it would report a DIFFERENT window's usage as your own. That
// caused a window at ~34% to be told it was at 92%/near-wall. The env var is authoritative;
// the mtime scan survives only as a fallback for older CLIs that don't set it.
//
// Usage:  node ~/.claude/context-status.js
// Purpose: when you find yourself unsure about remaining context, run this for the
// truth instead of guessing. An OK status means proceed normally.

const fs = require('fs');
const path = require('path');
const os = require('os');

function newestSessionId() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  let newest = null, newestM = -1;
  try {
    for (const proj of fs.readdirSync(projectsDir)) {
      const pdir = path.join(projectsDir, proj);
      let files;
      try { files = fs.readdirSync(pdir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        let m;
        try { m = fs.statSync(path.join(pdir, f)).mtimeMs; } catch { continue; }
        if (m > newestM) { newestM = m; newest = f.replace(/\.jsonl$/, ''); }
      }
    }
  } catch { /* ignore */ }
  return newest;
}

function currentSessionId() {
  // Authoritative: the invoking window's own session id, set by Claude Code on Bash calls.
  const env = (process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (env) return env;          // trust it even if the snapshot is briefly missing — reporting
                                // "not written yet" for YOUR session beats reporting another window's.
  return newestSessionId();     // fallback only when the env var is absent (older CLI).
}

function fmt(n) {
  if (n == null) return '?';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

const sid = currentSessionId();
if (!sid) {
  console.log('Context status unavailable (no session transcript found). Do not assume a limit; proceed and re-check later.');
  process.exit(0);
}

const snapFile = path.join(os.homedir(), '.claude', 'context-status', sid + '.json');
let s;
try { s = JSON.parse(fs.readFileSync(snapFile, 'utf8')); }
catch {
  console.log('Context status not written yet for this session (the status line refreshes every ~1s). Re-run in a moment; meanwhile do not assume you are near a limit.');
  process.exit(0);
}

const age = Math.floor(Date.now() / 1000) - (s.ts || 0);
console.log(`CONTEXT STATUS  (snapshot ${age}s old)`);
console.log(`  Usage:    ${fmt(s.context_tokens)} / ${fmt(s.wall)} usable wall  (${s.pct}% used, ${s.pct_remaining}% free)`);
if (s.turns_left != null) {
  console.log(`  Headroom: ~${s.turns_left} turn(s) at current burn (~${fmt(s.rate)}/turn)`);
}
console.log(`  Status:   ${s.status}`);
console.log(`  ${s.summary}`);
if (s.five_hour_pct != null) {
  const rl5 = s.five_hour_pct;
  const rl7 = s.seven_day_pct || 0;
  const rlStatus = s.rate_limit_status || 'OK';
  const resetStr = s.five_hour_resets_at ? new Date(s.five_hour_resets_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '?';
  console.log(`  Rate limits: 5hr ${rl5.toFixed(1)}% ${rlStatus} (resets ${resetStr}) | weekly ${rl7.toFixed(1)}%`);
  if (rl5 >= 97) console.log('  *** 5HR CRITICAL: save state NOW and pause. Schedule resume for 5 min after reset. ***');
  else if (rl5 >= 95) console.log('  ** 5HR WARNING: stop launching agents. Finish current work only. **');
  else if (rl5 >= 90) console.log('  * 5HR CAUTION: rate limit approaching. Be deliberate about new agent batches. *');
}
if (age > 30) {
  console.log(`  (Note: snapshot is ${age}s old; if the bar isn't refreshing, the number may lag — but it is still far better than guessing.)`);
}
