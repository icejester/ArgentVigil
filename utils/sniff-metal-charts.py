#!/usr/bin/env python3
"""
sniff_metalcharts.py

Opens metalcharts.org/comex/silver in a headless browser, waits for the
JS to load and fire its data requests, then prints every API/XHR/fetch
call it captured — URL, method, status, and a preview of the response body.

Requirements:
    pip install playwright
    playwright install chromium

Run:
    python sniff_metalcharts.py

Optional: pipe to a file for easier reading:
    python sniff_metalcharts.py > metalcharts_api_calls.txt
"""

import json
import asyncio
from playwright.async_api import async_playwright

TARGET_URL = "https://metalcharts.org/comex/silver"

# How long to wait after page load for async data fetches to complete (seconds)
WAIT_AFTER_LOAD = 8

# Only capture these resource types (skip images, fonts, css, etc.)
CAPTURE_TYPES = {"fetch", "xhr"}

# Skip obviously irrelevant domains
SKIP_DOMAINS = {
    "googletagmanager.com",
    "google-analytics.com",
    "googlesyndication.com",
    "doubleclick.net",
    "adservice.google.com",
    "pagead2.googlesyndication.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
}


def should_skip(url: str) -> bool:
    return any(domain in url for domain in SKIP_DOMAINS)


async def sniff():
    captured = []

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        )
        page = await context.new_page()

        # Intercept every request/response pair
        async def on_response(response):
            req = response.request
            if req.resource_type not in CAPTURE_TYPES:
                return
            url = response.url
            if should_skip(url):
                return

            body_preview = ""
            try:
                body = await response.body()
                text = body.decode("utf-8", errors="replace")
                # Try to pretty-print JSON, otherwise just truncate
                try:
                    parsed = json.loads(text)
                    body_preview = json.dumps(parsed, indent=2)[:2000]
                except Exception:
                    body_preview = text[:2000]
            except Exception as e:
                body_preview = f"[could not read body: {e}]"

            # Capture request headers — this is where tokens live
            try:
                req_headers = dict(req.headers)
            except Exception:
                req_headers = {}

            captured.append({
                "method": req.method,
                "url": url,
                "status": response.status,
                "request_headers": req_headers,
                "body_preview": body_preview,
            })

        page.on("response", on_response)

        print(f"Loading {TARGET_URL} ...")
        await page.goto(TARGET_URL, wait_until="networkidle", timeout=30000)

        # Extra wait for lazy/deferred fetches
        print(f"Waiting {WAIT_AFTER_LOAD}s for deferred API calls ...")
        await asyncio.sleep(WAIT_AFTER_LOAD)

        await browser.close()

    # Output results
    print(f"\n{'='*60}")
    print(f"Captured {len(captured)} API/XHR/fetch calls")
    print(f"{'='*60}\n")

    for i, call in enumerate(captured, 1):
        print(f"[{i}] {call['method']} {call['url']}")
        print(f"    Status: {call['status']}")
        if call.get("request_headers"):
            print(f"    Request headers:")
            for k, v in call["request_headers"].items():
                # Highlight anything that looks like a token/auth header
                flag = " <-- TOKEN?" if any(x in k.lower() for x in
                    ["auth", "token", "csrf", "x-", "bearer", "secret", "key"]) else ""
                print(f"      {k}: {v}{flag}")
        print(f"    Response preview:")
        for line in call["body_preview"].splitlines():
            print(f"      {line}")
        print()

    # Also dump a clean list of just the URLs for easy scanning
    print(f"\n{'='*60}")
    print("Clean URL list:")
    print(f"{'='*60}")
    for call in captured:
        print(f"  {call['method']:6s}  {call['url']}")


if __name__ == "__main__":
    asyncio.run(sniff())