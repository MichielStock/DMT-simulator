# NOTES.md — Hyperspace simulator

## Decisions

- D1 (2026-10-10): Project directory is `/home/mstock/Code/hyperspace` (the directory the build was launched in), not `hyperspace-sim/`. Everything else follows section 0.5.
- D2 (2026-10-10): The machine has a system Ollama 0.3.3 on port 11434 (systemd, root-owned; too old for JSON-schema `format`). A user-space Ollama 0.40.2 is installed at `~/.local/opt/ollama` and runs on `127.0.0.1:11435` with `OLLAMA_MODELS=~/.local/share/hyperspace/ollama`, started by `scripts/setup.sh` / `run.sh` if not already up. The back end reads `HYPERSPACE_OLLAMA_HOST` (default `http://127.0.0.1:11435`) and falls back to 11434 only if that server is ≥ 0.5.
- D3 (2026-10-10): Node 18 is the system Node; Node 24 LTS is installed user-space at `~/.local/opt/node` and symlinked into `~/.local/bin`, which precedes `/usr/bin` on PATH. `setup.sh` repeats this install if `node < 20`.
- D4 (2026-10-10): Session stats (section 15.3) are computed by exactly one function, `backend/report/stats.py:compute_stats`, exposed as `GET /api/session/{id}/stats`. The end screen fetches it; `frontend/src/ui/stats.ts` only renders. Tests on both sides use the same fixed example session.
- D5 (2026-10-10): HTTP API prefix is `/api/`; the back end serves the built front end from `frontend/dist` at `/` and session assets at `/sessions/<id>/...`.

## Fallbacks active

(none yet)

## Model tags

(filled in by setup)
