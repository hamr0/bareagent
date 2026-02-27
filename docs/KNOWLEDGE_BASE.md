# Knowledge Base

## Architecture
3-layer design (orchestration/execution/actuation), 8 components + 3 providers + 2 stores + 1 tool set, ~1017 lines total. Components are independent and composable. Optional browsing capability via `barebrowse` (dynamic import, graceful fallback).
-> docs/architecture.md

## API Reference
Constructor options, method signatures, return types for all components, providers, and stores. Tool format, CLI subprocess protocol.
-> docs/api-reference.md

## Development
Stack (Node.js >= 18, node:test, pure JS), test commands, project structure, POC workflow, environment setup (Ollama via podman).
-> docs/development.md

## Troubleshooting
Known bugs (API key formatting, Anthropic message normalization, CLI exit, scheduler re-entry), debugging with Stream events, common patterns (topo-sort, memory injection).
-> docs/troubleshooting.md

## Product Requirements
Full project plan: component specs, data formats, usage profiles (minimal/medium/full), consumption modes (npm/subprocess/JSON-RPC), implementation phases.
-> docs/01-product/prd.md

## Blueprint
Exact implementation details per component: line counts, interfaces, behaviors, test results (104 unit, 42 integration, 4 E2E). Updated after each POC. Includes browsing strategy docs (library tools via `createBrowsingTools` and CLI session mode via `barebrowse` CLI for token-efficient disk-based snapshots).
-> docs/00-context/blueprint.md

## Vision
First-principles analysis of agent orchestration: what components exist, what a personal assistant actually needs, why frameworks are overcomplicated.
-> docs/00-context/vision.md

## Usage Guide
Customer-facing guide: npm import, subprocess JSONL, JSON-RPC. Code examples for each component and composition pattern.
-> docs/02-features/usage-guide.md

## Decision Log
Key design decisions: package name, v0.1 scope cuts (Router, Tool.define, JSON-RPC), flat directory structure, pure JS over TypeScript.
-> docs/03-logs/decisions-log.md

## Testing Guide
Test pyramid (unit/integration/E2E), all test files with counts, integration bugs caught, test philosophy.
-> docs/04-process/testing.md
