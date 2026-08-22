#!/usr/bin/env bash
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

step=0
total_steps=11

progress() {
  ((++step))
  echo -e "\n${BOLD}[${step}/${total_steps}]${RESET} $1"
}

# --- private writes ------------------------------------------------------
# EXTRACTED VERBATIM AND EXECUTED by
# packages/core/src/shared/setup-sh-private-writes.test.ts, between the marker
# lines above and below. Keep the markers.
#
# WHY THIS IS NOT A PLAIN `mkdir -p` + `cat >`. Those obey the process umask, so
# under the common `umask 022` this script created `~/.email-agent` at 0755 and
# wrote `oauth.json` — the Google client id AND client secret — at 0644, readable
# by every other local user. Nothing in the app ever rewrote that file, so unlike
# `settings.json` it stayed loose forever. This is the bash twin of
# `packages/core/src/shared/private-files.ts`, and it deliberately makes the same
# two choices: the temp file is created tight and renamed into place, so the
# bytes are never on disk at a loose mode even for an instant, and the directory
# is chmod-ed unconditionally, because `mkdir` leaves an existing 0755 directory
# exactly as it found it.
ensure_private_dir() {
  mkdir -p "$1"
  chmod 700 "$1"
}

# write_private_file <path>  — body on stdin.
write_private_file() {
  local path="$1"
  local dir
  dir="$(dirname "$path")"
  ensure_private_dir "$dir"
  local tmp
  tmp="$(mktemp "$dir/.setup.XXXXXX")"
  chmod 600 "$tmp"
  cat > "$tmp"
  mv "$tmp" "$path"
}
# --- end private writes --------------------------------------------------

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}!${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; exit 1; }

echo -e "${BOLD}"
echo "  ╔══════════════════════════════════╗"
echo "  ║       Email Agent Setup           ║"
echo "  ╚══════════════════════════════════╝"
echo -e "${RESET}"

# ─── 1. Check Node.js ────────────────────────────────────────────────
progress "Checking Node.js..."

if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install v22.18+: https://nodejs.org"
fi

# v22.18+ required for unflagged TypeScript type stripping (default on in Node
# 22.18 / 23.6+): the native ESM loader uses it to import the BUILT-IN
# .action.ts files when running from source, and process.loadEnvFile needs the
# same floor. User-created .action.ts files are parsed as data, never imported,
# so they no longer depend on type stripping at all.
# Note the gap: 23.0-23.5 are NEWER than 22.18 but still lack unflagged
# stripping, so a plain ">= 22.18" test would wave them through.
NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
NODE_MINOR=$(node -v | sed 's/v//' | cut -d. -f2)
if [ "$NODE_MAJOR" -lt 22 ] ||
  { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 18 ]; } ||
  { [ "$NODE_MAJOR" -eq 23 ] && [ "$NODE_MINOR" -lt 6 ]; }; then
  fail "Node.js v22.18+ or v23.6+ required (found $(node -v))"
fi
ok "Node.js $(node -v)"

if ! command -v npm &>/dev/null; then
  fail "npm not found"
fi
ok "npm $(npm -v)"

# ─── 2. Check gcloud CLI ─────────────────────────────────────────────
progress "Checking Google Cloud CLI..."

if ! command -v gcloud &>/dev/null; then
  fail "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install"
fi
ok "gcloud $(gcloud version 2>/dev/null | head -1 | awk '{print $NF}')"

# ─── 3. Install dependencies ─────────────────────────────────────────
progress "Installing npm dependencies..."

npm install --no-audit --no-fund 2>&1 | tail -3
ok "Dependencies installed"

# ─── 4. Configure .env ───────────────────────────────────────────────
progress "Configuring environment (.env)..."

if [ -f .env ]; then
  ok ".env already exists"
else
  if [ -f .env.example ]; then
    cp .env.example .env
    ok "Created .env from .env.example"
  else
    fail ".env.example not found — cannot create .env"
  fi
fi

# Helper: write a value into .env (replaces existing or appends)
set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

