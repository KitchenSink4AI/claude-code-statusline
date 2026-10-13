# Claude Code Status Line

A status line for [Claude Code](https://claude.ai/code) that turns the context window into an instrument you can read at a glance: burn rate, turns remaining, rate limits, prompt-cache health and session tokens, with alerts that escalate as you approach the limit.

## What it shows

**Line 1: context and burn rate**
```
Opus (max) | context: ●●●●●●○○○○ 450k/1m 45% | turn: 12 | last: +35k | rate: 28k ~18 turns left | my-project  main
```

**Line 2: rate limits, cache health and agents**
```
5hr: ●●●●●●●○○○ 72% | weekly: ●●●○○○○○○○ 31% | cache: 54m left | agents: 3 | lifetime spawned: 1,212
```

**Line 3: resets, session tokens and throughput**
```
resets 3:30pm | resets aug 29, 11:00am | session: 4.2m | compute: 18.7m | lifetime: 4,329,604,816
```

### Features

- **Burn rate that follows real work.** An envelope follower rises quickly on heavy turns (attack 0.55) and falls slowly after light ones (release 0.28), with a variance floor so the estimate stays honest about how bursty the session has been. One spike will not raise an alarm; sustained heavy work will.
- **Turns remaining.** Counts down to a conservative usable limit (about 970k on a 1M window) rather than the raw window size, because the top few percent of the window is not usable before automatic compaction.
- **Three alert levels.** CAUTION, WARNING and CRITICAL depend on both your position in the window and your burn rate. Near the limit with a heavy rate, CRITICAL fires even below the token threshold; light chat at 80% raises no alarm.
- **Animated CRITICAL state.** A scrolling red, orange and yellow wave in reverse video. With `refreshInterval: 1` it animates even when the session is idle.
- **Prompt-cache countdown.** Minutes left before the prompt cache expires, measured against the detected TTL (1 hour or 5 minutes). Green while healthy, yellow after two thirds of the TTL, flashing in the last 10 minutes. It shows `COLD` once the cache has expired (your next turn re-caches the whole context at write cost) and flashes `5m TTL` if you have dropped to the short cache tier.
- **Rate-limit tracking.** Five-hour and seven-day usage bars from the Anthropic OAuth usage API, cached for 60 seconds.
- **Session and lifetime totals.** New-work tokens for this session including subagents (cache re-reads excluded, other windows excluded), plus a lifetime total across all sessions.
- **Agent counters.** Subagents spawned in this session, and a lifetime total. The first run seeds the lifetime total from subagent transcripts still on disk, so it starts as a lower bound and only counts up from there.
- **Context self-check for the model.** The status line writes a small JSON snapshot per session, so the model can run `node ~/.claude/context-status.js` and read its real context budget instead of guessing.
- **Optional token log.** A per-turn JSONL log for tuning the burn-rate model.

## Installation

### 1. Copy the files

```bash
# Status line
cp statusline.js ~/.claude/statusline.js

# Context self-check companion
cp context-status.js ~/.claude/context-status.js

# Optional: the /token-check skill for Claude Code
mkdir -p ~/.claude/skills/token-check
cp skills/token-check/SKILL.md ~/.claude/skills/token-check/SKILL.md
cp skills/token-check/analyze.js ~/.claude/skills/token-check/analyze.js
```

### 2. Configure Claude Code

Add this to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "command": "node ~/.claude/statusline.js",
    "refreshInterval": 1
  }
}
```

`refreshInterval: 1` (seconds) keeps the animations running while the session is idle. Leave it out if you prefer the status line to update only after each assistant message.

### 3. Restart Claude Code

The status line appears right away. The burn rate needs two turns to measure a change, so turn 1 shows `rate: tbd`.

## How it works

On every refresh, Claude Code sends the status line command a JSON payload on stdin with the context window state, the transcript path, the session id, model details and the workspace.

The status line reads the transcript JSONL to compute the token cost of each turn, so it needs no state files of its own for that. The burn rate comes from the envelope follower and variance floor described above, and turns remaining is (limit − current) / rate.

Rate limits come from the Anthropic OAuth usage API (`api.anthropic.com/api/oauth/usage`), requested with the session's OAuth token and cached for 60 seconds. Session and lifetime totals are computed incrementally with per-file caches keyed on modification time and size, so unchanged transcripts cost only a file stat on later refreshes.

## Tuning

The main constants are at the top of `statusline.js`:

| Constant | Default | Purpose |
|----------|---------|---------|
| `HARD_FRACTION` / `HARD_CEILING` | 0.97 / 970000 | The usable limit. Change both together. |
| `CAUTION_FRACTION` | 0.871 | Token-based CAUTION threshold (about 845k on a 970k limit) |
| `WARNING_FRACTION` | 0.923 | Token-based WARNING threshold (about 895k) |
| `CRITICAL_FRACTION` | 0.955 | Token-based CRITICAL threshold (about 926k) |
| `ATTACK` | 0.55 | How fast the rate rises on heavy turns |
| `RELEASE` | 0.28 | How slowly the rate falls after light turns |
| `SIGMA_K` | 1.0 | Variance floor multiplier |
| `SIGMA_WINDOW` | 10 | Number of recent turns used for the variance |
| `FLAT_RATE_FLOOR` | 1000 | Minimum displayed rate for very flat sessions |

The limit scales with smaller windows (a 200k window gets a 194k limit), so the same settings work for every model.

## Token log

Turn the per-turn log on or off:

```bash
touch ~/.claude/statusline-tokenlog.on   # on
rm ~/.claude/statusline-tokenlog.on      # off
```

Entries go to `~/.claude/statusline-tokenlog.jsonl` (append-only, rotated at 5 MB) with the fields `ts`, `sid`, `m` (model), `tn` (turn), `ctx`, `ctxT` (from the transcript), `d` (change), `r` (rate), `L` (turns left) and `w` (limit).

## Context self-check

The status line keeps a live snapshot per session in `~/.claude/context-status/<session_id>.json`. The companion script reads it:

```bash
node ~/.claude/context-status.js
```

```
CONTEXT STATUS  (snapshot 2s old)
  Usage:    472k / 970k usable wall  (48% used, 52% free)
  Headroom: ~16 turn(s) at current burn (~28k/turn)
  Status:   OK
  No context concern. Proceed normally; do not ration or rush on account of context.
  Rate limits: 5hr 34.2% OK (resets 3:30 PM) | weekly 18.7%
