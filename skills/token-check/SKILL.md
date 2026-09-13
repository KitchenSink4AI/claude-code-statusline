---
name: token-check
description: Inspect THIS window's context burn â€” current usage vs the practical context wall (a conservative ceiling that scales with the model's window, not the nominal size), the per-turn delta profile, the envelope burn-rate, and how many turns of headroom remain by task size (heavy/normal/small). Use in long sessions to judge whether to keep going or checkpoint. Read-only, safe to run anytime.
---

# token-check

Reports the current window's real context budget and burn profile. It parses *this* session's transcript (full per-turn history) and, when available, the live status-line snapshot, so the headline numbers match the status bar the user sees.

## How to run

```
node ~/.claude/skills/token-check/analyze.js
```

Run it, then relay the output. Key interpretation when reporting:

- **% used vs the wall is the real "how full am I."** The wall is a conservative practical ceiling set just below the model's full window, and it SCALES with the window â€” roughly the high-900s-k on a 1M-token model, proportionally lower on smaller models (e.g. ~194k on a 200k window). It is not the nominal window size. The tool reads the actual wall for the current model from the live snapshot, so trust the number it prints rather than any fixed figure. Below ~90% of that wall there is genuine room.
- **Turns-left is BURN-RATE based, not a hard limit.** A low turns-left / WARNING / CRITICAL while plenty is still free (low %) means recent tasks were heavy â€” it does NOT mean stop. Keep doing smaller tasks (saving memory after each); only truly wrap up / save state when NEAR THE WALL (high % used). The "Headroom by task size" lines make this concrete: small tasks usually have far more runway than the single headline turns number suggests.
- **Trend RISING** = recent turns getting heavier; be deliberate before the next large task (a couple big back-to-back tasks are what actually overflow).
- **Memory save safety** = whether the largest project memory file can be safely full-read or rewritten at the current headroom, or whether to append-only. It sizes files via `stat` (no content load), so the check itself is near-free even near the wall. Heed it before saving state to a large project file: when it says append-only, append or targeted-edit rather than reading the whole file.

## Rate-limit awareness

The tool also reports the 5-hour and weekly rate-limit utilization from the live OAuth data (refreshed every ~2.5 minutes by the status line). This is the raw Anthropic number â€” not rounded, not display-formatted. Follow the warnings it prints:

**Model-specific agent-launch cutoffs** (loosened 2026-09-09 by author ruling: Opus workers lowered per-batch burn, so margins shrank; original values in parentheses):
- **Fable**: stop launching new agents at **95%** (was 92%) of the 5hr limit. The old margin assumed Fable-on-Fable batches jumping 5-10% per wave; Opus worker batches jump less. If launching a heavy SAME-MODEL Fable batch, use the old 92%.
- **Opus / Sonnet / others**: stop launching new agents at **96%** (was 95%).
- **All models**: hard stop at **98%** (was 97%) â€” save state, save memory, pause work. Schedule resume for 5 minutes after the reset time shown.

**When a rate-limit warning fires:**
- At CAUTION (92%, was 90%): check here before each new agent batch. Do not launch speculative or low-priority agents.
- At WARNING (agent-launch cutoff): stop launching agents entirely. Finish only the current in-flight work. Save state after each completed task.
- At CRITICAL (98%+): save all state and memory NOW. Do not start any new work. If in a `/loop`, use ScheduleWakeup for 5 minutes past the reset time. Otherwise, report the situation and wait.

**Important caveats:**
- The OAuth data is cached for up to 2.5 minutes. During heavy bursts (many agents launching rapidly), the displayed percentage may lag behind reality. If usage is above 80% and the cache is old, re-check after your current batch completes.
- Multiple windows share the same 5-hour pool. This tool shows YOUR window's view of a SHARED resource. Other active windows are also consuming from it.
- Each subagent consumes from the same rate-limit pool independently. A batch of 10 agents is not 1 unit of rate-limit cost â€” it is 10.

**Constantly check this tool during autonomous and multi-agent runs.** Do not wait for a problem to surface. Check before each agent batch, after each heavy task, and periodically during long runs. Follow the warnings â€” they exist because sessions have collapsed mid-run from hitting rate limits without warning.

Read-only and near-zero cost â€” fine to run whenever context feels uncertain in a long session.
