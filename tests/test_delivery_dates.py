"""Delivery Behavior's First Notice Day / Last Trade Day date rules
(backend/delivery_behavior.py).

The FND rule went through a real mid-build correction (CLAUDE.md, Tab:
Inventory): an early version inferred FND = first business day of the
delivery month; the verified real example — COMEX May 2026 silver, FND
reported April 30, 2026 — proved FND = LAST business day of the PRIOR
month. That verified example is pinned here as the regression anchor."""

from datetime import date

from backend.delivery_behavior import (
    _is_weekday,
    first_notice_day,
    last_business_day,
    last_trade_day,
)


def test_fnd_may_2026_silver_verified_real_example():
    assert first_notice_day(2026, 5) == date(2026, 4, 30)


def test_fnd_is_last_business_day_of_prior_month():
    assert first_notice_day(2026, 6) == last_business_day(2026, 5)
    # Prior month ends on a weekend: May 31 2026 is a Sunday, so the
    # last business day walks back to Friday May 29.
    assert first_notice_day(2026, 6) == date(2026, 5, 29)


def test_fnd_january_crosses_year_boundary():
    assert first_notice_day(2027, 1) == last_business_day(2026, 12)
    assert first_notice_day(2027, 1).year == 2026


def test_last_business_day_weekday_month_end():
    # June 30 2026 is a Tuesday — no walk-back needed.
    assert last_business_day(2026, 6) == date(2026, 6, 30)


def test_last_trade_day_third_last_business_day():
    # COMEX rulebook Ch. 112/113 rule: third-last business day of the
    # delivery month. May 2026: 29th (Fri) is last, 28th (Thu) second,
    # 27th (Wed) third-last.
    assert last_trade_day(2026, 5) == date(2026, 5, 27)


def test_last_trade_day_precedes_month_end():
    ltd = last_trade_day(2026, 7)
    assert ltd < date(2026, 8, 1)
    assert _is_weekday(ltd)


def test_is_weekday():
    assert _is_weekday(date(2026, 7, 20))  # Monday
    assert not _is_weekday(date(2026, 7, 18))  # Saturday
    assert not _is_weekday(date(2026, 7, 19))  # Sunday
