# Build Log - "Jainam Kapadia"

| Date | Time Spent | Rough Tokens Used | What Shipped |
|---|---|---|---|
| 2026-09-11 | ~15 min | ~3,000 | Initial repo setup, plan.md, and BUILD_LOG.md creation |
| 2026-09-17 | ~50 min | ~45,000 | Custom `medicine-validator` Skill + perceive/reason/act/observe agent (Claude Agent SDK) chaining filesystem + GitHub MCP servers into one real end-to-end run against a sample scan; opened real GitHub issue #6 as proof. Also found and fixed a live API key committed to the public repo (bad `.gitignore` encoding). |
| 2026-09-18 | ~60 min | ~55,000 | Brought the Assessment 2 mechanism into the real app: swapped the standalone agent/MCP loop for a direct integration (stated reason in README) — the prescription-scan Gemini call now also returns `validationFlags` checked against the same reference drug dataset, with graceful handling if that field comes back malformed. Verified with two real end-to-end runs (a genuine flagged case and a forced-garbage-output case). Rewrote README.md for a stranger, added `.env.example`. |
| **Total** | **~2h 5min** | **~103,000** | **Cumulative across all sessions** |
