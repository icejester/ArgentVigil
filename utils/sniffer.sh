#!/usr/bin/env bash
set -e

VENV_DIR=".venv"

# Create venv if it doesn't exist
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# Activate
source "$VENV_DIR/bin/activate"

# Install deps if not already installed
if ! python -c "import playwright" 2>/dev/null; then
    echo "Installing playwright..."
    pip install --quiet playwright
    echo "Installing Chromium..."
    playwright install chromium
fi

echo "Running sniffer..."
python sniff-metal-charts.py