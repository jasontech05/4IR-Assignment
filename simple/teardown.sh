#!/usr/bin/env bash
# teardown.sh — Stop port-forwards, destroy all resources, remove the stack.
set -euo pipefail

PASSPHRASE_FILE=".pulumi-passphrase"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Guestbook Teardown                   ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Stop port-forwards ──────────────────────────────────────────────────────
echo "[1/3] Stopping port-forwards..."
if pkill -f "kubectl port-forward" 2>/dev/null; then
    echo "      ✓ Port-forwards stopped."
else
    echo "      No port-forwards were running."
fi

# ── 2. Load passphrase ─────────────────────────────────────────────────────────
if [[ ! -f "$PASSPHRASE_FILE" ]]; then
    echo ""
    echo "Error: $PASSPHRASE_FILE not found."
    echo "Set PULUMI_CONFIG_PASSPHRASE manually and re-run:"
    echo "  export PULUMI_CONFIG_PASSPHRASE=<your-passphrase>"
    exit 1
fi
export PULUMI_CONFIG_PASSPHRASE
PULUMI_CONFIG_PASSPHRASE="$(cat "$PASSPHRASE_FILE")"
echo "      Passphrase loaded."

# ── 3. Destroy resources ───────────────────────────────────────────────────────
echo "[2/3] Destroying Pulumi resources..."
echo ""
pulumi destroy --yes
echo ""

# ── 4. Remove stack ────────────────────────────────────────────────────────────
echo "[3/3] Removing stack..."
pulumi stack rm dev --yes
echo "      ✓ Stack removed."

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Teardown complete. All resources gone.  ║"
echo "╚══════════════════════════════════════════╝"
echo ""
