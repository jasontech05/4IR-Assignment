#!/usr/bin/env bash
# deploy.sh — Deploy Guestbook + Prometheus + Grafana, then start port-forwards and keep them running.
# Press Ctrl+C to stop port-forwards and exit.
set -euo pipefail

PASSPHRASE_FILE=".pulumi-passphrase"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║     Guestbook Deployment                 ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Passphrase ──────────────────────────────────────────────────────────────
if [[ ! -f "$PASSPHRASE_FILE" ]]; then
    echo "[1/4] Generating Pulumi passphrase..."
    openssl rand -base64 24 | tr -d '\n' > "$PASSPHRASE_FILE"
    echo "      ✓ Saved to $PASSPHRASE_FILE — keep this file safe."
else
    echo "[1/4] Passphrase loaded from $PASSPHRASE_FILE"
fi
export PULUMI_CONFIG_PASSPHRASE
PULUMI_CONFIG_PASSPHRASE="$(cat "$PASSPHRASE_FILE")"

# ── 2. Stack init ──────────────────────────────────────────────────────────────
if ! pulumi stack ls 2>/dev/null | grep -q "dev"; then
    echo "[2/4] Initialising Pulumi stack..."
    pulumi stack init dev
    echo "      ✓ Stack 'dev' created."
else
    echo "[2/4] Stack 'dev' already exists — skipping init."
fi

# ── 3. Grafana password ────────────────────────────────────────────────────────
if ! pulumi config get grafanaAdminPassword &>/dev/null; then
    echo "[3/4] Generating Grafana admin password..."
    GRAFANA_PASS="$(openssl rand -base64 18 | tr -d '\n')"
    pulumi config set --secret grafanaAdminPassword "$GRAFANA_PASS"
    echo "      ✓ Password set."
else
    echo "[3/4] Grafana password already configured."
fi

# ── 4. Deploy ──────────────────────────────────────────────────────────────────
echo "[4/4] Deploying stack (first run takes ~90s)..."
echo ""
pulumi up --skip-preview --yes
echo ""

# ── Credentials summary ────────────────────────────────────────────────────────
GRAFANA_PASS="$(pulumi stack output grafanaAdminPassword --show-secrets 2>/dev/null)"
echo "╔══════════════════════════════════════════╗"
echo "║  Deployment Complete                     ║"
echo "╠══════════════════════════════════════════╣"
echo "║  Guestbook → http://localhost:8080       ║"
echo "║  Grafana   → http://localhost:3000       ║"
echo "║  Username  → admin                       ║"
printf  "║  Password  → %-27s║\n" "$GRAFANA_PASS"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── Port-forwards ──────────────────────────────────────────────────────────────
echo "Starting port-forwards..."
pkill -f "kubectl port-forward" 2>/dev/null || true
sleep 1

kubectl port-forward svc/frontend 8080:80 -n default &>/dev/null &
FRONTEND_PID=$!
kubectl port-forward svc/grafana 3000:80 -n monitoring &>/dev/null &
GRAFANA_PID=$!

echo "Port-forwards running (PIDs $FRONTEND_PID $GRAFANA_PID)."
echo "Press Ctrl+C to stop."
echo ""

cleanup() {
    echo ""
    echo "Stopping port-forwards..."
    kill "$FRONTEND_PID" "$GRAFANA_PID" 2>/dev/null || true
    echo "Done."
    exit 0
}
trap cleanup INT TERM

wait "$FRONTEND_PID" "$GRAFANA_PID"
