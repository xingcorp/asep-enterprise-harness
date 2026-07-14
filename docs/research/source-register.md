# Research Source Register

**Frozen research date:** 2026-07-14. Prefer official repositories, releases, specifications and vendor engineering publications. Claims from project/vendor benchmarks are labeled as vendor-reported and must not be treated as guaranteed outcomes.

## Core and frameworks

- Temporal repository/releases: https://github.com/temporalio/temporal and https://github.com/temporalio/temporal/releases
- GitHub Spec Kit: https://github.com/github/spec-kit and https://github.com/github/spec-kit/releases
- Addy Osmani Agent Skills: https://github.com/addyosmani/agent-skills/releases
- Superpowers: https://github.com/obra/superpowers and https://github.com/obra/superpowers/releases
- Google ADK Python: https://github.com/google/adk-python/releases
- DeerFlow 2: https://github.com/bytedance/deer-flow and release announcement https://github.com/bytedance/deer-flow/discussions/3795
- OpenHands: https://github.com/OpenHands/OpenHands/releases
- Open Design: https://github.com/nexu-io/open-design/releases
- Mem0: https://github.com/mem0ai/mem0 and https://github.com/mem0ai/mem0/releases
- Graphiti: https://github.com/getzep/graphiti
- RTK: https://github.com/rtk-ai/rtk/releases
- Caveman: https://github.com/JuliusBrussee/caveman
- Open GSD Core: https://github.com/open-gsd/gsd-core
- BMAD Method: https://github.com/bmad-code-org/BMAD-METHOD
- Spec Kitty: https://github.com/Priivacy-ai/spec-kitty
- Microsoft Agent Framework: https://github.com/microsoft/agent-framework
- LangGraph: https://github.com/langchain-ai/langgraph

## Protocols and standards

- Agent Skills: https://agentskills.io/
- Model Context Protocol: https://modelcontextprotocol.io/specification/
- Agent Client Protocol: https://agentclientprotocol.com/
- A2A: https://a2a-protocol.org/
- OpenTelemetry GenAI: https://opentelemetry.io/docs/specs/semconv/gen-ai/

## Public engineering patterns

- OpenAI harness engineering: https://openai.com/index/harness-engineering/
- OpenAI Codex long-horizon guidance: https://developers.openai.com/blog/run-long-horizon-tasks-with-codex
- GitHub harness/model evaluation: https://github.blog/ai-and-ml/github-copilot/evaluating-performance-and-efficiency-of-the-github-copilot-agentic-harness-across-models-and-tasks/
- GitHub AI code review ownership: https://github.blog/ai-and-ml/generative-ai/code-review-in-the-age-of-ai-why-developers-will-always-own-the-merge-button/
- Anthropic context engineering: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- DORA 2025: https://dora.dev/dora-report-2025/
- Siemens legacy modernization case: https://cloud.google.com/blog/products/ai-machine-learning/how-siemens-sliced-the-elephant-modernizing-legacy-code-with-agentic-workflows/

## Known-current cautions incorporated

- ADK 2.4.0 was released 2026-07-07; new releases require pinned compatibility tests.
- OpenHands 1.11.0 was published 2026-07-09 according to its release page.
- Open Design 0.14.1 was published 2026-07-10.
- Agent Skills 0.6.4 was published 2026-07-12 with in-repo evaluation and native Codex support.
- Superpowers 6.1.1 was published 2026-07-02 and its 6.x line separates behavior evals from plugin tests.
- DeerFlow 2.0.0 was announced 2026-06-25; cross-worker cancellation ownership remains an explicit limitation in its release notes.
- Public issue evidence shows RTK/Caveman-style compression can alter diagnostics or files; therefore both are excluded from trusted evidence paths.
- The original `gsd-build/get-shit-done` was archived; this design references `open-gsd/gsd-core` only as a methodology/optional importer and does not trust it as core state.
