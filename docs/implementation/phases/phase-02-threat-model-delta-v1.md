# Phase 2 — Threat Model Delta (v1, DRAFT)

> Delta over `docs/operations/security-threat-model.md`. Phase 2 introduces the first real side effects (agent process, Git push, forge API, object storage, DB), so the trust boundaries change materially. Base `e046885`.

## 1. New trust boundaries

```text
[Control Plane / CLI]  trusted
      │  (application use case)
      ▼
[Trusted harness]  trusted — owns commit, credentials, verification
      │                         │                     │
      ▼                         ▼                     ▼
[Coding agent process]    [Trusted cmd runner]   [Forge adapter]
  UNTRUSTED output          trusted invoker        holds GH token
  writes worktree only      shell:false            (agent never sees it)
      │                         │
      ▼                         ▼
[Git worktree]  data          [Sandbox: no-network verify]
```

The agent process is **untrusted**. Everything it produces (diff, events, summary) is data to be verified, never an instruction the harness obeys and never a grant of authority.

## 2. Assets

Repository contents, GitHub App private key + installation tokens, PostgreSQL operational state, immutable artifacts, PR write capability, host compute.

## 3. Threats and mitigations (delta)

| ID | Threat | Mitigation | Verified by |
|----|--------|-----------|-------------|
| T2-01 | Agent commits/pushes directly | Agent env carries no git-push credential; harness inspects `HEAD==baseSha` and rejects agent-created commits/refs; harness owns commit | worktree tests: attempted commit/push rejected |
| T2-02 | Agent exfiltrates via network | `verification-no-network` profile = OS-enforced `--network none`; agent profile is restricted-egress (proxy allowlist) or documented pilot-only | sandbox no-network canary (DNS/IP/HTTP/fetch all fail) |
| T2-03 | GitHub token leak | Token minted just-in-time, repository-scoped, min permissions, treated as opaque; never in workspace, log, artifact or persisted remote URL; secret/PII scanners in `verify:all` | secret-scan self-test; remote-URL scrub test |
| T2-04 | Cross-project data access (IDOR) | Every repository query scoped by `organization_id+project_id`; artifact keys content-addressed + tenant-unique | negative test: project A cannot read project B artifact/attempt |
| T2-05 | Path/symlink escape from worktree | Paths built from normalized/hashed IDs; `realpath` containment check under workspace root; `.git` writes forbidden | traversal + symlink escape tests |
| T2-06 | Shell injection via verification command | `CommandSpec` = executable + argv, `shell:false`; commands come from approved project config / VerificationPlan, never model-generated strings | injection test: metachars are inert args |
| T2-07 | Swallowed failure / false completion | Exact exit code + signal preserved; raw stdout/stderr stored before any reducer; machine verdict cannot reach ACCEPTED — terminal state is `WAITING_FOR_HUMAN_REVIEW` | exit-code fidelity test; state-machine test |
| T2-08 | Duplicate side effect on retry | `idempotency_records` guard commit/push/PR upsert; PR unique `(binding, head_branch)` | retry test: second attempt no duplicate PR/commit |
| T2-09 | Artifact corruption / metadata mismatch | SHA-256 addressing; `verify()` on read; object write precedes metadata; immutable | corruption-detected + orphan-metadata tests |
| T2-10 | Stale worktree reused against wrong SHA | Lease expiry + heartbeat; base SHA pinned & re-verified; failed worktree quarantined | lease-expiry + quarantine tests |
| T2-11 | Malformed provider events | Structured JSON/stream parsing fails closed; partial/garbage events → classified failure, not silent success | fake-provider malformed-event tests |
| T2-12 | Docker socket / privilege escalation | No Docker socket mount; read-only root; cap drop; `no-new-privileges`; PID/mem/CPU limits; image pinned by digest | sandbox config assertions |
| T2-13 | Prompt injection via repo content / issue text | Repo/issue content is untrusted data in ContextPack; authority (tools, paths, network) comes from policy, not from content; injection eval fixture (Phase 1) still runs | Phase 1 prompt-injection eval + tool-policy default-deny |
| T2-14 | Webhook spoofing / replay | HMAC signature validation on every webhook; delivery-ID dedup | webhook signature + replay tests |

## 4. Non-issues (documented, not fixed)

- **Multi-tenant hostile isolation at OS level** (gVisor/microVM): out of scope; Phase 2 pilot is single-operator, low-risk repos. Recorded as a pre-production dependency, not a Phase 2 defect.
- **Full enterprise IAM/OIDC**: out of scope; `auth-local` adapter only.
- **Secret storage service**: GitHub App key handling is defined (out-of-tree, injected), but a managed broker is Phase 3+.

## 5. Residual risk statement

The agent-egress boundary is the weakest link: if a proxy allowlist cannot be enforced in the pilot environment, the agent sandbox MUST be documented as pilot-only and never described as production-secure. Verification isolation (`--network none`) is the hard guarantee and is OS-enforced.
