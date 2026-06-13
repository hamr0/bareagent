# Documentation

## Structure

```
docs/
├── 00-context/              WHY and WHAT EXISTS
│   ├── vision.md            First-principles thinking behind the architecture
│   └── troubleshooting.md   Known issues + debugging patterns
│
├── 01-product/              WHAT the product must do
│   └── prd.md               THE single PRD — spec, built-in tools, public API (§24), litectx-runtime seams (§23), decisions log
│
├── 02-features/             HOW features work for users
│   └── usage-guide.md       How to consume bare-agent — npm, subprocess, examples
│
├── 03-logs/                 WHAT CHANGED over time
│   └── bareagent-eval-multis.md   Eval: adopting bareagent in a real project
│
├── 04-process/              HOW to work on this project
│   ├── dev-workflow.md      Principles, stack, running tests, POC workflow
│   └── testing.md           Test pyramid, what's tested, how to run
│
└── README.md                This file
```

## Quick links

| I want to... | Read |
|---|---|
| Understand why bare-agent exists | [vision.md](00-context/vision.md) |
| See what's built / the spec | [prd.md](01-product/prd.md) |
| Read the PRD (spec, API reference §24, litectx seams §23) | [prd.md](01-product/prd.md) |
| Use bare-agent in my project | [usage-guide.md](02-features/usage-guide.md) |
| Run the tests | [testing.md](04-process/testing.md) |
| Understand a design decision | [prd.md §22 — decisions log](01-product/prd.md) |