# ── Embedding provider ──
while true; do
  echo ""
  echo -e "  ${BOLD}Embedding provider:${RESET}"
  echo -e "    1) ${CYAN}openrouter${RESET}  — OpenRouter Qwen3 Embedding 8B (best quality, recommended)"
  echo -e "    2) ${CYAN}openai${RESET}      — OpenAI text-embedding-3-small"
  echo -e "    3) ${CYAN}local${RESET}       — Deterministic lexical embeddings (no API key needed)"
  echo ""
  read -rp "  Choose [1/2/3] (default: 1): " embed_choice
  embed_choice=${embed_choice:-1}

  if [ "$embed_choice" = "3" ]; then
    EMBEDDING_PROVIDER="local"
    EMBEDDING_MODEL="local-hashed-v1"
    ok "Embedding provider: local (deterministic lexical embeddings)"
    break

  elif [ "$embed_choice" = "2" ]; then
    EMBEDDING_PROVIDER="openai"
    EMBEDDING_MODEL="text-embedding-3-small"
    ok "Embedding provider: openai"

    # Prompt for OpenAI key if not already set
    EXISTING_OPENAI_KEY=$(grep "^OPENAI_API_KEY=" .env 2>/dev/null | sed 's/^OPENAI_API_KEY=//' || true)
    if [ -n "$EXISTING_OPENAI_KEY" ]; then
      ok "OPENAI_API_KEY already set in .env"
      break
    else
      echo ""
      read -rp "  Enter your OpenAI API key (for embeddings): " openai_key
      if [ -n "$openai_key" ]; then
        set_env "OPENAI_API_KEY" "$openai_key"
        ok "OPENAI_API_KEY saved to .env"
        break
      else
        warn "No key entered — returning to provider selection"
      fi
    fi

  else
    EMBEDDING_PROVIDER="openrouter"
    EMBEDDING_MODEL="qwen/qwen3-embedding-8b"
    ok "Embedding provider: openrouter (${EMBEDDING_MODEL})"

    # Prompt for OpenRouter key if not already set
    EXISTING_OR_KEY=$(grep "^OPENROUTER_API_KEY=" .env 2>/dev/null | sed 's/^OPENROUTER_API_KEY=//' || true)
    if [ -n "$EXISTING_OR_KEY" ]; then
      ok "OPENROUTER_API_KEY already set in .env"
      break
    else
      echo ""
      read -rp "  Enter your OpenRouter API key: " openrouter_key
      if [ -n "$openrouter_key" ]; then
        set_env "OPENROUTER_API_KEY" "$openrouter_key"
        ok "OPENROUTER_API_KEY saved to .env"
        break
      else
        warn "No key entered — returning to provider selection"
      fi
    fi
  fi
done
# EMBEDDING_PROVIDER is persisted into settings.json below; no env var is read.

# ── Agent mode ──
echo ""
echo -e "  ${BOLD}Agent mode:${RESET}"
echo -e "    1) ${CYAN}all-agents${RESET}  — Use installed CLI agents (Claude/Codex/Gemini)"
echo -e "    2) ${CYAN}direct-api${RESET} — Use API keys directly (no CLI agents needed)"
echo -e "    3) ${CYAN}hybrid${RESET}     — Try CLIs first, fall back to API keys"
echo ""
read -rp "  Choose [1/2/3] (default: 1): " agent_choice
agent_choice=${agent_choice:-1}

case "$agent_choice" in
  2) AGENT_MODE="direct-api" ;;
  3) AGENT_MODE="hybrid" ;;
  *) AGENT_MODE="all-agents" ;;
esac
# Agent mode is runtime config — it's written to settings.json below (agentMode),
# not to .env, which is only loaded for API keys / embedding provider.
ok "Agent mode: ${AGENT_MODE}"

# ── API keys for direct-api / hybrid ──
if [ "$AGENT_MODE" = "direct-api" ] || [ "$AGENT_MODE" = "hybrid" ]; then
  echo ""
  echo -e "  ${BOLD}API keys for ${AGENT_MODE} mode:${RESET}"
  echo -e "  ${DIM}Press Enter to skip any key you don't have yet.${RESET}"

  # Anthropic
  EXISTING_ANTHROPIC=$(grep "^ANTHROPIC_API_KEY=" .env 2>/dev/null | sed 's/^ANTHROPIC_API_KEY=//' || true)
  if [ -n "$EXISTING_ANTHROPIC" ]; then
    ok "ANTHROPIC_API_KEY already set"
  else
    echo ""
    read -rsp "  Anthropic API key: " anthropic_key
    echo ""
    if [ -n "$anthropic_key" ]; then
      set_env "ANTHROPIC_API_KEY" "$anthropic_key"
      ok "ANTHROPIC_API_KEY saved"
    else
      warn "Skipped ANTHROPIC_API_KEY"
    fi
  fi

  # OpenAI (may already be set from embeddings step)
  EXISTING_OPENAI=$(grep "^OPENAI_API_KEY=" .env 2>/dev/null | sed 's/^OPENAI_API_KEY=//' || true)
  if [ -n "$EXISTING_OPENAI" ]; then
    ok "OPENAI_API_KEY already set"
  else
    echo ""
    read -rsp "  OpenAI API key: " openai_key2
    echo ""
    if [ -n "$openai_key2" ]; then
      set_env "OPENAI_API_KEY" "$openai_key2"
      ok "OPENAI_API_KEY saved"
    else
      warn "Skipped OPENAI_API_KEY"
    fi
  fi