```

## Design notes

- **Why an envelope follower rather than an average?** A session average is diluted by early light turns and understates the rate during heavy work. A symmetric moving average drops too fast after a burst, so a few light turns would leave you optimistic just before the next large task. The envelope becomes representative immediately and remembers heavy work.
- **Why a variance floor?** Without it, a run of light turns after a heavy burst can drop the rate far enough to promise many turns near the limit, even though the session has shown it can spike far higher. The floor keeps the estimate honest and fades away when turns are consistently light.
- **Why not use the raw window size?** The top few percent of a 1M window is not usable before automatic compaction. The 970k limit leaves room for one final turn. The bar shows your position in the full window, and the alerts warn against the practical ceiling.
- **Why both token alerts and turn alerts?** Token levels catch you approaching the limit at any burn rate. Turn levels catch fast burning at moderate fullness: one oversized prompt at 600k with a 150k rate deserves CRITICAL because only about one turn is left. The more severe signal wins.

## Requirements

- Claude Code (it provides the stdin payload and the `CLAUDE_CODE_SESSION_ID` environment variable)
- Node.js (installed with Claude Code)
- A Claude subscription signed in with OAuth for the rate-limit data; everything else works without it

## License

A custom non-commercial license with MIT-style terms: free to use, modify and share for non-commercial purposes. Commercial use needs written permission from the copyright holder; contact licensing@kitchensink4.ai. See [LICENSE](LICENSE).

Maintained by [KitchenSink4AI](https://kitchensink4.ai), a product line of Alvut Consulting, LLC. Our tools are built with the help of AI coding assistants.

## Trademarks

This is an independent community tool for use with Claude Code. It is not affiliated with, endorsed by, or sponsored by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.
