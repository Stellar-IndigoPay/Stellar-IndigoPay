#!/usr/bin/env bash
# Runs rustfmt in check mode across the contracts workspace if staged .rs files are present.

set -euo pipefail

# Ensure Cargo is in PATH. Git hooks run in non-interactive/non-login shells
# which may not load user shell profiles (like ~/.bashrc or ~/.profile),
# especially when committing via GUI git clients or IDEs.
if ! command -v cargo &>/dev/null; then
  if [ -f "$HOME/.cargo/env" ]; then
    # shellcheck source=/dev/null
    . "$HOME/.cargo/env"
  elif [ -d "$HOME/.cargo/bin" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  fi
fi

# Get the root of the git repository
REPO_ROOT=$(git rev-parse --show-toplevel)

# Detect if staged Rust files are present
STAGED_RS_FILES=$(git diff --cached --name-only --diff-filter=ACMR | grep '\.rs$' || true)

if [ -z "$STAGED_RS_FILES" ]; then
  exit 0
fi

# Check if cargo is available
if ! command -v cargo &>/dev/null; then
  echo "❌ Error: Cargo not found. Please install Rust and cargo (https://rustup.rs) to check and format Rust code." >&2
  exit 1
fi

# Change to the contracts workspace directory
cd "$REPO_ROOT/contracts"

# Run cargo fmt in check mode (matching the CI step)
echo "✦ Checking Rust formatting in contracts workspace..."
if ! cargo fmt --all -- --check; then
  echo "──────────────────────────────────────────────────────────" >&2
  echo "❌ Rust formatting check failed!" >&2
  echo "   Improperly formatted Rust code was detected." >&2
  echo "   Please run 'cargo fmt --all' in the 'contracts' directory" >&2
  echo "   to format your staged files before committing." >&2
  echo "──────────────────────────────────────────────────────────" >&2
  exit 1
fi

echo "✅ Rust formatting check passed!"
