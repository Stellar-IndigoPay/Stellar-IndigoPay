# Soroban Contracts Developer Guide

This guide provides instructions for compiling, testing, and building the Soroban smart contracts locally.

## Prerequisites

Ensure you have the Rust toolchain installed. You will also need to add the WebAssembly target.

```bash
# Install Rust toolchain target for WebAssembly
rustup target add wasm32v1-none
```

## Running Tests

### Unit Tests

To run the standard unit tests with the testutils feature enabled:

```bash
# Run unit tests
cargo test --features testutils
```

### Fuzz Tests

To run fuzz tests, use the following command. The `FUZZ_ITERATIONS` env var
controls how many proptest cases each property test runs (default: 256).

```bash
# Run fuzz tests (default: 256 cases per test)
cargo test --features testutils -- fuzz

# Run with a custom case count
FUZZ_ITERATIONS=1000 cargo test --features testutils -- fuzz
```

### Expected Output

When running tests successfully, you should see output similar to the following:

```
running 10 tests
test test_initialization ... ok
test test_balance ... ok
...
test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.15s
```

## Building the Contract

To build the contract into a WebAssembly (.wasm) file ready for deployment:

```bash
# Build WASM
cargo build --target wasm32v1-none --release
```

The compiled WASM file will be located at `target/wasm32v1-none/release/<contract_name>.wasm`.

## Troubleshooting Common Errors

### Error: `target wasm32v1-none not found`

- **Cause**: The WebAssembly target is not installed for your active Rust toolchain.
- **Fix**: Run `rustup target add wasm32v1-none`.

### Error: `unresolved import` or `cannot find value` during tests

- **Cause**: You might be running tests without the `testutils` feature enabled, which provides mock data and utilities.
- **Fix**: Ensure you append `--features testutils` when running `cargo test`.

### Error: `linker 'rust-lld' not found`

- **Cause**: The required linker is missing from your environment.
- **Fix**: Install the `lld` package for your operating system (e.g., `apt install lld` on Ubuntu, `brew install lld` on macOS).

### Warning: `unused import` or `dead code`

- **Cause**: The codebase contains unused variables or imports, which Rust flags aggressively by default.
- **Fix**: While not blocking the build, you can prefix unused variables with an underscore (e.g., `_my_var`) or clean up the code.

