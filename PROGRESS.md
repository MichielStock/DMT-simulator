# PROGRESS.md

| Milestone | Status | Gate |
|---|---|---|
| M0 Setup and contracts | done (check_env.py exit 0, no fallbacks for env; test_schemas 17 passed) | check_env.py passes or fallbacks recorded; schema tests pass |
| M1 Pharmacology (py + ts), HUD | done (golden <1e-3 py+ts incl. timewarp 10; 7.3 typical+percentiles reproduced, deepest-layer column NOT, see NOTES; repeat-hit blocking tested) | golden tests both sides; 7.3 tables; repeat-hit blocking |
| M2 SafetyLimiter, flashcheck, safety screen, exit | done (safety e2e 5/5 real-time flashcheck; pipeline structural tests; flashcheck 14 pytest) | safety tests without real layers pass |
| M3 Walking skeleton | done (e2e session.spec 4/4 doses at timewarp 10, screens 8/8, templates + procedural) | e2e passes all four dose steps in timewarp |
| M4 Room layer | done (room.test 20/20; gallery room 16/16 + review pass; worst case 60 s pass; e2e green) — open: photo rooms show the SafetyLimiter guard's blotches (NOTES D-I10, safety owner) | gallery + review; flashcheck; e2e green |
| M5 Neural field | done (CPU spectrum 11/11, GPU spectrum 3/3 on the real server; four classes in the gallery; worst case 60 s pass, max block contrast 0.458) | spectrum test; gallery four classes; flashcheck max |
| M6 Chrysanthemum + waiting room | done (hyperbolic.test 37/37; gallery 12/12 + 12/12, review pass; worst case 60 s pass; full procedural trip session.spec 4/4 on templates) | gallery + review; flashcheck; full procedural trip |
| M7 Audio | done (audio.test 20/20, audio.spec 2/2; wired into main.ts with volume keys on every screen; not checked by ear) | offline audio test; levels follow state |
| M8 Intake, LLM planner, assets, safety filter, settling | back end done (intake→ready 40.5–58.8 s with qwen3:14b + SDXL-Lightning; resident_models [] before the hit; planning 9.75 GB; pytest 135/135; template fallback session.spec 4/4) — remaining for M9: the front-end breakthrough layer showing the generated world and beings | intake→ready < 3 min; models unloaded; llm + asset tests; template fallback |
| M9 Breakthrough, director, entities, glyphs, challenge, gentle, grounding | pending | e2e incl. escape + gentle; worst-case flashcheck; visual review |
| M10 Full report, curve, memory model, writer, lab view, export, replay | pending | report + replay tests; e2e green |
| M11 Validation, polish, perf, privacy, demo, DONE.md | pending | verify_all.sh exits 0; DONE.md |
| M12 Stretch | optional | keeps verify_all.sh green |
