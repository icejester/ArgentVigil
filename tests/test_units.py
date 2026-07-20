"""Unit constants convention guard (CLAUDE.md: Cross-cutting data
conventions, "Unit constants") — each canonical value asserted exactly
once, against backend/units.py, the single home the literals were
consolidated into."""

from backend.units import GOLD_CONTRACT_OZ, SILVER_CONTRACT_OZ, TROY_OZ_PER_KG


def test_silver_contract_size():
    assert SILVER_CONTRACT_OZ == 5_000


def test_gold_contract_size():
    assert GOLD_CONTRACT_OZ == 100


def test_troy_oz_per_kg():
    assert TROY_OZ_PER_KG == 32.1507