fi

ok "Environment configured"

# ─── 5. Build core package ───────────────────────────────────────────
progress "Building core package..."

npx tsc -p packages/core/tsconfig.json 2>&1
ok "Core package built (dist/ generated)"

# ─── 6. Build CLI package + re-link bins ──────────────────────────────
progress "Building CLI package..."

npx tsc -p packages/cli/tsconfig.json 2>&1
ok "CLI package built"

# Re-link workspace bins so npx email-agent resolves
npm install --no-audit --no-fund --ignore-scripts 2>&1 | tail -1
ok "Workspace bins linked"

# ─── 7. Authenticate with Google Cloud ────────────────────────────────
progress "Google Cloud authentication..."

SCOPES="https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.modify"

if gcloud auth application-default print-access-token &>/dev/null 2>&1; then
  ok "Already authenticated (ADC credentials found)"
  echo -e "  ${DIM}To re-authenticate: gcloud auth application-default login --scopes=${SCOPES}${RESET}"
else
  warn "No Application Default Credentials found"
  echo ""
  read -rp "  Authenticate now? [Y/n] " auth_choice
  auth_choice=${auth_choice:-Y}

  if [[ "$auth_choice" =~ ^[Yy]$ ]]; then
    gcloud auth application-default login --scopes="$SCOPES"
    ok "Authenticated"
  else
    warn "Skipped — you'll need to run this before using Gmail features:"
    echo -e "  ${CYAN}gcloud auth application-default login --scopes=${SCOPES}${RESET}"
  fi
fi

# ─── 8. Configure GCP project ────────────────────────────────────────
progress "Google Cloud project..."

SETTINGS_DIR="$HOME/.email-agent"
SETTINGS_FILE="$SETTINGS_DIR/settings.json"

