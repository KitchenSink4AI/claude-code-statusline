# Claude Code Status Line

A custom status line for [Claude Code](https://claude.ai/code) that turns the context window into a real instrument — burn rate, turns remaining, rate limits, session tokens, and animated alerts, all in your terminal.

Built over months of daily use pushing sessions to 900k+ tokens, iterating on every false alarm and missed warning until the numbers matched reality.

![Status line showing three lines of context, rate limit, and session data](https://img.shields.io/badge/Claude_Code-Status_Line-blue)

## What it shows

**Line 1 — Context + burn rate:**
```
Opus 4.8 (high) | context: ●●●●●●○○○○ 450k/1m 45% | turn: 12 | last: +35k | rate: 28k ~18 turns left | my-project  main
```

**Line 2 — Rate limits + session:**
```
5hr: ●●●●●●●○○○ 72% | weekly: ●●●○○○○○○○ 31% | session: 4.2m | agents: 156k | spawned: 8
```

**Line 3 — Resets + throughput:**
```
resets 3:30pm | resets aug 29, 11:00am | compute: 18.7m | lifetime: 4,329,604,816
```

### Key features

- **Envelope-follower burn rate** — rises fast on heavy turns (attack: 0.55), falls slowly after cheap ones (release: 0.28), with a variance floor so the rate stays honest about demonstrated burstiness. A single spike won't panic; sustained heavy work will.
- **Turns remaining** — counts down to a conservative wall (~970k on a 1M window), not the raw window size. The wall is a moving estimate calibrated against real auto-compaction data (observed at ~1,006k tokens).
- **Three-tier alerts** — CAUTION / WARNING / CRITICAL driven by both token position AND burn rate. Near the wall with a heavy rate? CRITICAL fires even below the token threshold. Light chat at 80%? No alarm.
- **Animated CRITICAL** — red-orange-yellow color wave scrolling left-to-right, with reverse video for visibility. Paired with `refreshInterval: 1` for ~1fps even when idle.
- **Flashing bars** — filled dots flash red/yellow above 90% on all bars (context + rate limits).
- **Rate limit tracking** — 5-hour and 7-day utilization bars from the Anthropic OAuth usage API, cached 2.5 minutes.
- **Session burn tracker** — total new-work tokens (excluding cache re-reads) for this session, including all subagents. Scoped to your window — other windows can't leak in.
- **Lifetime counter** — cumulative tokens processed across all sessions, incrementally cached. The video-game high score.
- **Model self-check** — writes a tiny JSON snapshot per session so the model can run `node ~/.claude/context-status.js` and get its own real context budget instead of guessing.
- **Token diagnostic logger** — opt-in per-turn JSONL logger for calibrating the envelope follower across sessions.

## Installation

### 1. Copy the files

```bash
# Main status line
cp statusline.js ~/.claude/statusline.js

# Model self-check companion
cp context-status.js ~/.claude/context-status.js

# Token-check skill (optional — gives you /token-check in Claude Code)
mkdir -p ~/.claude/skills/token-check
cp skills/token-check/SKILL.md ~/.claude/skills/token-check/SKILL.md
cp skills/token-check/analyze.js ~/.claude/skills/token-check/analyze.js
```

### 2. Configure Claude Code

Add to your `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "command": "node ~/.claude/statusline.js",
    "refreshInterval": 1
  }
}
```

`refreshInterval: 1` (seconds) keeps the animations running even when idle. Remove it if you prefer event-driven-only refresh (updates after each assistant message).

### 3. Restart Claude Code

The status line appears immediately. The burn-rate block needs 2 turns to compute a delta, so you'll see `rate: tbd` on turn 1 — this is expected.

## How it works

Claude Code pipes a JSON payload to the status line command's stdin on every refresh. The payload includes the context window state, transcript path, session id, model info, and workspace details.

The status line parses the **full transcript JSONL** on every refresh to compute per-turn token costs. No external state files needed for delta tracking — the transcript IS the history. An envelope follower (fast attack, slow release) + variance floor produces the burn rate. Turns remaining = (wall − current) / rate.

Rate limits come from the Anthropic OAuth usage API (`api.anthropic.com/api/oauth/usage`), fetched with the session's OAuth token and cached for 60 seconds.

Session and lifetime token counts are computed incrementally with per-file caches (mtime + size keyed), so unchanged transcripts are stat-only on subsequent renders.

## Tuning

The key constants are at the top of `statusline.js`:

| Constant | Default | Purpose |
|----------|---------|---------|
| `HARD_FRACTION` / `HARD_CEILING` | 0.97 / 970000 | The conservative wall. Bump both together as you confirm higher safe runs. |
| `CAUTION_FRACTION` | 0.871 | Token-based CAUTION threshold (~845k on 970k wall) |
| `WARNING_FRACTION` | 0.923 | Token-based WARNING threshold (~895k) |
| `CRITICAL_FRACTION` | 0.955 | Token-based CRITICAL threshold (~926k) |
| `ATTACK` | 0.55 | Envelope attack rate (how fast it rises on heavy turns) |
| `RELEASE` | 0.28 | Envelope release rate (how slowly it drops after cheap turns) |
| `SIGMA_K` | 1.0 | Variance floor multiplier |
| `SIGMA_WINDOW` | 10 | Number of recent deltas for variance calculation |
| `FLAT_RATE_FLOOR` | 1000 | Minimum displayed rate for very flat sessions |

The wall scales proportionally to smaller windows (200k window → 194k wall), so these work at any model size.

## Token diagnostic logger

Enable opt-in per-turn logging to calibrate the envelope follower across sessions:

```bash
# Enable
touch ~/.claude/statusline-tokenlog.on

# Disable
rm ~/.claude/statusline-tokenlog.on
```

Logs to `~/.claude/statusline-tokenlog.jsonl` (append-only, auto-rotates at 5MB). Fields: `ts`, `sid`, `m` (model), `tn` (turn), `ctx`, `ctxT` (transcript-accurate), `d` (delta), `r` (rate), `L` (turns left), `w` (wall).

## Context self-check

The status line writes a live snapshot per session to `~/.claude/context-status/<session_id>.json`. The companion script reads it:

```bash
node ~/.claude/context-status.js
```

Output:
```
CONTEXT STATUS  (snapshot 2s old)
  Usage:    472k / 970k usable wall  (48% used, 52% free)
  Headroom: ~16 turn(s) at current burn (~28k/turn)
  Status:   OK
  No context concern. Proceed normally; do not ration or rush on account of context.
  Rate limits: 5hr 34.2% OK (resets 3:30 PM) | weekly 18.7%
```

## Design decisions

- **Why an envelope follower instead of a simple average?** A session-mean gets diluted by early cheap turns and understates the rate when you're doing heavy work. A symmetric EMA drops too fast after a burst — five cheap follow-up turns blow down the estimate, leaving you falsely optimistic right when another big task could land. The envelope rises fast (representative immediately) and falls slow (remembers heavy work).

- **Why a variance floor?** Without it, a string of lean turns after a heavy burst drops the rate to ~7k and shows 16+ turns at 850k — misleadingly optimistic when the session has proven it can spike to 165k. The σ floor keeps the rate honest about demonstrated burstiness, and self-extinguishes during consistent lean endings (uniform deltas → σ→0).

- **Why not the raw window size as the denominator?** The top ~3% of a 1M window is not usable — the engine auto-compacts at ~1,006k. The wall at 970k gives ~36k of buffer for one final turn's growth. The bar shows your position in the full window; the alerts warn against the practical ceiling.

- **Why token alerts AND turn alerts?** Token tiers catch you approaching the wall regardless of burn rate. Turn tiers catch you burning fast even at moderate fullness — a single oversized prompt at 600k with a 150k rate should fire CRITICAL because you genuinely have ~1 turn. The more severe signal wins.

## Requirements

- Claude Code CLI (provides the stdin JSON payload and the `CLAUDE_CODE_SESSION_ID` env var)
- Node.js (comes with Claude Code)
- A Claude subscription with OAuth (for rate-limit data; the status line degrades gracefully without it)

## License

MIT with Non-Commercial Clause — free to use, modify, and share for non-commercial purposes. Commercial use requires written permission from the author. See [LICENSE](LICENSE).
