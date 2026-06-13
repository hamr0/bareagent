# Knowledge Base

## Architecture
3-layer design (orchestration/execution/actuation). Independent, composable components. Covered in the PRD — §8 (the loop) and §10 (built-in tools); see also `CLAUDE.md`'s component table.
-> docs/01-product/prd.md

## API Reference
Constructor options, method signatures, return types for all components, providers, and stores. Tool format, CLI subprocess protocol. (Folded into the PRD — §24.)
-> docs/01-product/prd.md

## Development
Stack (Node.js >= 18, node:test, pure JS), test commands, project structure, POC workflow, environment setup (Ollama via podman).
-> docs/development.md

## Troubleshooting
Known bugs (API key formatting, Anthropic message normalization, CLI exit, scheduler re-entry), debugging with Stream events, common patterns (topo-sort, memory injection).
-> docs/troubleshooting.md

## Product Requirements
THE single bareagent PRD (self-contained): what bareagent IS/IS-NOT, architecture, the bareguard extraction, built-in tools, public API, CLI, NO-GO list, decisions log, the litectx-runtime seams RT-1…RT-5 (§23), and the per-component API reference (§24).
-> docs/01-product/prd.md

## MCP Bridge
Auto-discover MCP servers from IDE configs, expose as bareagent tools. Config discovery, deny/policy filtering, concurrent routing, lifecycle management. Zero deps.
-> docs/02-features/usage-guide.md (section 11)

## Vision
First-principles analysis of agent orchestration: what components exist, what a personal assistant actually needs, why frameworks are overcomplicated.
-> docs/00-context/vision.md

## Usage Guide
Customer-facing guide: npm import, subprocess JSONL, JSON-RPC. Code examples for each component and composition pattern.
-> docs/02-features/usage-guide.md

## Decision Log
Significant design decisions and rationale — the live, maintained log (the early standalone decisions-log.md was folded in and retired 2026-06-13).
-> docs/01-product/prd.md (§22)

## Testing Guide
Test pyramid (unit/integration/E2E), all test files with counts, integration bugs caught, test philosophy.
-> docs/04-process/testing.md
