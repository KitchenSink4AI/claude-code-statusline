// Agent heartbeat segment — run with: node --test test/
// Zero dependencies: node:test + node:assert only, matching the rest of the repo.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectAgentHeartbeats,
  renderAgentSegment,
  formatAgentAge,
  agentHeartbeatSegment,
  expandHome,
  AGENT_QUIET_SEC,
  AGENT_STALE_SEC,
} = require('../statusline.js');

const NOW = Date.now();

// Strip ANSI so assertions read on the visible text.
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const hasColor = (s, code) => s.includes(code);

const RED = '\x1b[38;2;255;85;85m';
const YELLOW = '\x1b[38;2;230;200;0m';
const GREEN = '\x1b[38;2;0;160;0m';

function makeDir(files) {
  // files: { name: [contentString, ageSeconds] }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-test-'));
  for (const [name, [content, ageSec]] of Object.entries(files)) {
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, content);
    const t = (NOW - ageSec * 1000) / 1000;
    fs.utimesSync(fp, t, t);
  }
  return dir;
}

const hb = (status, extra = {}) => JSON.stringify({ agent: 'a', status, ...extra });

test('missing directory yields zeros and renders nothing', () => {
  const state = collectAgentHeartbeats(path.join(os.tmpdir(), 'definitely-not-here-9137'), NOW);
  assert.deepStrictEqual(state, { running: 0, blocked: 0, quietestSec: 0 });
  assert.strictEqual(renderAgentSegment(state), '');
});

test('empty directory renders nothing', () => {
  const state = collectAgentHeartbeats(makeDir({}), NOW);
  assert.strictEqual(state.running, 0);
  assert.strictEqual(renderAgentSegment(state), '');
});

test('only completed and killed agents renders nothing', () => {
  const dir = makeDir({
    'a.json': [hb('completed'), 30],
    'b.json': [hb('killed'), 30],
  });
  const state = collectAgentHeartbeats(dir, NOW);
  assert.strictEqual(state.running, 0);
  assert.strictEqual(renderAgentSegment(state), '');
});

test('one running agent counts and reports its own age', () => {
  const dir = makeDir({ 'a.json': [hb('running'), 45] });
  const state = collectAgentHeartbeats(dir, NOW);
  assert.strictEqual(state.running, 1);
  assert.ok(state.quietestSec >= 44 && state.quietestSec <= 47);
  assert.strictEqual(plain(renderAgentSegment(state)), '⚙1·45s');
});

test('three running agents report the QUIETEST (oldest) heartbeat', () => {
  const dir = makeDir({
    'a.json': [hb('running'), 10],
    'b.json': [hb('running'), 120],
    'c.json': [hb('running'), 45],
    'd.json': [hb('completed'), 5],
  });
  const state = collectAgentHeartbeats(dir, NOW);
  assert.strictEqual(state.running, 3);
  assert.strictEqual(plain(renderAgentSegment(state)), '⚙3·2m');
});

test('a blocked agent gets its own marker and is not in the running count', () => {
  const dir = makeDir({
    'a.json': [hb('running'), 300],
    'b.json': [hb('running'), 60],
    'c.json': [hb('blocked'), 200],
  });
  const state = collectAgentHeartbeats(dir, NOW);
  assert.strictEqual(state.running, 2);
  assert.strictEqual(state.blocked, 1);
  assert.strictEqual(plain(renderAgentSegment(state)), '⚙2·5m·1⛔');
});

test('a blocked agent with no running agents stays hidden', () => {
  const dir = makeDir({ 'a.json': [hb('blocked'), 200] });
  const state = collectAgentHeartbeats(dir, NOW);
  assert.strictEqual(state.blocked, 1);
  assert.strictEqual(renderAgentSegment(state), '');
});

test('a stale blocked file is history, not news', () => {
  const dir = makeDir({
    'a.json': [hb('running'), 30],
    'old.json': [hb('blocked'), 4 * 3600],
  });
  const state = collectAgentHeartbeats(dir, NOW);
  assert.strictEqual(state.blocked, 0);
  assert.strictEqual(plain(renderAgentSegment(state)), '⚙1·30s');
});

