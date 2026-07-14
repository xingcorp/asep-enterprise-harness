# Security Policy

This starter executes only a mock agent. Before connecting a real coding agent, implement sandbox isolation, default-deny network, short-lived credential brokering, tenant-scoped storage, prompt-injection controls, signed skills, raw evidence capture and human approval for high-risk actions.

Do not place production credentials in `.env`, Compose files, model prompts, agent memory or repository fixtures. Security findings should preserve evidence and follow `docs/operations/incident-response.md`.
