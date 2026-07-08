"""
Standalone test: claim extraction via Anthropic API (Haiku).

Setup:
    pip install anthropic pydantic
    export ANTHROPIC_API_KEY=sk-...   (or put it in a .env you load yourself)

Run:
    python extract_claims_test.py
"""

import json
import os
import sys
from typing import Optional

from anthropic import Anthropic
from pydantic import BaseModel, ValidationError

MODEL = "claude-haiku-4-5-20251001"

SYSTEM_PROMPT = """You are a claim-extraction engine for a personal research tool. Your only job is to
read a piece of media (an article, post, or transcript) and extract a list of
falsifiable, checkable claims from it. You do not evaluate whether the claims are
true. You do not adopt the source's tone, framing, or conclusions. You are a neutral
extraction layer, not a fact-checker and not a commentator.

## What counts as a falsifiable claim

A falsifiable claim is a specific, testable assertion about the world — something
that either is or isn't the case, and could in principle be checked against data.

Examples of falsifiable claims:
- "COMEX registered silver inventory has fallen by 30% this year"
- "Silver open interest is at a 5-year low"
- "The Fed's balance sheet grew last month"
- "Managed money net-long positioning in silver futures is near an extreme"

Examples of NOT falsifiable claims — do not extract these as claims, but you may
note them separately under "framing_notes" if they shape how the source presents
its argument:
- Predictions ("silver will hit $50 by year end")
- Pure opinion or sentiment ("this is the most bullish setup in a decade")
- Vague alarm without a specific assertion ("the system is breaking down")
- Rhetorical questions or implications without a stated claim

## What to do with each claim you find

For every falsifiable claim, extract:
1. `claim_text` — a neutral, factual restatement of the claim, stripped of the
   source's original rhetorical framing. Do not use the source's loaded language.
2. `category` — pick the single best fit from this fixed list:
   - `cot_positioning` (futures positioning, managed money, commercial hedgers, open interest)
   - `exchange_inventory` (COMEX/SHFE/PSLV registered or eligible stock, vault levels, withdrawals)
   - `money_supply` (M2, Fed balance sheet, CPI, purchasing power)
   - `market_balance` (annual supply/demand, mine production, industrial demand, deficits)
   - `price_action` (spot or futures price levels or moves)
   - `other_unverifiable` (a real falsifiable claim, but not something the categories
     above cover — e.g. a claim about a specific bank's vault holdings, a claim about
     a foreign central bank's action)
3. `specific_assertion` — the precise, narrow version of what would have to be true
   for this claim to hold. Be as specific as the source allows (a number, a direction,
   a timeframe). If the source is vague, say so rather than inventing specificity.
4. `timeframe` — the period the claim refers to, if stated or reasonably inferable
   (e.g. "past 12 months," "as of publication," "since 2020"). Use "unspecified" if
   the source gives no indication.
5. `source_quote_short` — at most one short supporting phrase from the source (under
   15 words), only if needed to disambiguate the claim. Omit if not necessary.

## What NOT to do

- Do not rate, score, or flag claims as likely true or false.
- Do not add commentary, hedging, or your own interpretation of significance.
- Do not summarize the article's overall argument or thesis — extract discrete claims only.
- Do not infer claims the source doesn't actually make, even if they seem implied.
- Do not merge multiple distinct claims into one entry — split them.
- Do not extract the same claim twice if the source repeats it.

## Output format

Return ONLY valid JSON, no preamble, no markdown fences, matching this shape:

{
  "source_title": "<title if known, else null>",
  "source_url": "<url if provided, else null>",
  "claims": [
    {
      "claim_id": "c1",
      "claim_text": "...",
      "category": "...",
      "specific_assertion": "...",
      "timeframe": "...",
      "source_quote_short": "..."
    }
  ],
  "framing_notes": "<one or two sentences, neutral, describing the source's overall
    rhetorical posture — this is descriptive of the source's framing, not your own
    assessment of the underlying claims>",
  "unverifiable_content_summary": "<brief note on any significant non-falsifiable
    content in the piece — predictions, opinion, sentiment — that didn't produce
    claims but is worth knowing about>"
}

If the source contains no falsifiable claims at all, return an empty "claims" array
and explain why in "unverifiable_content_summary" — do not force claims that aren't there."""


class Claim(BaseModel):
    claim_id: str
    claim_text: str
    category: str
    specific_assertion: str
    timeframe: str
    source_quote_short: Optional[str] = None


class ExtractionResult(BaseModel):
    source_title: Optional[str] = None
    source_url: Optional[str] = None
    claims: list[Claim]
    framing_notes: str
    unverifiable_content_summary: str


VALID_CATEGORIES = {
    "cot_positioning",
    "exchange_inventory",
    "money_supply",
    "market_balance",
    "price_action",
    "other_unverifiable",
}


def strip_markdown_fences(text: str) -> str:
    """Strip ```json ... ``` or ``` ... ``` fences if the model added them
    despite instructions not to."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = lines[1:]  # drop opening fence (```json or ```)
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]  # drop closing fence
        text = "\n".join(lines).strip()
    return text


def extract_claims(client: Anthropic, article_text: str) -> ExtractionResult:
    response = client.messages.create(
        model=MODEL,
        max_tokens=2000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": article_text}],
    )
    raw_text = strip_markdown_fences(response.content[0].text)

    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as e:
        raise ValueError(f"Model did not return valid JSON: {e}\n---RAW---\n{raw_text}")

    result = ExtractionResult.model_validate(data)

    # Flag anything the schema alone won't catch
    for c in result.claims:
        if c.category not in VALID_CATEGORIES:
            print(f"  ⚠ claim {c.claim_id}: unrecognized category '{c.category}'")

    return result


TEST_ARTICLES = [
    (
        "comex_bled_dry",
        """The dollar is dying and nobody in Washington will admit it. While bureaucrats debate rate cuts in air-conditioned boardrooms, the silver market is quietly signaling something catastrophic: registered COMEX inventories have been bled dry by industrial demand and Asian accumulation, and when the paper market finally breaks against physical reality, the price discovery event will be violent and irreversible. Anyone still holding cash equivalents when that moment arrives will watch decades of purchasing power evaporate in a matter of weeks.""",
    ),
    (
        "rome_denarius",
        """Every dollar printed since 1971 has been a slow-motion theft from savers, and the acceleration is no longer slow. Debt-to-GDP ratios that would have triggered a currency crisis in any other nation are being waved away as "sustainable" by the same institutions that guaranteed inflation was "transitory." History does not forgive fiat experiments — Rome debased its silver denarius until the empire collapsed under its own currency, and the parallels to today's monetary policy are not subtle. The window to convert depreciating paper into real, tangible metal is closing faster than most people realize.""",
    ),
]


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("ANTHROPIC_API_KEY not set in environment.")
        sys.exit(1)

    client = Anthropic(api_key=api_key)

    for name, text in TEST_ARTICLES:
        print(f"\n{'=' * 60}\n{name}\n{'=' * 60}")
        try:
            result = extract_claims(client, text)
        except (ValueError, ValidationError) as e:
            print(f"FAILED: {e}")
            continue

        print(f"Claims extracted: {len(result.claims)}")
        for c in result.claims:
            print(f"  [{c.claim_id}] ({c.category}) {c.claim_text}")
            print(f"      -> {c.specific_assertion}  [{c.timeframe}]")
        print(f"\nFraming notes: {result.framing_notes}")
        print(f"Unverifiable summary: {result.unverifiable_content_summary}")


if __name__ == "__main__":
    main()
