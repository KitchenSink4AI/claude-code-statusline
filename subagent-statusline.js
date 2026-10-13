#!/usr/bin/env node
// Per-agent rows for the Claude Code agent panel (settings key "subagentStatusLine").
// Claude Code runs this about every 5 s with every visible subagent row on stdin
// ({ ...base hook fields, columns, tasks: [...] }) and reads back one JSON line per row:
// {"id": "<task id>", "content": "<row>"}; an empty content hides the row.
//
// Row: model + effort, name/progress, context bar with window size, elapsed, quiet time.
// Finished, failed and killed agents are hidden so the panel shows only live work.
// Cheap by design: one stat of each agent transcript per run, nothing written.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEBUG_FLAG = path.join(CLAUDE_DIR, 'subagent-statusline.debug');      // create to capture stdin
const DEBUG_OUT = path.join(CLAUDE_DIR, 'subagent-statusline-last-input.json');
const DEBUG_TICKS = path.join(CLAUDE_DIR, 'subagent-statusline-ticks.log');

const QUIET_WARN_MS = 5 * 60 * 1000;  // prompt cache lasts ~5 min; a later call re-pays the whole context
const QUIET_SHOW_MS = 30 * 1000;      // below this the agent counts as active
const HANDOFF_TOKENS = 250000;        // flag a subagent as large at ~250k tokens
const BAR_WIDTH = 6;

const C = {
  green:  '\x1b[38;2;0;160;0m',
  cyan:   '\x1b[38;2;46;149;153m',
  red:    '\x1b[38;2;255;85;85m',
  yellow: '\x1b[38;2;230;200;0m',
  orange: '\x1b[38;2;255;150;50m',
  violet: '\x1b[38;2;170;130;255m',
  grey:   '\x1b[38;2;160;160;160m',
  bold:   '\x1b[1m',
  reset:  '\x1b[0m',
};
const FAMILY_COLOR = { Opus: C.orange, Sonnet: C.cyan, Haiku: C.green, Fable: C.violet };

function truncate(text, width) {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  return width === 1 ? '…' : text.slice(0, width - 1) + '…';
}

function formatTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

// Seconds are shown, and step by 5: Claude Code re-runs this script every 5 s (measured;
// the settings schema allows no refreshInterval for agent rows).
function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

// Window sizes read as "200k" / "1M" rather than "200.0k" / "1.0M".
function formatLimit(n) {
  if (n >= 1e6 && n % 1e6 === 0) return n / 1e6 + 'M';
  if (n >= 1e3 && n % 1e3 === 0) return n / 1e3 + 'k';
  return formatTokens(n);
}

// "claude-haiku-4-5-20251001" -> "Haiku 4.5"; "claude-opus-5-5[1m]" -> "Opus 5.5"
function shortModel(id) {
  if (!id) return null;
  const m = /(opus|sonnet|haiku|fable)[-_ ]?(\d+)?(?:[-.](\d{1,2})(?!\d))?/i.exec(id);
  if (!m) return { name: String(id).replace(/^claude-/, '').slice(0, 12), family: null };
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  const version = m[2] ? (m[3] ? `${m[2]}.${m[3]}` : m[2]) : '';
  return { name: version ? `${family} ${version}` : family, family };
}

function formatEffort(effort) {
  if (effort === undefined || effort === null || effort === '') return '';
  if (typeof effort === 'number') return effort >= 1000 ? Math.round(effort / 1000) + 'k' : String(effort);
  return String(effort);
}

// Context column: "▰▰▱▱▱▱  26%  262k/1M    " (22 wide), or the numbers alone (15) when space is short.
const NUMS_W = 15;  // " 26% 20.1k/200k"
const CTX_W = BAR_WIDTH + 1 + NUMS_W;
const CTX_SHORT_W = NUMS_W;
function contextBar(tokens, windowSize, withBar) {
  const tok = formatTokens(tokens).padStart(5);
  const width = withBar ? CTX_W : CTX_SHORT_W;
  if (!windowSize) {
    const t = `${tok}/?`;
    return { text: `${C.grey}${t.padStart(width)}${C.reset}`, len: width };
  }
  const pct = Math.min(100, Math.round((tokens / windowSize) * 100));
  const filled = Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH));
  const color = tokens >= HANDOFF_TOKENS || pct >= 80 ? C.red : pct >= 50 ? C.yellow : C.green;
  const limit = formatLimit(windowSize);
  const nums = `${String(pct).padStart(3)}% ${tok}${C.grey}/${limit}${C.reset}`;
  const numsCol = nums + ' '.repeat(Math.max(0, NUMS_W - (4 + 1 + 5 + 1 + limit.length)));
  if (!withBar) return { text: `${color}${numsCol}${C.reset}`, len: width };
  const bar = '▰'.repeat(filled) + '▱'.repeat(BAR_WIDTH - filled);
  return { text: `${color}${bar}${C.reset} ${numsCol}`, len: width };
}

// The agent's transcript lives at <session dir>/<session_id>/subagents/agent-<id>.jsonl.
// Its mtime is the time of the agent's last API or tool write: the "quiet" clock.
function transcriptMtime(subDir, id) {
  if (!subDir || !id) return null;
  for (const name of [`agent-${id}.jsonl`, `${id}.jsonl`]) {
    try { return fs.statSync(path.join(subDir, name)).mtimeMs; } catch { /* try the next */ }
  }
  return null;
}

