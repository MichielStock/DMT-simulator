# PROGRESS.md

| Milestone | Status | Gate |
|---|---|---|
| M0 Setup and contracts | done (check_env.py exit 0, no fallbacks for env; test_schemas 17 passed) | check_env.py passes or fallbacks recorded; schema tests pass |
| M1 Pharmacology (py + ts), HUD | done (golden <1e-3 py+ts incl. timewarp 10; 7.3 typical+percentiles reproduced, deepest-layer column NOT, see NOTES; repeat-hit blocking tested) | golden tests both sides; 7.3 tables; repeat-hit blocking |
| M2 SafetyLimiter, flashcheck, safety screen, exit | done (safety e2e 5/5 real-time flashcheck; pipeline structural tests; flashcheck 14 pytest) | safety tests without real layers pass |
| M3 Walking skeleton | done (e2e session.spec 4/4 doses at timewarp 10, screens 8/8, templates + procedural) | e2e passes all four dose steps in timewarp |
| M4 Room layer | pending | gallery + review; flashcheck; e2e green |
| M5 Neural field | pending | spectrum test; gallery four classes; flashcheck max |
| M6 Chrysanthemum + waiting room | pending | gallery + review; flashcheck; full procedural trip |
| M7 Audio | pending | offline audio test; levels follow state |
| M8 Intake, LLM planner, assets, safety filter, settling | pending | intake→ready < 3 min; models unloaded; llm + asset tests; template fallback |
| M9 Breakthrough, director, entities, glyphs, challenge, gentle, grounding | pending | e2e incl. escape + gentle; worst-case flashcheck; visual review |
| M10 Full report, curve, memory model, writer, lab view, export, replay | pending | report + replay tests; e2e green |
| M11 Validation, polish, perf, privacy, demo, DONE.md | pending | verify_all.sh exits 0; DONE.md |
| M12 Stretch | optional | keeps verify_all.sh green |
