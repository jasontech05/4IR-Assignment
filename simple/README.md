# Kubernetes Guestbook with Prometheus & Grafana

## Deploy

**Prerequisites:** [Pulumi CLI](https://www.pulumi.com/docs/install/), Node.js ≥ 18, a running Kubernetes cluster with `kubectl` configured.

```bash
cd simple
npm install
./deploy.sh
```

`deploy.sh` auto-generates a secure passphrase and Grafana admin password on first run, deploys the full stack, and keeps port-forwards running. Press **Ctrl+C** to stop.

---

## Grafana

| | |
|---|---|
| URL | `http://localhost:3000` |
| Username | `admin` |
| Password | printed to terminal by `deploy.sh` |

To retrieve the password at any time:

```bash
export PULUMI_CONFIG_PASSPHRASE="$(cat .pulumi-passphrase)"
pulumi stack output grafanaAdminPassword --show-secrets
```

The **Guestbook – Kubernetes Pods** dashboard loads automatically on login. Use the **Namespace** and **Pod** dropdowns at the top to filter by namespace or individual pod.

| Panel | What it shows |
|---|---|
| CPU Usage (cores) | Per-pod CPU consumption over time |
| Memory Usage (bytes) | Per-pod working set memory |
| Network RX (bytes/s) | Inbound network traffic per pod |
| Network TX (bytes/s) | Outbound network traffic per pod |
| Container Restarts | Restart count per container over the last hour |

---

## Verify Prometheus Is Scraping

```bash
kubectl port-forward svc/prometheus-server 9090:80 -n monitoring &

curl -s 'http://localhost:9090/api/v1/query?query=container_cpu_usage_seconds_total{namespace="default"}' \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['data']['result']; print(len(r), 'series found')"
```

A non-zero result confirms the guestbook pods are being scraped. Open `http://localhost:9090/targets` to see the **kubernetes-pods** job status.

---

## Tear Down

```bash
./teardown.sh
```

Stops port-forwards, destroys all Kubernetes resources, and removes the Pulumi stack.