if [ -f "$SETTINGS_FILE" ] && grep -q '"projectId"' "$SETTINGS_FILE" 2>/dev/null; then
  EXISTING_PROJECT=$(grep '"projectId"' "$SETTINGS_FILE" | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
  if [ -n "$EXISTING_PROJECT" ] && [ "$EXISTING_PROJECT" != "" ]; then
    ok "Project already configured: ${EXISTING_PROJECT}"
    read -rp "  Change it? [y/N] " change_choice
    change_choice=${change_choice:-N}
    if [[ ! "$change_choice" =~ ^[Yy]$ ]]; then
      GCP_PROJECT="$EXISTING_PROJECT"
    fi
  fi
fi

if [ -z "${GCP_PROJECT:-}" ]; then
  # Try to detect from gcloud config
  DEFAULT_PROJECT=$(gcloud config get-value project 2>/dev/null || true)

  if [ -n "$DEFAULT_PROJECT" ]; then
    echo -e "  Detected gcloud project: ${CYAN}${DEFAULT_PROJECT}${RESET}"
    read -rp "  Use this project? [Y/n] " use_default
    use_default=${use_default:-Y}
    if [[ "$use_default" =~ ^[Yy]$ ]]; then
      GCP_PROJECT="$DEFAULT_PROJECT"
    fi
  fi

  if [ -z "${GCP_PROJECT:-}" ]; then
    read -rp "  Enter GCP project ID: " GCP_PROJECT
  fi

  if [ -z "$GCP_PROJECT" ]; then
    warn "No project set — Gmail features won't work until configured"
    warn "Set later: npx email-agent setup --project <id>"
  else
    write_private_file "$SETTINGS_FILE" <<SETTINGS_EOF
{
  "agentMode": "${AGENT_MODE}",
  "preferredAgent": "claude",
  "gcp": {
    "projectId": "${GCP_PROJECT}"
  },
  "embedding": {
    "provider": "${EMBEDDING_PROVIDER}",
    "model": "${EMBEDDING_MODEL:-text-embedding-3-small}",
    "dimensions": 768
  },
  "prompts": {
    "summary": "Summarize the following email concisely. Return a JSON object with:\n- overview: 1-2 sentence summary\n- sections: array of { text, citation: { startOffset, endOffset, previewText } }\n- keyActions: array of action items mentioned",
    "digest": "Create a daily digest from these subscription emails. Group by sender/topic, summarize key points, and highlight anything actionable."
  },
  "gmail": {
    "autoApplyActions": false,
    "autoApplyAcknowledged": false
  },
  "ui": {
    "fetchInterval": 0,
    "fetchScope": "unread"
  },
  "retention": {
    "approvalQueueDays": 365
  },
  "dataDir": "$HOME/.email-agent/data",
  "accounts": []
}
SETTINGS_EOF
    ok "Project set: ${GCP_PROJECT}"
    ok "Settings saved: ${SETTINGS_FILE}"
  fi
fi

# ─── 9. OAuth credentials for multi-account ───────────────────────
progress "OAuth credentials..."

OAUTH_FILE="$HOME/.email-agent/oauth.json"
OAUTH_CONFIGURED=false

if [ -f "$OAUTH_FILE" ] && grep -q '"clientId"' "$OAUTH_FILE" 2>/dev/null && grep -q '"clientSecret"' "$OAUTH_FILE" 2>/dev/null; then
  ok "OAuth credentials already configured"
  OAUTH_CONFIGURED=true
else
  echo -e "  To add Gmail accounts, you need OAuth 2.0 client credentials."
  echo ""
  echo -e "  ${BOLD}If you haven't configured the OAuth consent screen yet:${RESET}"
  echo -e "    1. Go to: ${CYAN}https://console.cloud.google.com/auth/overview?project=${GCP_PROJECT:-YOUR_PROJECT}${RESET}"
  echo -e "    2. Click ${BOLD}\"Get started\"${RESET} and fill in app name + support email"
  echo -e "    3. Under Audience, select ${BOLD}\"External\"${RESET} (or \"Internal\" for Workspace orgs)"
  echo ""
  echo -e "  ${BOLD}Create OAuth credentials:${RESET}"
  echo -e "    1. Go to: ${CYAN}https://console.cloud.google.com/apis/credentials?project=${GCP_PROJECT:-YOUR_PROJECT}${RESET}"
  echo -e "    2. Click ${BOLD}\"Create Credentials\"${RESET} → ${BOLD}\"OAuth client ID\"${RESET}"
  echo -e "    3. Application type: ${BOLD}\"Web application\"${RESET}"
  echo -e "    4. Add authorized redirect URIs:"
  echo -e "         ${CYAN}http://localhost:3847/api/auth/callback${RESET}  (Web UI)"
  echo -e "         ${CYAN}http://localhost:9876/callback${RESET}            (CLI)"
  echo -e "       ${DIM}The web URI is built from the origin you open the app on, so EVERY${RESET}"
  echo -e "       ${DIM}origin you serve on has to be listed. If you run 'serve --port N',${RESET}"
  echo -e "       ${DIM}add http://localhost:N/api/auth/callback as well, and note that${RESET}"
  echo -e "       ${DIM}127.0.0.1 is a different origin from localhost. A missing entry${RESET}"
  echo -e "       ${DIM}fails with redirect_uri_mismatch before the consent screen.${RESET}"
  echo -e "    5. Copy the Client ID and Client Secret"
  echo ""
  echo -e "  ${DIM}Add accounts one at a time in a browser: concurrent add-account flows${RESET}"
  echo -e "  ${DIM}share one CSRF state cookie, so a second one started in parallel makes${RESET}"
  echo -e "  ${DIM}the first callback fail with 403 (and can fail both). Nothing breaks —${RESET}"
  echo -e "  ${DIM}just retry that account.${RESET}"
  echo ""
  echo -e "  ${DIM}Press Enter to skip (you can configure later).${RESET}"
  echo ""
  read -rp "  Enter OAuth Client ID: " OAUTH_CLIENT_ID

  if [ -n "$OAUTH_CLIENT_ID" ]; then
    echo ""
    echo -e "  ${DIM}Paste the full secret (GOCSPX-...) or just the part after GOCSPX-${RESET}"
    read -rp "  Enter OAuth Client Secret: " OAUTH_CLIENT_SECRET
    echo ""

    # Normalize: prepend GOCSPX- if user only pasted the suffix
    if [ -n "$OAUTH_CLIENT_SECRET" ] && [[ "$OAUTH_CLIENT_SECRET" != GOCSPX-* ]]; then
      OAUTH_CLIENT_SECRET="GOCSPX-${OAUTH_CLIENT_SECRET}"
    fi

    if [ -n "$OAUTH_CLIENT_SECRET" ]; then
      write_private_file "$OAUTH_FILE" <<OAUTH_EOF
{
  "clientId": "${OAUTH_CLIENT_ID}",
  "clientSecret": "${OAUTH_CLIENT_SECRET}"
}
OAUTH_EOF
      ok "OAuth credentials saved to ${OAUTH_FILE}"
      OAUTH_CONFIGURED=true
    else
      warn "No secret entered — skipping OAuth setup"
    fi
  else
    warn "Skipped — to configure later, create ~/.email-agent/oauth.json:"
    echo -e "  ${DIM}{ \"clientId\": \"YOUR_ID\", \"clientSecret\": \"YOUR_SECRET\" }${RESET}"
  fi
fi

# ─── 10. Gmail API check ────────────────────────────────────────────
progress "Gmail API..."

if [ -n "${GCP_PROJECT:-}" ]; then
  # Check if Gmail API is enabled
  if gcloud services list --project="$GCP_PROJECT" --filter="config.name=gmail.googleapis.com" --format="value(config.name)" 2>/dev/null | grep -q gmail; then
    ok "Gmail API already enabled"
  else
    echo -e "  The Gmail API must be enabled on your GCP project."
    echo ""
    echo -e "  ${BOLD}How to enable:${RESET}"
    echo -e "    1. Go to: ${CYAN}https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=${GCP_PROJECT}${RESET}"
    echo -e "    2. Click ${BOLD}\"Enable\"${RESET}"
    echo -e "    — or —"
    echo -e "    Run: ${CYAN}gcloud services enable gmail.googleapis.com --project=${GCP_PROJECT}${RESET}"
    echo ""
    read -rp "  Enable it now via gcloud? [Y/n] " enable_choice
    enable_choice=${enable_choice:-Y}

    if [[ "$enable_choice" =~ ^[Yy]$ ]]; then
      if gcloud services enable gmail.googleapis.com --project="$GCP_PROJECT" 2>&1; then
        ok "Gmail API enabled"
      else
        warn "Could not enable Gmail API — enable it manually via the link above"
      fi
    else
      warn "Skipped — enable it before fetching emails"
    fi
  fi
else
  warn "No project configured — skipping Gmail API check"
fi

# ─── 11. Initialize database ─────────────────────────────────────────
progress "Initializing LanceDB database..."

node -e "
  import('${PWD}/packages/core/dist/db/connection.js')
    .then(m => m.initDb())
    .then(() => console.log('  ✓ Database initialized'))
    .catch(e => { console.error('  ✗ DB init failed:', e.message); process.exit(1); })
" 2>&1

# ─── Done ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}  ╔══════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}  ║        Setup Complete!           ║${RESET}"
echo -e "${BOLD}${GREEN}  ╚══════════════════════════════════╝${RESET}"
echo ""

# Check which agents are available
AGENTS_FOUND=0

echo -e "${BOLD}AI agents:${RESET}"
if command -v claude &>/dev/null; then
  ok "Claude CLI"
  ((++AGENTS_FOUND))
else
  echo -e "  ${DIM}○ Claude CLI — install: ${CYAN}npm install -g @anthropic-ai/claude-code${RESET}"
fi
if command -v codex &>/dev/null; then
  ok "Codex CLI"
  ((++AGENTS_FOUND))
else
  echo -e "  ${DIM}○ Codex CLI  — install: ${CYAN}npm install -g @openai/codex${RESET}"
fi
if npx @google/gemini-cli --version &>/dev/null 2>&1; then
  ok "Gemini CLI"
  ((++AGENTS_FOUND))
else
  echo -e "  ${DIM}○ Gemini CLI — install: ${CYAN}npm install -g @google/gemini-cli${RESET}"
fi

if [ "$AGENTS_FOUND" -eq 0 ]; then
  echo ""
  warn "No AI agent CLI found. Install at least one above, or use direct-api mode"
  echo -e "  ${DIM}Switch mode:  npx email-agent config set agentMode direct-api${RESET}"
  echo -e "  ${DIM}Then set OPENAI_API_KEY (or OPENROUTER_API_KEY) in .env${RESET}"
fi

echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo -e "  ${CYAN}npx email-agent accounts add${RESET} Add a Gmail account via OAuth"
echo -e "  ${CYAN}npm run dev${RESET}                 Start web UI + dev servers"
echo -e "  ${CYAN}npx email-agent fetch${RESET}       Fetch unread emails"
echo -e "  ${CYAN}npx email-agent serve${RESET}       Start web UI, printing a one-time link to unlock it"
echo -e "  ${CYAN}npx email-agent unlock${RESET}      Print a fresh unlock link without restarting the server"
echo -e "  ${CYAN}npx email-agent list-actions${RESET} See available AI actions"
echo ""
