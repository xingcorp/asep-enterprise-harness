# Multi-Tenancy

Use centralized governance and isolated execution spokes. Isolation keys are organization, team, project, run and workspace. Credentials, memory namespaces, artifact prefixes, network policies and agent sessions are tenant-scoped.

Shared services may include signed skills, model gateway, evaluation engine, observability pipeline and sandbox images, but access is policy-enforced. High-sensitivity tenants may receive dedicated databases, buckets, model routes or clusters.

No tenant filter is accepted solely from model-generated input. Server-side identity context is injected and validated on every memory/artifact/query operation.
