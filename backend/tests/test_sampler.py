"""Planner stage one (BUILD.md §9.1, §16.2): frequencies match priors.yaml; seeds reproduce exactly."""
import math
from collections import Counter

import numpy as np
import pytest

from backend.intake_util import normalise
from backend.planner import sampler as S

N = 10_000


def _close(count, n, p, k=4.5):
    sd = math.sqrt(max(p * (1 - p), 1e-9) / n)
    return abs(count / n - p) <= k * sd + 1e-9


@pytest.fixture(scope="module")
def entity_draws():
    rng = np.random.default_rng(12345)
    norm = normalise(None)
    counts = Counter()
    groups = []
    for _ in range(N):
        g = S.sample_entities(rng, norm)
        groups.append(g)
    return groups


def test_entity_count(entity_draws):
    c = Counter(len(g) for g in entity_draws)
    ec = S.load_priors()["entity_count"]
    assert _close(c[1], N, ec["one"])
    assert _close(c[2] + c[3], N, ec["few"])
    assert _close(c[2], N, ec["few"] / 2) and _close(c[3], N, ec["few"] / 2)
    assert _close(c[ec["many_count"]], N, ec["many"])


def test_entity_types_labels_attributes_communication(entity_draws):
    ents = [e for g in entity_draws for e in g]
    n = len(ents)
    table = S.entity_type_table([])
    c = Counter(e["type"] for e in ents)
    assert set(c) <= set(table)
    for t, p in table.items():
        assert _close(c[t], n, p), (t, c[t] / n, p)
    pr = S.load_priors()
    # Lawrence shares: luminous feminine 24.2 %, creatures total 9.2 %, mythological total 8.4 %
    assert abs(table["luminous_feminine"] - 0.242) < 1e-9
    assert abs(sum(v for k, v in table.items() if k.startswith("creature_")) - 0.092) < 1e-9
    assert abs(table["machine_elf"] + table["mythological"] - 0.084) < 1e-9
    labels = pr["labels"]
    p_none = np.prod([1 - p for p in labels.values()])
    for lab, p in labels.items():
        cnt = sum(lab in e["labels"] for e in ents)
        assert _close(cnt, n, p + (p_none if lab == "being" else 0.0)), lab
        assert all(e["label"] in e["labels"] for e in ents)
    for att, p in pr["attributes"].items():
        assert _close(sum(e["attributes"][att] for e in ents), n, p), att
    for k, p in pr["communication"].items():
        assert _close(sum(e["communication"] == k for e in ents), n, p), k
    assert not any(e["disposition"] == "stern" for e in ents)
    assert all(e["behaviours"][0] == "approach" and e["behaviours"][-1] == "depart" for e in ents)


def test_expectations_multiply_weights():
    base = S.entity_type_table([])
    t = S.entity_type_table(["jester", "machine_elf"])
    w = {k: v for k, v in S.load_priors()["entity_types"].items()}
    w["jester"] *= 1.5
    w["machine_elf"] *= 1.5
    tot = sum(w.values())
    for k in base:
        assert abs(t[k] - w[k] / tot) < 1e-12
    rng = np.random.default_rng(7)
    norm = normalise({"answers": {"expectations": ["jesters"]}})
    ents = [e for _ in range(N) for e in S.sample_entities(rng, norm)]
    assert _close(sum(e["type"] == "jester" for e in ents), len(ents), S.entity_type_table(["jester"])["jester"])


def test_message_frequency():
    rng = np.random.default_rng(99)
    for clarity, p in ((5, 0.69), (10, 0.89), (0, 0.49)):
        assert abs(S.message_probability(clarity) - p) < 1e-9
        cnt = sum(S.sample_message(rng, clarity, True)["present"] for _ in range(N))
        assert _close(cnt, N, p)
    assert not any(S.sample_message(rng, 10, False)["present"] for _ in range(200))


def test_difficult_probability():
    assert abs(S.difficult_probability(8.4, 0, 5, "curiosity") - 0.27) < 0.03
    assert S.difficult_probability(2.7, 0, 5, "curiosity") < 0.05
    assert S.difficult_probability(9.5, -5, 0, "curiosity", gentle=True) == 0.0
    x = -2.2 + 0.35 * (7 - 5) - 0.25 * 2 - 0.15 * (8 - 5) - 0.5
    assert abs(S.difficult_probability(7, 2, 8, "recreation") - 1 / (1 + math.exp(-x))) < 1e-12


def test_profundity_overall_rate():
    r = S.load_priors()["report"]
    share = sum(r["dose_mix"][k] * r["breakthrough_share_by_dose"][k] for k in r["dose_mix"])
    overall = share * S.profundity_probability(True) + (1 - share) * S.profundity_probability(False)
    assert abs(overall - 0.061) < 1e-9
    assert S.profundity_probability(True) / S.profundity_probability(False) == pytest.approx(5.0)


def test_encounter_by_layer():
    assert S.encounter_probability("breakthrough") == 0.94
    assert S.encounter_probability("waiting_room") == 0.40
    assert S.encounter_probability("chrysanthemum") == 0.05
    assert S.encounter_probability("form_constants") == 0.0


def test_skeleton_reproducible_and_seed_sensitive():
    intake = {"dose_step": "breakthrough", "answers": {"clarity": 7}}
    a = S.sample_skeleton(intake, 123)
    b = S.sample_skeleton(intake, 123)
    c = S.sample_skeleton(intake, 124)
    assert a == b
    assert a != c


def test_skeleton_fields_and_report_length():
    lengths = []
    for seed in range(300):
        dose = ["threshold", "light", "strong", "breakthrough"][seed % 4]
        sk = S.sample_skeleton({"dose_step": dose, "options": {"difficult_passages": seed % 5 != 0}}, seed)
        ph = sk["pharmacology"]
        assert ph["dose_rel"] == {"threshold": 0.4, "light": 1.0, "strong": 2.0, "breakthrough": 4.0}[dose]
        assert sk["contingency"]["breakthrough_assets"] == (dose in ("strong", "breakthrough"))
        assert 120 <= sk["report"]["length_words"] <= 900
        lengths.append(sk["report"]["length_words"])
        groups = sk["layers"]["chrysanthemum"]["groups"]
        assert len(groups) == 3 and len({tuple(g) for g in groups}) == 3
        assert all(1 / g[0] + 1 / g[1] + 1 / g[2] < 1 for g in groups)
        if seed % 5 == 0:
            assert sk["challenge"]["occurs"] is False and sk["challenge"]["p"] == 0.0
        if sk["challenge"]["occurs"]:
            assert 10 <= sk["challenge"]["onset_offset_s"] <= 60
        if not sk["breakthrough"]["entities"]:
            assert sk["breakthrough"]["message"]["present"] is False
        if dose in ("threshold", "light"):
            assert sk["predicted"]["deepest_layer"] != "breakthrough"
    assert 230 <= float(np.median(lengths)) <= 400


def test_population_layers_breakthrough():
    """Deepest-layer shares at the breakthrough step follow the §7.3 population table (fast PK, 600 draws)."""
    c = Counter(S.sample_skeleton({"dose_step": "breakthrough"}, s)["predicted"]["deepest_layer"] for s in range(600))
    assert abs(c["breakthrough"] / 600 - 0.75) < 0.07
