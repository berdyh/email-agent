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
total_steps=10

progress() {
  ((++step))
  echo -e "\n${BOLD}[${step}/${total_steps}]${RESET} $1"
}

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
  fail "Node.js not found. Install v20+: https://nodejs.org"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  fail "Node.js v20+ required (found v$(node -v))"
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
  echo -e "    3) ${CYAN}local${RESET}       — Zero-vector fallback (no API key needed, no semantic search)"
  echo ""
  read -rp "  Choose [1/2/3] (default: 1): " embed_choice
  embed_choice=${embed_choice:-1}

  if [ "$embed_choice" = "3" ]; then
    EMBEDDING_PROVIDER="local"
    ok "Embedding provider: local (zero-vector fallback)"
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
set_env "EMBEDDING_PROVIDER" "$EMBEDDING_PROVIDER"

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
set_env "AGENT_MODE" "$AGENT_MODE"
ok "Agent mode: ${AGENT_MODE}"

# ── Gmail sync ──
echo ""
echo -e "  ${BOLD}Gmail sync:${RESET}"
echo -e "  ${DIM}When enabled, action recommendations (trash, spam, etc.) are auto-applied to Gmail.${RESET}"
echo -e "  ${DIM}When disabled, you'll be prompted before each change.${RESET}"
echo ""
read -rp "  Enable auto-sync of action results? [y/N] " sync_choice
sync_choice=${sync_choice:-N}

if [[ "$sync_choice" =~ ^[Yy]$ ]]; then
  GMAIL_SYNC_ACTIONS="true"
  ok "Gmail sync: enabled (auto-apply)"
else
  GMAIL_SYNC_ACTIONS="false"
  ok "Gmail sync: disabled (prompt before applying)"
fi

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

  # Google
  EXISTING_GOOGLE=$(grep "^GOOGLE_API_KEY=" .env 2>/dev/null | sed 's/^GOOGLE_API_KEY=//' || true)
  if [ -n "$EXISTING_GOOGLE" ]; then
    ok "GOOGLE_API_KEY already set"
  else
    echo ""
    read -rsp "  Google API key: " google_key
    echo ""
    if [ -n "$google_key" ]; then
      set_env "GOOGLE_API_KEY" "$google_key"
      ok "GOOGLE_API_KEY saved"
    else
      warn "Skipped GOOGLE_API_KEY"
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

SCOPES="https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/pubsub"

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
    mkdir -p "$SETTINGS_DIR"
    cat > "$SETTINGS_FILE" <<SETTINGS_EOF
{
  "agentMode": "${AGENT_MODE}",
  "preferredAgent": "claude",
  "gcp": {
    "projectId": "${GCP_PROJECT}",
    "pubsubTopic": "email-agent-notifications",
    "pubsubSubscription": "email-agent-sub"
  },
  "embedding": {
    "provider": "${EMBEDDING_PROVIDER}",
    "model": "${EMBEDDING_MODEL:-text-embedding-3-small}",
    "dimensions": 768
  },
  "gmail": {
    "syncActions": ${GMAIL_SYNC_ACTIONS:-false}
  },
  "accounts": []
}
SETTINGS_EOF
    ok "Project set: ${GCP_PROJECT}"
    ok "Settings saved: ${SETTINGS_FILE}"
  fi
fi

# ─── 9. Gmail API check ─────────────────────────────────────────────
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

# ─── 10. Initialize database ─────────────────────────────────────────
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
  warn "No AI agent CLI found. Install at least one above, or set AGENT_MODE=direct-api"
  echo -e "  ${DIM}With direct-api mode, set OPENAI_API_KEY in .env${RESET}"
fi

echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo -e "  ${CYAN}npm run dev${RESET}                 Start web UI + dev servers"
echo -e "  ${CYAN}npx email-agent fetch${RESET}       Fetch unread emails"
echo -e "  ${CYAN}npx email-agent serve${RESET}       Start web UI at http://localhost:3847"
echo -e "  ${CYAN}npx email-agent list-actions${RESET} See available AI actions"
echo ""
