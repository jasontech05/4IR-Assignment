# Kubernetes Guestbook with Prometheus & Grafana

Extends the [Pulumi Kubernetes Guestbook example](https://github.com/pulumi/examples/blob/master/kubernetes-ts-guestbook/README.md) with Prometheus and Grafana monitoring, deployed via Pulumi using Helm charts.

---

## Deploy

**Prerequisites:** [Pulumi CLI](https://www.pulumi.com/docs/install/), Node.js ≥ 18, a running Kubernetes cluster with `kubectl` configured.

```bash
cd simple
npm install

# First time only — use an empty passphrase when prompted
PULUMI_CONFIG_PASSPHRASE="" pulumi stack init dev
PULUMI_CONFIG_PASSPHRASE="" pulumi config set isMinikube false

PULUMI_CONFIG_PASSPHRASE="" pulumi up
```

Deployment takes ~60–90 seconds. Stack outputs are printed on completion:

```
frontendIp          : "172.18.0.x"
grafanaAdminPassword: [secret]
grafanaAdminUsername: "admin"
grafanaUrl          : "http://172.18.0.x:3000"
guestbookUrl        : "http://172.18.0.x"
```

To reveal the admin password:

```bash
PULUMI_CONFIG_PASSPHRASE="" pulumi stack output grafanaAdminPassword --show-secrets
```

---

## Access Grafana

The LoadBalancer IPs are on the internal Docker bridge network. Use port-forward to reach them from your browser:

```bash
kubectl port-forward --address 0.0.0.0 svc/frontend 8080:80 -n default &
kubectl port-forward --address 0.0.0.0 svc/grafana 3000:3000 -n monitoring &
```

| | |
|---|---|
| Guestbook | `http://localhost:8080` |
| Grafana | `http://localhost:3000` |
| Username | `admin` |
| Password | `Fun2day!` |

Grafana opens on the **Guestbook – Kubernetes Pods** dashboard showing CPU, memory, network I/O, and container restart counts for all pods.

---

## Verify Prometheus Is Scraping Guestbook Metrics

**1. Check pod annotations**

```bash
kubectl get pods -n default -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.prometheus\.io/scrape}{"\n"}{end}'
```

Every pod should print `true`.

**2. Query Prometheus**

```bash
kubectl port-forward svc/prometheus-server 9090:80 -n monitoring &

curl -s 'http://localhost:9090/api/v1/query?query=container_cpu_usage_seconds_total{namespace="default"}' \
  | python3 -c "import sys,json; r=json.load(sys.stdin)['data']['result']; print(len(r), 'series found')"
```

A non-zero result confirms the guestbook pods are being scraped.

**3. Check Prometheus Targets UI**

Open `http://localhost:9090/targets` and find the **kubernetes-pods** job — all guestbook pods should show status **UP**.

---

## Tear Down

```bash
PULUMI_CONFIG_PASSPHRASE="" pulumi destroy --yes
```
