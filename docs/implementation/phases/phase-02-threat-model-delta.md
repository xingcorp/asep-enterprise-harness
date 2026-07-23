# Phase 2 — Threat Model Delta (LOCKED)

> Delta over `docs/operations/security-threat-model.md`. Phase 2 introduces the first real side effects (agent process, Git push, forge API, object storage, DB), so the trust boundaries change materially. Base `e046885`.
> Supersedes `phase-02-threat-model-delta-v1.md`. Codex plan-review findings folded (see `phase-02-review-log.md`).

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
| T2-01 | Agent commits/pushes directly, OR harness pushes to a protected ref | Agent env carries no git-push credential; harness inspects `HEAD==baseSha` and rejects agent-created commits/refs; harness owns commit. **RefSafetyPolicy (disp. CRIT-001)**: push allowed only to the ASEP-owned branch namespace via an exact create/update refspec; default/protected refs, tags, delete and force are rejected; force-with-lease only against a recorded SHA; pilot repo ruleset denies direct default-branch writes + App merges. **OS-enforced agent/Git separation (disp. HIGH-006)**: agent runs in a separate sandboxed process; `.git` indirection, mirror, refs, objects, config, hooks are read-only/omitted — containment, not just detection | worktree tests: attempted commit/push rejected; bare-remote tests reject main/master/HEAD/tag/delete/force/malformed; transport test proves only the namespaced ref is sent; OS-level test fails `.git`/refs/objects writes from inside the agent sandbox |
| T2-02 | Agent exfiltrates via network | `verification-no-network` profile = OS-enforced `--network none`; agent profile is restricted-egress (proxy allowlist) or documented pilot-only | sandbox no-network canary (DNS/IP/HTTP/fetch all fail) |
| T2-03 | GitHub token leak or expiry mid-attempt | Token minted just-in-time per bounded operation, repository-scoped, min permissions, treated as opaque paired with provider-reported expiry; never in workspace, log, artifact or persisted remote URL; auth-expiry re-mints + reconciles by natural key **without replaying** a completed side effect (disp. MED-005); secret/PII scanners in `verify:all` | secret-scan self-test; remote-URL scrub test; fake-clock expiry/rotation test |
| T2-04 | Cross-project data access (IDOR) | Server-derived `TenantScope`/`AuthContext` required by every use case + repository method; **composite FKs** enforce org/project/parent consistency at the DB boundary (a task cannot reference a run/binding from another project); artifact keys content-addressed + tenant-prefixed + scoped FK references (disp. HIGH-003/004) | migration tests reject every mismatched org/project/parent combo; app + repository IDOR read/write tests; full trace resolves every row to one org/project/repo |
| T2-05 | Path/symlink escape from worktree | Paths built from normalized/hashed IDs; `realpath` containment check under workspace root; `.git` writes forbidden | traversal + symlink escape tests |
| T2-15 | Malicious `remote_url` / repo-controlled Git config (SSRF, RCE, cred leak) | Clone/fetch URLs constructed from validated forge identity, not an arbitrary transport URL; allow only configured GitHub HTTPS host; reject userinfo, non-HTTPS/`file`/`ext`/`ssh`/local paths, option-like/newline injection; sanitize `GIT_CONFIG*`/SSH/askpass/proxy env; disable unapproved protocols + hooks; fail-closed submodule policy (disp. HIGH-007) | real Git tests reject `file://`/`ext::`/ssh/local/userinfo/newline/malicious `insteadOf`/askpass/hostile submodules; allow only the configured host + exact repo identity |
| T2-06 | Shell injection via verification command | `CommandSpec` = executable + argv, `shell:false`; commands come from approved project config / VerificationPlan, never model-generated strings | injection test: metachars are inert args |
| T2-07 | Swallowed failure / false completion | Exact exit code + signal preserved; raw stdout/stderr stored before any reducer; machine verdict cannot reach ACCEPTED — terminal state is `WAITING_FOR_HUMAN_REVIEW`. Evidence/commit ordering (disp. HIGH-008): preallocate a non-content-derived evidence artifact id, verify against the exact staged tree, commit with that id in the `ASEP-Evidence` trailer, then store the final bundle whose `resultSha` = the harness commit SHA, before any push | exit-code fidelity test; state-machine test; commit-trailer→evidence→pushed-SHA chain test |
| T2-08 | Duplicate side effect on retry / crash mid-side-effect | Crash-safe protocol (disp. HIGH-005): tenant-scoped semantic key + request fingerprint + `PENDING/COMPLETED/FAILED` state + owner/fencing token; commit, exact-ref push and PR upsert each distinguish retry from a new business attempt and reconcile the remote by natural key; PR unique `(repository_binding_id, head_branch)` | fault-injection: kill executor before/after each Git/object/GitHub call and before/after the matching DB write; restart converges to one commit, one ref, one PR |
| T2-09 | Artifact corruption / metadata mismatch | SHA-256 addressing; `verify()` on read; object write precedes metadata; immutable | corruption-detected + orphan-metadata tests |
| T2-10 | Stale worktree reused against wrong SHA | Lease expiry + heartbeat; base SHA pinned & re-verified; failed worktree quarantined | lease-expiry + quarantine tests |
| T2-11 | Malformed provider events | Structured JSON/stream parsing fails closed; partial/garbage events → classified failure, not silent success | fake-provider malformed-event tests |
| T2-12 | Docker socket / privilege escalation | No Docker socket mount; read-only root; cap drop; `no-new-privileges`; PID/mem/CPU limits; image pinned by digest | sandbox config assertions |
| T2-13 | Prompt injection via repo content / issue text | Repo/issue content is untrusted data in ContextPack; authority (tools, paths, network) comes from policy, not from content; injection eval fixture (Phase 1) still runs | Phase 1 prompt-injection eval + tool-policy default-deny |
| T2-14 | ~~Webhook spoofing / replay~~ | **Removed from Phase 2 attack surface (disp. P2-PLAN-MED-004).** Creating/updating a PR needs no inbound webhook, so no authenticated webhook route, secret, or dependency exists in Phase 2 — the surface is eliminated rather than mitigated. Revisit when review-state ingestion arrives in a later phase | scope test: no webhook route/dependency present |
| T2-15 | Malicious `remote_url` (file://, ext::, ssh, local path, userinfo, option/newline injection, hostile insteadOf/askpass/submodule) triggers host file access / RCE / SSRF / cred leak without a shell (disp. P2-PLAN-HIGH-007) | Clone/fetch URLs are **constructed from validated forge identity**, not an arbitrary transport URL; allow only configured GitHub HTTPS host, reject userinfo + non-HTTPS/local/ext/ssh, terminate option parsing, sanitize `GIT_CONFIG*`/SSH/askpass/proxy env, disable unapproved protocols + hooks, fail-closed submodule policy | real-Git tests reject each hostile transport/config; only the exact configured host + repo identity is allowed |

## 4. Non-issues (documented, not fixed)

- **Multi-tenant hostile isolation at OS level** (gVisor/microVM): out of scope; Phase 2 pilot is single-operator, low-risk repos. Recorded as a pre-production dependency, not a Phase 2 defect.
- **Full enterprise IAM/OIDC**: out of scope; `auth-local` adapter only.
- **Secret storage service**: GitHub App key handling is defined (out-of-tree, injected), but a managed broker is Phase 3+.

## 5. Residual risk statement

The agent-egress boundary is the weakest link: if a proxy allowlist cannot be enforced in the pilot environment, the agent sandbox MUST be documented as pilot-only and never described as production-secure. Verification isolation (`--network none`) is the hard guarantee and is OS-enforced.
