#!/usr/bin/env bash
# Runs rustfmt in check mode across the contracts crate.
# Ignores any filenames lint-staged appends (we format the whole crate).
set -e
cd "$(git rev-parse --show-toplevel)/contracts"
exec cargo fmt -- --check