test('staleness comes from mtime, never the JSON updated field', () => {
  // The file was touched 20 minutes ago but claims to have been updated 1 second ago.
  const lying = JSON.stringify({
    agent: 'a', status: 'running',
    updated: new Date(NOW - 1000).toISOString(),
  });
  const dir = makeDir({ 'a.json': [lying, 20 * 60] });
  const state = collectAgentHeartbeats(dir, NOW);
  assert.ok(state.quietestSec >= 20 * 60 - 3, 'mtime age must win over the self-reported timestamp');
  assert.strictEqual(plain(renderAgentSegment(state)), '⚙1·20m');
});

test('colors follow the 5 / 15 minute thresholds', () => {
  const green = collectAgentHeartbeats(makeDir({ 'a.json': [hb('running'), 60] }), NOW);
  const yellow = collectAgentHeartbeats(makeDir({ 'a.json': [hb('running'), AGENT_QUIET_SEC + 60] }), NOW);
  const red = collectAgentHeartbeats(makeDir({ 'a.json': [hb('running'), AGENT_STALE_SEC + 60] }), NOW);
  assert.ok(hasColor(renderAgentSegment(green), GREEN));
  assert.ok(hasColor(renderAgentSegment(yellow), YELLOW));
  assert.ok(hasColor(renderAgentSegment(red), RED));
});

test('fresh malformed JSON counts as a running agent of unknown status', () => {
  const dir = makeDir({ 'a.json': ['{"agent":"a","status":"run', 20] });
  const state = collectAgentHeartbeats(dir, NOW);
  assert.strictEqual(state.running, 1);
  assert.strictEqual(plain(renderAgentSegment(state)), '⚙1·20s');
});

test('stale malformed JSON is ignored', () => {
  const dir = makeDir({ 'a.json': ['not json at all', 30 * 60] });
  const state = collectAgentHeartbeats(dir, NOW);
  assert.strictEqual(state.running, 0);
  assert.strictEqual(renderAgentSegment(state), '');
});

test('non-json files and odd status values are skipped without throwing', () => {
  const dir = makeDir({
    'notes.txt': ['ignore me', 10],
    'a.json': [hb('RUNNING'), 10],
    'b.json': [JSON.stringify({ agent: 'b' }), 30 * 60],
    'c.json': [JSON.stringify({ agent: 'c', status: 42 }), 30 * 60],
  });
  const state = collectAgentHeartbeats(dir, NOW);
  assert.strictEqual(state.running, 1, 'status matching is case-insensitive; missing status is not running');
});

test('formatAgentAge switches units at a minute and an hour', () => {
  assert.strictEqual(formatAgentAge(0), '0s');
  assert.strictEqual(formatAgentAge(59), '59s');
  assert.strictEqual(formatAgentAge(60), '1m');
  assert.strictEqual(formatAgentAge(3599), '59m');
  assert.strictEqual(formatAgentAge(3600), '1h');
  assert.strictEqual(formatAgentAge(7300), '2h');
});

test('the segment is off unless the config enables it', () => {
  const dir = makeDir({ 'a.json': [hb('running'), 30] });
  assert.strictEqual(agentHeartbeatSegment({}, NOW), '');
  assert.strictEqual(agentHeartbeatSegment(null, NOW), '');
  assert.strictEqual(agentHeartbeatSegment({ segments: { agentHeartbeats: { dir } } }, NOW), '');
  assert.strictEqual(
    agentHeartbeatSegment({ segments: { agentHeartbeats: { enabled: 'yes', dir } } }, NOW),
    '',
    'only a real boolean true enables it'
  );
  assert.strictEqual(
    plain(agentHeartbeatSegment({ segments: { agentHeartbeats: { enabled: true, dir } } }, NOW)),
    '⚙1·30s'
  );
});

test('an enabled segment pointed at a missing dir stays silent', () => {
  const cfg = { segments: { agentHeartbeats: { enabled: true, dir: path.join(os.tmpdir(), 'nope-8823') } } };
  assert.strictEqual(agentHeartbeatSegment(cfg, NOW), '');
});

test('expandHome resolves a leading tilde only', () => {
  assert.strictEqual(expandHome('~'), os.homedir());
  assert.strictEqual(expandHome('~/.claude/agent-status'), path.join(os.homedir(), '.claude', 'agent-status'));
  assert.strictEqual(expandHome('/abs/path'), '/abs/path');
  assert.strictEqual(expandHome('a~b'), 'a~b');
  assert.strictEqual(expandHome(''), '');
  assert.strictEqual(expandHome(undefined), '');
});
