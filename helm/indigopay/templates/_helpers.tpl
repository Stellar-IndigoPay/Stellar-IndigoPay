{{/*
helm/indigopay/templates/_helpers.tpl

Reusable template helpers. Required by hpa.yaml, pdb.yaml, and any
other template that needs the canonical name or label set.
*/}}

{{- define "indigopay.backendName" -}}
{{- default "backend" .Values.backend.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "indigopay.frontendName" -}}
{{- default "frontend" .Values.frontend.name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every resource rendered by the chart. Mirrors
the labels used in the k8s/ manifests so cluster queries and ArgoCD
discovery work consistently.
*/}}
{{- define "indigopay.labels" -}}
app.kubernetes.io/part-of: indigopay
app.kubernetes.io/managed-by: {{ .Release.Service | default "Helm" }}
app.kubernetes.io/version: {{ .Chart.AppVersion | default "0.1.0" | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}
