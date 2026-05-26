// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

// NodePort services are used so that the app is reachable directly on
// localhost:<nodePort> without requiring `kubectl port-forward`.
// Kubernetes auto-assigns ports from the 30000–32767 range, avoiding
// conflicts with common ports like 3000 or 8080.
const config = new pulumi.Config();

// ============================================================
// MONITORING NAMESPACE
// ============================================================

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
});

//
// REDIS LEADER.
//

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: {
                labels: redisLeaderLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "6379",
                },
            },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379 }],
                    },
                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: redisLeaderDeployment.metadata.labels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

//
// REDIS REPLICA.
//

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: {
                labels: redisReplicaLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "6379",
                },
            },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        // If your cluster config does not include a dns service, then to instead access an environment
                        // variable to find the leader's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },
                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: redisReplicaDeployment.metadata.labels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

//
// FRONTEND
//

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: {
                labels: frontendLabels,
                annotations: {
                    // Enable Prometheus scraping for the frontend service.
                    // The guestbook-php-redis image does not expose /metrics by default,
                    // but these annotations allow Prometheus to discover the pod and
                    // collect any available HTTP-level metrics.
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "80",
                    "prometheus.io/path": "/metrics",
                },
            },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        // If your cluster config does not include a dns service, then to instead access an environment
                        // variable to find the master service's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" /* value: "env"*/ }],
                        ports: [{ containerPort: 80 }],
                    },
                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        labels: frontendDeployment.metadata.labels,
        name: "frontend",
    },
    spec: {
        // NodePort: Kubernetes auto-assigns an unused port in 30000–32767.
        // Accessible at http://localhost:<nodePort> with no port-forwarding.
        type: "NodePort",
        ports: [{ port: 80, targetPort: 80 }],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
});

// Read the auto-assigned NodePort so we can output the exact URL.
export const frontendNodePort = frontendService.spec.ports[0].nodePort;
// On KinD/WSL2, NodePorts are not reachable on localhost — access via port-forward.
export const guestbookUrl = "http://localhost:8080";  // kubectl port-forward svc/frontend 8080:80

// ============================================================
// PROMETHEUS  (prometheus-community/prometheus Helm chart)
// ============================================================
//
// The chart's default configuration already includes a `kubernetes-pods`
// scrape job that discovers pods annotated with:
//   prometheus.io/scrape: "true"
//   prometheus.io/port:   "<port>"
//   prometheus.io/path:   "<path>"  (optional, defaults to /metrics)
//
// The guestbook pod templates above carry those annotations so Prometheus
// will automatically collect their metrics.

const prometheus = new k8s.helm.v3.Release("prometheus", {
    name: "prometheus",
    chart: "prometheus",
    repositoryOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
    },
    namespace: monitoringNamespace.metadata.name,
    values: {
        alertmanager: { enabled: false },
        "prometheus-pushgateway": { enabled: false },
        server: {
            service: { type: "ClusterIP" },
            // Retain data for 15 days (default).
            retention: "15d",
        },
    },
}, { dependsOn: monitoringNamespace });

// Internal cluster URL used as the Grafana data source endpoint.
const prometheusServerUrl = pulumi.interpolate`http://prometheus-server.${monitoringNamespace.metadata.name}.svc.cluster.local`;

// ============================================================
// GRAFANA  (grafana/grafana Helm chart)
// ============================================================

// Admin password is auto-generated by deploy.sh and stored as a Pulumi secret config.
const grafanaAdminPassword = config.requireSecret("grafanaAdminPassword");

