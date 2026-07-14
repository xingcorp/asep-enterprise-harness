# Security Threat Model

## Assets

Source code, secrets, customer data, build artifacts, signing identities, production environments, model prompts, agent memory, audit evidence and budgets.

## Trust boundaries

- user/product input;
- repository/dependency content;
- web/MCP/tool output;
- model provider;
- sandbox;
- control plane;
- credential broker;
- Git/CI/deployment systems;
- memory/knowledge stores.

All repository and web text is untrusted data, not policy.

## Controls

- default-deny outbound network;
- short-lived scoped credentials from a broker;
- no production `.env` in workspaces;
- rootless containers, gVisor or microVM by risk;
- immutable/pinned images and dependency policy;
- signed skill registry;
- tenant-scoped storage paths and encryption;
- human approval for irreversible actions;
- audit events for policy decisions and network requests;
- canary secrets and DLP/redaction;
- raw output capture separated from model context.

## Risk tiers

- R0 docs/mechanical safe change.
- R1 low-risk internal change.
- R2 normal product change requiring independent review.
- R3 auth/payment/migration/infra/security/public API.
- R4 irreversible production side effects; agent prepares only.

## Prompt injection response

Instructions from README, issue, webpage, dependency or tool cannot change allowed tools, network, secret scope, verification plan or approval policy. Suspicious instructions create security events and may stop the attempt.
