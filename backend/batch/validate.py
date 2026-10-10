"""Batch validation (BUILD.md §14): does it read like the real thing?

    uv run python -m backend.batch.validate --n 200          # templates (default; fast)
    uv run python -m backend.batch.validate --n 20 --llm     # language-model expansion + writer if Ollama is up

Runs sampler → expansion → synthesised event log (reference pharmacology) → memory model → writer for N sessions
under the §14 dose mix with intake answers sampled around neutral, codes every report with the keyword coder,
and writes verification/validation.json.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

from backend import runtime
from backend.batch.coder import CATEGORIES, TARGETS, code_report
from backend.batch.synth import synthesise_drawn_curve, synthesise_events
from backend.planner.expand import assemble_trip_script, expand_with_provenance
from backend.planner.sampler import load_priors, sample_skeleton
from backend.report.memory_model import remember
from backend.report.writer import llm_report, session_context, template_report

MOTIFS = ["jesters", "machine_elves", "aliens", "luminous_feminine", "insectoid"]
INTENTIONS = {"curiosity": 0.45, "recreation": 0.25, "reflection": 0.2, "spiritual": 0.1}


def sample_intake(rng: np.random.Generator, seed: int) -> dict:
    mix = load_priors()["report"]["dose_mix"]
    doses = list(mix)
    dose = doses[int(rng.choice(len(doses), p=np.array(list(mix.values())) / sum(mix.values())))]
    clip = lambda x, lo, hi: float(np.clip(round(x), lo, hi))  # noqa: E731
    keys = list(INTENTIONS)
    return {
        "room": {"source": "default"},
        "answers": {"clarity": clip(rng.normal(5, 2), 0, 10), "set": clip(rng.normal(0, 2), -5, 5),
                    "absorption": [clip(rng.normal(5, 2), 0, 10) for _ in range(3)],
                    "surrender": clip(rng.normal(5, 2), 0, 10),
                    "intention": keys[int(rng.choice(len(keys), p=list(INTENTIONS.values())))],
                    "expectations": [m for m in MOTIFS if rng.random() < 0.15]},
        "dose_step": dose, "hold_fraction": 1.0,
        "options": {"difficult_passages": bool(rng.random() < 0.85), "eyes": "auto", "audio": True,
                    "microphone": False, "live_diffusion": False},
        "seed": seed,
    }


def run_one(seed: int, rng: np.random.Generator, use_llm: bool) -> dict:
    intake = sample_intake(rng, seed)
    sk = sample_skeleton(intake, seed)
    exp, prov = expand_with_provenance(sk, intake, seed)
    ts = assemble_trip_script(sk, exp, intake, None, planner=prov)
    events = synthesise_events(ts)
    rem = remember(events, seed)
    ctx = session_context(ts, intake, events, rem)
    body, wprov = None, "template"
    if use_llm:
        body = llm_report(ctx, seed)
        wprov = "llm" if body else "template"
    if body is None:
        body = template_report(ctx, seed)
    text = " ".join(p["text"] for p in body["paragraphs"])
    coded = code_report(text)
    _ = synthesise_drawn_curve
    return {"seed": seed, "dose_step": ts["pharmacology"]["dose_step"], "deepest": ctx["deepest"],
            "entities_logged": len(ctx["appear_ids"]), "words": len(text.split()), "target": ctx["length"],
            "planner": prov, "writer": wprov, "coded": coded, "declared": sorted(set(body.get("mentions", [])) & set(CATEGORIES))}


def coder_agreement(rows: list[dict], n: int = 30) -> float:
    """Validate the coder on reports with known contents (the template writer's declared mentions)."""
    rows = [r for r in rows if r["writer"] == "template"][:n]
    if not rows:
        return float("nan")
    agree = total = 0
    for r in rows:
        for c in CATEGORIES:
            total += 1
            agree += (c in r["declared"]) == r["coded"][c]
    return agree / total


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--llm", action="store_true", help="use the language model for expansion and writing if available")
    ap.add_argument("--out", default=str(runtime.ROOT / "verification" / "validation.json"))
    a = ap.parse_args(argv)
    if not a.llm:
        os.environ["HYPERSPACE_FORCE_TEMPLATES"] = "1"
    use_llm = a.llm and not runtime.force_templates()
    rng = np.random.default_rng(a.seed)
    t0 = time.time()
    rows = [run_one(a.seed * 100000 + i, rng, use_llm) for i in range(a.n)]
    dt = time.time() - t0
    rates = {c: float(np.mean([r["coded"][c] for r in rows])) for c in CATEGORIES}
    checks = {}
    for c in CATEGORIES:
        t = TARGETS[c]
        ok = (0.02 <= rates[c] <= 0.12) if c == "profundity" else (t / 1.5 <= rates[c] <= t * 1.5)
        checks[c] = {"rate": round(rates[c], 4), "target": t, "ratio": round(rates[c] / t, 3), "pass": bool(ok)}
    med = float(np.median([r["words"] for r in rows]))
    len_ok = abs(med - 311) <= 0.2 * 311
    agreement = coder_agreement(rows)
    dose_counts = {d: sum(r["dose_step"] == d for r in rows) for d in ("threshold", "light", "strong", "breakthrough")}
    result = {
        "n": a.n, "seconds": round(dt, 1), "coder": "keyword", "coder_agreement": round(agreement, 4),
        "coder_agreement_pass": bool(agreement >= 0.9), "writer": "llm" if use_llm else "template",
        "writer_counts": {w: sum(r["writer"] == w for r in rows) for w in ("llm", "template")},
        "dose_mix": load_priors()["report"]["dose_mix"], "dose_counts": dose_counts,
        "categories": checks, "median_words": med, "median_target": 311, "median_pass": bool(len_ok),
        "all_pass": bool(all(v["pass"] for v in checks.values()) and len_ok),
        "note": "Mention rates are from the keyword coder; acceptance per BUILD.md §14 (×1.5; profundity 2–12 %; median length ±20 %). "
                + ("Small n: sampling error is large." if a.n < 100 else ""),
        "sessions": rows,
    }
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump(result, f, indent=1)
    print(f"Validation: n={a.n}, writer={result['writer']}, {dt:.1f} s, coder agreement {agreement:.1%}")
    print(f"{'category':<12} {'rate':>7} {'target':>7} {'ratio':>6}  pass")
    for c, v in checks.items():
        print(f"{c:<12} {v['rate']:>7.1%} {v['target']:>7.1%} {v['ratio']:>6.2f}  {'yes' if v['pass'] else 'NO'}")
    print(f"{'median words':<12} {med:>7.0f} {311:>7d} {med / 311:>6.2f}  {'yes' if len_ok else 'NO'}")
    print(f"dose counts: {dose_counts}  → {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
