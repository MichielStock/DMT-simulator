"""Shared pytest configuration for backend/tests.

Puts the repository root on sys.path so `import backend.…` works from any working directory, and
offers a few path fixtures. Keep this file small: every test module of every agent loads it.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SCHEMAS = ROOT / "shared" / "schemas"
GOLDEN = ROOT / "shared" / "golden" / "pharmacology.json"


@pytest.fixture(scope="session")
def repo_root() -> Path:
    return ROOT


@pytest.fixture(scope="session")
def schemas_dir() -> Path:
    return SCHEMAS


@pytest.fixture(scope="session")
def golden_path() -> Path:
    return GOLDEN