// Fixed column widths keep every row's metrics aligned under each other.
const SEP = '  ';
const MODEL_W = 14;   // "Opus 5.5·xhigh"
const ELAPSED_W = 6;  // "40m00s"
const QUIET_W = 18;   // "quiet 7m06s (cold)"
const FLAG_W = 8;     // "hand off", only when some agent needs it
const MIN_TEXT_W = 16;

function pad(colored, visible, width) {
  return colored + ' '.repeat(Math.max(0, width - visible));
}

// One layout per run so every row has the same columns. Narrow panels shed the
// elapsed time first, then the bar glyphs.
function chooseLayout(columns, showFlag) {
  const levels = [
    { elapsed: true, bar: true },
    { elapsed: false, bar: true },
    { elapsed: false, bar: false },
  ];
  const s = SEP.length;
  for (const l of levels) {
    const fixed = MODEL_W + s + (l.bar ? CTX_W : CTX_SHORT_W) + s + (showFlag ? FLAG_W + s : 0)
      + (l.elapsed ? ELAPSED_W + s : 0) + QUIET_W + s;
    if (fixed + MIN_TEXT_W <= columns - 1) return { ...l, showFlag };
  }
  return { ...levels[levels.length - 1], showFlag };
}

function buildRow(task, columns, now, subDir, layout) {
  const tokens = Number(task.tokenCount) || 0;

  const model = shortModel(task.model);
  const effort = formatEffort(task.effort);
  const modelText = truncate((model ? model.name : '…') + (effort ? `·${effort}` : ''), MODEL_W);
  const name = modelText.split('·')[0];
  const rest = modelText.slice(name.length);
  const modelColor = (model && FAMILY_COLOR[model.family]) || C.grey;
  const modelCol = pad(`${modelColor}${name}${C.reset}${rest ? `${C.grey}${rest}${C.reset}` : ''}`, modelText.length, MODEL_W);

  const metrics = [];
  const bar = contextBar(tokens, Number(task.contextWindowSize) || 0, layout.bar);
  metrics.push([bar.text, bar.len]);
  if (layout.showFlag) {
    metrics.push(tokens >= HANDOFF_TOKENS
      ? [`${C.red}${C.bold}hand off${C.reset}`, FLAG_W]
      : [' '.repeat(FLAG_W), FLAG_W]);
  }

  if (layout.elapsed) {
    const elapsed = task.startTime ? formatDuration(now - Number(task.startTime)) : '';
    metrics.push([`${C.grey}${elapsed.padStart(ELAPSED_W)}${C.reset}`, ELAPSED_W]);
  }

  const mtime = transcriptMtime(subDir, task.id);
  let quiet;
  if (mtime === null) {
    quiet = [`${C.grey}${'—'.padEnd(QUIET_W)}${C.reset}`, QUIET_W];
  } else {
    const q = now - mtime;
    if (q >= QUIET_WARN_MS) {
      const t = truncate(`quiet ${formatDuration(q)} (cold)`, QUIET_W);
      quiet = [`${C.yellow}${C.bold}${t.padEnd(QUIET_W)}${C.reset}`, QUIET_W];
    } else if (q >= QUIET_SHOW_MS) {
      const t = `quiet ${formatDuration(q)}`;
      quiet = [`${C.grey}${t.padEnd(QUIET_W)}${C.reset}`, QUIET_W];
    } else {
      quiet = [`${C.green}●${C.reset} ${'active'.padEnd(QUIET_W - 2)}`, QUIET_W];
    }
  }
  metrics.push(quiet);

  // Name / progress text takes whatever width is left, so the metric columns line up.
  const fixed = MODEL_W + SEP.length + metrics.reduce((n, [, l]) => n + l + SEP.length, 0);
  const label = task.label || task.description || '';
  const text = task.name ? `${task.name}: ${label}` : label;
  const room = Math.max(0, Math.min(columns, 200) - 1 - fixed);
  const shown = truncate(text.replace(/\s+/g, ' ').trim(), room);
  const textCol = shown + ' '.repeat(Math.max(0, room - shown.length));

  return [modelCol, textCol, ...metrics.map(([s]) => s)].join(SEP).replace(/\s+$/, '');
}

function main(raw) {
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  try {
    if (fs.existsSync(DEBUG_FLAG)) {
      fs.writeFileSync(DEBUG_OUT, raw);
      fs.appendFileSync(DEBUG_TICKS, `${Date.now()}\n`);
    }
  } catch { /* debug only */ }

  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const columns = Number(input.columns) || 100;
  const now = Date.now();
  const subDir = input.transcript_path && input.session_id
    ? path.join(path.dirname(input.transcript_path), input.session_id, 'subagents')
    : null;

  const running = (t) => t && t.id && (!t.status || t.status === 'running');
  const showFlag = tasks.some((t) => running(t) && Number(t.tokenCount) >= HANDOFF_TOKENS);
  const layout = chooseLayout(columns, showFlag);
  const out = [];
  for (const task of tasks) {
    if (!task || !task.id) continue;
    if (!running(task)) {
      out.push(JSON.stringify({ id: task.id, content: '' }));
      continue;
    }
    try {
      out.push(JSON.stringify({ id: task.id, content: buildRow(task, columns, now, subDir, layout) }));
    } catch { /* leave this row to the default rendering */ }
  }
  if (out.length) process.stdout.write(out.join('\n') + '\n');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => { try { main(raw); } catch { /* never break the panel */ } });
