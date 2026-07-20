"""Canonical unit constants — the one home for AV's conversion factors.

Per CLAUDE.md's Cross-cutting data conventions ("Unit constants"): these
used to be duplicated bare literals across main.py/db.py/
delivery_behavior.py, kept identical by hand. Any code needing one now
imports it from here — desync is impossible by construction, and the
test suite asserts each value exactly once.

Deliberately stdlib-free (constants only) so db.py and pipeline-side
consumers can import it without the venv, same constraint db.py itself
carries.
"""

# COMEX contract sizes, troy oz per contract.
SILVER_CONTRACT_OZ = 5_000
GOLD_CONTRACT_OZ = 100

# SHFE reports kg; AV's display convention is troy oz everywhere.
TROY_OZ_PER_KG = 32.1507
