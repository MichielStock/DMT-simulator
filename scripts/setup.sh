#!/usr/bin/env bash
# Hyperspace setup (BUILD.md 3.1). Idempotent, no sudo. Log: verification/setup.log
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
ROOT="$PWD"
mkdir -p verification assets/sample "$HOME/.local/bin" "$HOME/.local/opt"
export PATH="$HOME/.local/bin:$PATH"
exec > >(tee -a verification/setup.log) 2>&1
say() { echo "[$(date +%H:%M:%S)] $*"; }
die() { say "FATAL: $*"; exit 1; }
say "=== setup start"

# 1. checks -----------------------------------------------------------------
command -v nvidia-smi >/dev/null || die "nvidia-smi not found"
MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1 | tr -d ' ')
[ "${MEM:-0}" -ge 20000 ] || die "GPU has ${MEM} MiB; need >= 20 GB"
FREE=$(df --output=avail -BG "$ROOT" | tail -1 | tr -dc 0-9)
[ "${FREE:-0}" -ge 60 ] || say "WARNING: only ${FREE} GB free; BUILD asks >= 60 GB"

if ! command -v uv >/dev/null; then
  say "installing uv (user space)"
  curl -LsSf https://astral.sh/uv/install.sh | sh || die "uv install failed"
  export PATH="$HOME/.local/bin:$PATH"
fi

node_major() { node --version 2>/dev/null | sed 's/v\([0-9]*\).*/\1/'; }
if [ "$(node_major || echo 0)" -lt 20 ] 2>/dev/null || ! command -v node >/dev/null; then
  say "installing Node 24 LTS user-space"
  NV=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | grep -o 'node-v[0-9.]*-linux-x64.tar.xz' | head -1 | sed 's/node-\(v[0-9.]*\)-.*/\1/')
  [ -n "$NV" ] || die "could not determine Node version"
  TMP=$(mktemp -d)
  curl -fL -o "$TMP/node.tar.xz" "https://nodejs.org/dist/$NV/node-$NV-linux-x64.tar.xz" || die "node download failed"
  rm -rf "$HOME/.local/opt/node"; mkdir -p "$HOME/.local/opt/node"
  tar -xJf "$TMP/node.tar.xz" -C "$HOME/.local/opt/node" --strip-components=1 || die "node extract failed"
  for b in node npm npx; do ln -sf "$HOME/.local/opt/node/bin/$b" "$HOME/.local/bin/$b"; done
  rm -rf "$TMP"; hash -r
fi
[ "$(node_major)" -ge 20 ] || die "Node >= 20 required (PATH has $(node --version))"
say "node $(node --version), $(python3 --version 2>&1), uv $(uv --version)"

# 2. dependencies -------------------------------------------------------------
say "uv sync"; uv sync >verification/uv-sync.log 2>&1 || { tail -5 verification/uv-sync.log; die "uv sync failed"; }
say "npm install"
if [ -f frontend/package-lock.json ]; then (cd frontend && npm ci --no-audit --no-fund) >verification/npm-install.log 2>&1 \
  || (cd frontend && npm install --no-audit --no-fund) >>verification/npm-install.log 2>&1 || { tail -5 verification/npm-install.log; die "npm failed"; }
else (cd frontend && npm install --no-audit --no-fund) >verification/npm-install.log 2>&1 || die "npm failed"; fi
say "playwright chromium"; (cd frontend && npx playwright install chromium) >verification/playwright-install.log 2>&1 \
  || say "WARNING: playwright install chromium failed (see verification/playwright-install.log)"

# 3. torch / cuda ---------------------------------------------------------------
uv run python -c "import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)" || die "torch.cuda.is_available() is False"
say "torch CUDA ok"

# 4. language-model runtime -------------------------------------------------------
bash scripts/ensure_ollama.sh || say "WARNING: Ollama unavailable; language model falls back to templates"

# 5. models + 6. sample room ---------------------------------------------------------
uv run python scripts/fetch_models.py || say "WARNING: fetch_models.py exited non-zero"

# 7. environment record ----------------------------------------------------------------
uv run python scripts/check_env.py --json
RC=$?
uv run python - <<'PY'
import json, pathlib, re
root = pathlib.Path(".")
env = json.loads((root/"verification/env.json").read_text()) if (root/"verification/env.json").exists() else {}
mods = json.loads((root/"verification/models.json").read_text()) if (root/"verification/models.json").exists() else {}
comps = mods.get("components", {})
mt = ["| component | id / tag | status | peak VRAM (GB) |", "|---|---|---|---|"]
for k, c in comps.items():
    mt.append(f"| {k} | {c.get('id') or c.get('source')} | {c.get('status')} | {c.get('peak_vram_gb', '')} |")
fb = mods.get("fallbacks") or []
fbt = "\n".join(f"- {f}" for f in fb) if fb else "(none)"
p = root/"NOTES.md"; s = p.read_text()
def repl(s, head, body):
    pat = re.compile(r"(## " + re.escape(head) + r"\n)(.*?)(?=\n## |\Z)", re.S)
    return pat.sub(lambda m: m.group(1) + "\n" + body + "\n", s, count=1) if pat.search(s) else s + f"\n## {head}\n\n{body}\n"
s = repl(s, "Fallbacks active", fbt)
s = repl(s, "Model tags", "\n".join(mt) + f"\n\nLanguage model runtime: Ollama {env.get('ollama', {}).get('version')} at {env.get('llm_host')}.")
p.write_text(s)
PY
say "=== setup finished (core checks rc=$RC)"
exit $RC