// Custom dashboard JSON for Guestbook pod monitoring.
// Uses the modern `pod` label (not the old `pod_name`) that cAdvisor emits on
// Kubernetes 1.16+, so CPU and Memory panels populate correctly.
const guestbookDashboardJson = JSON.stringify({
    title: "Guestbook - Kubernetes Pods",
    uid: "guestbook-pods",
    schemaVersion: 38,
    version: 1,
    refresh: "30s",
    graphTooltip: 1,
    panels: [
        {
            id: 1, type: "timeseries",
            title: "CPU Usage (cores)",
            gridPos: { h: 8, w: 12, x: 0, y: 0 },
            datasource: { type: "prometheus", uid: "prometheus" },
            fieldConfig: { defaults: { unit: "short", custom: { lineWidth: 2 } }, overrides: [] },
            options: { tooltip: { mode: "multi", sort: "desc" }, legend: { displayMode: "table", placement: "bottom" } },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "prometheus" },
                expr: "sum(rate(container_cpu_usage_seconds_total{namespace=~\"$namespace\",pod=~\"$pod\",container!=\"\",image!=\"\"}[5m])) by (pod)",
                legendFormat: "{{pod}}",
            }],
        },
        {
            id: 2, type: "timeseries",
            title: "Memory Usage (bytes)",
            gridPos: { h: 8, w: 12, x: 12, y: 0 },
            datasource: { type: "prometheus", uid: "prometheus" },
            fieldConfig: { defaults: { unit: "bytes", custom: { lineWidth: 2 } }, overrides: [] },
            options: { tooltip: { mode: "multi", sort: "desc" }, legend: { displayMode: "table", placement: "bottom" } },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "prometheus" },
                expr: "sum(container_memory_working_set_bytes{namespace=~\"$namespace\",pod=~\"$pod\",container!=\"\",image!=\"\"}) by (pod)",
                legendFormat: "{{pod}}",
            }],
        },
        {
            id: 3, type: "timeseries",
            title: "Network RX (bytes/s)",
            gridPos: { h: 8, w: 12, x: 0, y: 8 },
            datasource: { type: "prometheus", uid: "prometheus" },
            fieldConfig: { defaults: { unit: "Bps", custom: { lineWidth: 2 } }, overrides: [] },
            options: { tooltip: { mode: "multi", sort: "desc" }, legend: { displayMode: "table", placement: "bottom" } },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "prometheus" },
                expr: "sum(rate(container_network_receive_bytes_total{namespace=~\"$namespace\",pod=~\"$pod\"}[5m])) by (pod)",
                legendFormat: "{{pod}}",
            }],
        },
        {
            id: 4, type: "timeseries",
            title: "Network TX (bytes/s)",
            gridPos: { h: 8, w: 12, x: 12, y: 8 },
            datasource: { type: "prometheus", uid: "prometheus" },
            fieldConfig: { defaults: { unit: "Bps", custom: { lineWidth: 2 } }, overrides: [] },
            options: { tooltip: { mode: "multi", sort: "desc" }, legend: { displayMode: "table", placement: "bottom" } },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "prometheus" },
                expr: "sum(rate(container_network_transmit_bytes_total{namespace=~\"$namespace\",pod=~\"$pod\"}[5m])) by (pod)",
                legendFormat: "{{pod}}",
            }],
        },
        {
            id: 5, type: "timeseries",
            title: "Container Restarts",
            gridPos: { h: 8, w: 24, x: 0, y: 16 },
            datasource: { type: "prometheus", uid: "prometheus" },
            fieldConfig: { defaults: { unit: "short", custom: { lineWidth: 2 } }, overrides: [] },
            options: { tooltip: { mode: "multi", sort: "desc" }, legend: { displayMode: "table", placement: "bottom" } },
            targets: [{
                refId: "A",
                datasource: { type: "prometheus", uid: "prometheus" },
                expr: "sum(increase(kube_pod_container_status_restarts_total{namespace=~\"$namespace\",pod=~\"$pod\"}[1h])) by (pod, container)",
                legendFormat: "{{pod}} / {{container}}",
            }],
        },
    ],
    templating: {
        list: [
            // "datasource" type variable: lets users switch datasources from the UI.
            // current is pre-seeded with the provisioned Prometheus datasource UID.
            {
                name: "datasource", type: "datasource", pluginId: "prometheus",
                label: "Datasource", hide: 0,
                current: { selected: true, text: "Prometheus", value: "prometheus" },
                refresh: 1, query: "prometheus", options: [], multi: false, includeAll: false,
            },
            {
                name: "namespace", type: "query", label: "Namespace",
                datasource: { type: "prometheus", uid: "prometheus" },
                definition: "label_values(kube_pod_info, namespace)",
                query: { query: "label_values(kube_pod_info, namespace)", refId: "StandardVariableQuery" },
                current: { value: "default", text: "default" },
                refresh: 2, sort: 1, multi: false, includeAll: false,
            },
            {
                name: "pod", type: "query", label: "Pod",
                datasource: { type: "prometheus", uid: "prometheus" },
                definition: "label_values(kube_pod_info{namespace=~\"$namespace\"}, pod)",
                query: { query: "label_values(kube_pod_info{namespace=~\"$namespace\"}, pod)", refId: "StandardVariableQuery" },
                current: { value: "$__all", text: "All" },
                refresh: 2, sort: 1, multi: true, includeAll: true,
            },
        ],
    },
    time: { from: "now-1h", to: "now" },
    timepicker: {},
    timezone: "browser",
});

const grafana = new k8s.helm.v3.Release("grafana", {
    name: "grafana",
    chart: "grafana",
    repositoryOpts: {
        repo: "https://grafana.github.io/helm-charts",
    },
    namespace: monitoringNamespace.metadata.name,
    values: {
        adminUser: "admin",
        adminPassword: grafanaAdminPassword,
        service: {
            // NodePort with a fixed port so the URL is known at deploy time
            // without needing a Service.get lookup.
            type: "NodePort",
            nodePort: 31300,
        },
        // Set the custom dashboard as the home dashboard shown after login.
        "grafana.ini": {
            dashboards: {
                default_home_dashboard_path: "/var/lib/grafana/dashboards/default/guestbook-pods.json",
            },
        },
        // Pre-configure the Prometheus data source.
        datasources: {
            "datasources.yaml": {
                apiVersion: 1,
                datasources: [
                    {
                        name: "Prometheus",
                        type: "prometheus",
                        uid: "prometheus",
                        url: prometheusServerUrl,
                        access: "proxy",
                        isDefault: true,
                    },
                ],
            },
        },
        // Provision a dashboard provider so Grafana can load dashboards from disk.
        dashboardProviders: {
            "dashboardproviders.yaml": {
                apiVersion: 1,
                providers: [
                    {
                        name: "default",
                        orgId: 1,
                        folder: "Guestbook",
                        type: "file",
                        disableDeletion: false,
                        editable: true,
                        options: { path: "/var/lib/grafana/dashboards/default" },
                    },
                ],
            },
        },
        // Custom dashboard using correct `pod` labels for Kubernetes 1.16+.
        dashboards: {
            default: {
                "guestbook-pods": {
                    json: guestbookDashboardJson,
                },
            },
        },
    },
}, { dependsOn: [monitoringNamespace, prometheus] });

// ============================================================
// OUTPUTS
// ============================================================

// Grafana NodePort is fixed at 31300 — accessible at http://localhost:31300
export const grafanaUrl = "http://localhost:3000";   // kubectl port-forward svc/grafana 3000:80
export const grafanaAdminUsername = "admin";
export { grafanaAdminPassword };