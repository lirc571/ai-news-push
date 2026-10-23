#!/usr/bin/env bash
# 触发 GitHub Actions 的 workflow_dispatch（本机 cron 用，绕开不可靠的 GitHub schedule）
#
# 用法：
#   scripts/dispatch.sh                      # 用默认 repo/workflow/ref
#   REPO=owner/name WORKFLOW=foo.yml scripts/dispatch.sh
#
# Token 来源（按优先级）：
#   1. 环境变量 GH_PAT
#   2. $GH_PAT_FILE（默认 ~/.config/ai-news-push/gh_pat）
# 需要 fine-grained PAT，权限 Actions: Read and write，且只授权这一个仓库。

set -euo pipefail

REPO="${REPO:-lirc571/ai-news-push}"
WORKFLOW="${WORKFLOW:-codex-resets.yml}"
REF="${REF:-main}"
API="${API:-https://api.github.com}"
PAT_FILE="${GH_PAT_FILE:-$HOME/.config/ai-news-push/gh_pat}"
LOG="${LOG:-$HOME/.cache/ai-news-push/dispatch.log}"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

token="${GH_PAT:-}"
if [[ -z "$token" ]]; then
  if [[ -r "$PAT_FILE" ]]; then
    token="$(tr -d '[:space:]' <"$PAT_FILE")"
  else
    log "ERROR: no token (set GH_PAT or create $PAT_FILE)"
    exit 78
  fi
fi
[[ -n "$token" ]] || { log "ERROR: token is empty"; exit 78; }

url="$API/repos/$REPO/actions/workflows/$WORKFLOW/dispatches"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT

code="$(curl -sS --max-time 20 -o "$body" -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $token" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d "{\"ref\":\"$REF\"}" \
  "$url")" || { log "ERROR: curl failed for $REPO/$WORKFLOW"; exit 1; }

case "$code" in
  204)
    log "OK 204 dispatched $REPO/$WORKFLOW ref=$REF"
    ;;
  401)
    log "ERROR 401 bad/expired token"
    exit 1
    ;;
  403)
    log "ERROR 403 token lacks Actions:write or repo not authorized: $(head -c 300 "$body")"
    exit 1
    ;;
  404)
    log "ERROR 404 repo/workflow/ref not found (or token cannot see it): $(head -c 300 "$body")"
    exit 1
    ;;
  *)
    log "ERROR $code: $(head -c 300 "$body")"
    exit 1
    ;;
esac
