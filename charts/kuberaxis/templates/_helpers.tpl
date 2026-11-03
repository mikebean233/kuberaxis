{{- define "kuberaxis.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "kuberaxis.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "kuberaxis.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "kuberaxis.labels" -}}
helm.sh/chart: {{ include "kuberaxis.chart" . }}
{{ include "kuberaxis.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "kuberaxis.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kuberaxis.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Component names: api, web, postgresql. */}}
{{- define "kuberaxis.api.fullname" -}}
{{- printf "%s-api" (include "kuberaxis.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "kuberaxis.web.fullname" -}}
{{- printf "%s-web" (include "kuberaxis.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "kuberaxis.postgresql.fullname" -}}
{{- printf "%s-postgresql" (include "kuberaxis.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "kuberaxis.image" -}}
{{- printf "%s:%s" .image.repository (default .root.Chart.AppVersion .image.tag) }}
{{- end }}

{{/*
Database connection settings, resolved from either the bundled PostgreSQL or externalDatabase.
The password is never put in DATABASE_URL; the API gets it through PGPASSWORD, which node-postgres
reads when the URL has none. That keeps special characters in passwords from needing URL encoding.
*/}}
{{- define "kuberaxis.db.host" -}}
{{- if .Values.postgresql.enabled }}
{{- include "kuberaxis.postgresql.fullname" . }}
{{- else }}
{{- required "externalDatabase.host is required when postgresql.enabled is false" .Values.externalDatabase.host }}
{{- end }}
{{- end }}

{{- define "kuberaxis.db.port" -}}
{{- if .Values.postgresql.enabled }}{{ .Values.postgresql.service.port }}{{ else }}{{ .Values.externalDatabase.port }}{{ end }}
{{- end }}

{{- define "kuberaxis.db.auth" -}}
{{- if .Values.postgresql.enabled }}{{ toYaml .Values.postgresql.auth }}{{ else }}{{ toYaml .Values.externalDatabase }}{{ end }}
{{- end }}

{{- define "kuberaxis.db.url" -}}
{{- $auth := include "kuberaxis.db.auth" . | fromYaml }}
{{- $url := printf "postgres://%s@%s:%s/%s" (urlquery $auth.username) (include "kuberaxis.db.host" .) (include "kuberaxis.db.port" .) (urlquery $auth.database) }}
{{- if and (not .Values.postgresql.enabled) .Values.externalDatabase.sslMode }}
{{- $url = printf "%s?sslmode=%s" $url (urlquery .Values.externalDatabase.sslMode) }}
{{- end }}
{{- $url }}
{{- end }}

{{/* Name of the Secret holding the database password. */}}
{{- define "kuberaxis.db.secretName" -}}
{{- $auth := include "kuberaxis.db.auth" . | fromYaml }}
{{- if $auth.existingSecret }}
{{- $auth.existingSecret }}
{{- else if .Values.postgresql.enabled }}
{{- include "kuberaxis.postgresql.fullname" . }}
{{- else }}
{{- printf "%s-external-db" (include "kuberaxis.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "kuberaxis.db.secretKey" -}}
{{- $auth := include "kuberaxis.db.auth" . | fromYaml }}
{{- if $auth.existingSecret }}{{ $auth.existingSecretPasswordKey }}{{ else }}password{{ end }}
{{- end }}
