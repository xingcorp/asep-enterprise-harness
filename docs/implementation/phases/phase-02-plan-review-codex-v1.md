```yaml
review:
  reviewed_base_sha: "e046885"
  verdict: REQUEST_CHANGES
  confidence: 0.98

  critical_findings:
    - id: "P2-PLAN-CRIT-001"
      severity: "CRITICAL"
      location: "phase-02-plan-v1.md:207,236,242; phase-02-architecture-v1.md:175-182; docs/implementation/90-day-plan.md:13-22"
      consequence: >-
        ForgeProvider accepts an arbitrary branch while the GitHub App receives
        Contents:write. Nothing requires a harness-generated branch, rejects the
        default/protected branch, prohibits force/delete refspecs, or verifies branch
        protection. The harness could therefore push a verified commit directly to
        main, bypassing the promised PR-only/no-merge boundary.
      required_change: >-
        Add a non-bypassable RefSafetyPolicy: generate branches under an ASEP-owned
        namespace, require head != configured default/protected refs, validate with
        git check-ref-format, allow only an exact create/update refspec, prohibit
        deletion and force except force-with-lease against a recorded expected SHA,
        and require pilot-repository rulesets that deny direct default-branch writes
        and merges by the App.
      validation_method: >-
        Real bare-remote tests must reject main/master/HEAD, tag, deletion, malformed,
        option-like and force-push targets; a GitHub transport test must prove only
        the expected namespaced ref is sent; the live pilot must record the active
        branch-protection/ruleset and show that the installation token cannot update
        or merge the default branch.

  high_findings:
    - id: "P2-PLAN-HIGH-001"
      severity: "HIGH"
      location: "phase-02-plan-v1.md:196,204-209,248; phase-02-exit-criteria-v1.md:76-80; policies/approval-matrix.yaml:32-66; policies/verification-matrix.yaml:20-25; packages/policy/src/approval.ts:39-50"
      consequence: >-
        Phase 2 excludes a runtime independent reviewer, but locked policy requires
        one reviewer for R1 and L8/different-family review for R2 and above. The plan
        does not define an admission ceiling or how these mandatory gates are
        satisfied, so higher-risk work could be pushed while mandatory assurance is
        missing, or the slice could be impossible to complete without silently
        weakening policy.
      required_change: >-
        Define an explicit Phase 2 risk-admission matrix. Fail closed before agent
        invocation for any risk whose current mandatory gates cannot be satisfied.
        Restrict automated pilot completion to R0 unless a separately recorded human
        independent-review step satisfies R1; defer R2-R4 rather than overriding the
        Phase 1 matrices.
      validation_method: >-
        Table-driven tests over R0-R4 must prove unsupported risks stop before
        workspace creation, agent invocation and push; policy parity tests must remain
        unchanged; pilot evidence must state each task risk and the gate that
        satisfied every required approval and assurance level.

    - id: "P2-PLAN-HIGH-002"
      severity: "HIGH"
      location: "phase-02-plan-v1.md:197-203,218,248; phase-02-architecture-v1.md:57-73; packages/ports/src/index.ts:6-10; packages/contracts/src/base.ts:31-42; docs/architecture/05-sequence-diagrams.md:15-20"
      consequence: >-
        The plan says CodingAgentProvider is reused as-is, but its execute method
        receives neither the pre-created attempt ID, leased workspace, AbortSignal nor
        execution permission profile. It also lets the provider return attemptId and
        resultSha even though the harness must own identity and commits. Implementing
        this safely would require hidden mutable adapter state or a rewrite of the
        port during implementation.
      required_change: >-
        Redesign the provider-neutral request before locking the plan. It must carry
        harness-owned attempt identity, an opaque workspace capability, immutable
        WorkOrder/ContextPack references and hashes, budgets, tool/network policy and
        cancellation. The result must contain only untrusted attempt observations;
        Git state, changed files and result commit SHA must be derived by trusted
        harness components.
      validation_method: >-
        Port contract tests must run concurrent attempts through one adapter instance
        without state crossover, prove cancellation and budgets are request-scoped,
        reject provider-selected identities/SHAs, and demonstrate that the fake and
        live adapters use the same request/result contract.

    - id: "P2-PLAN-HIGH-003"
      severity: "HIGH"
      location: "phase-02-data-model-v1.md:9-13,29-61; phase-02-plan-v1.md:169-188; phase-02-exit-criteria-v1.md:21-28; docs/operations/multi-tenancy.md:1-7"
      consequence: >-
        Duplicated organization_id/project_id columns are protected only by independent
        single-column foreign keys. A task can claim project A while referencing a run
        or repository binding from project B and still pass a scoped row filter. The
        model also lacks a concrete server-derived authorization context, and
        pull_requests declares a unique index on repository_binding_id without
        declaring that column.
      required_change: >-
        Define a TenantScope/AuthContext sourced from authenticated server state and
        required by every application use case and repository method. Enforce
        hierarchy consistency with composite unique keys and composite foreign keys,
        or remove duplicated scope columns and derive them through constrained parent
        relationships. Add repository_binding_id where repository resolution is
        required, including pull requests, audit and idempotency records.
      validation_method: >-
        Migration tests must attempt every mismatched org/project/parent combination
        and fail at the database boundary. Application and repository tests must
        independently reject IDOR reads and writes. The full trace query must resolve
        every attempt, artifact, command, PR, audit and idempotency record to exactly
        one organization, project and repository.

    - id: "P2-PLAN-HIGH-004"
      severity: "HIGH"
      location: "phase-02-architecture-v1.md:129-135; phase-02-data-model-v1.md:35-61; phase-02-threat-model-delta-v1.md:35,40; docs/operations/security-threat-model.md:21-33; docs/operations/multi-tenancy.md:3-7"
      consequence: >-
        ArtifactStore.get/verify accept only an ArtifactRef and therefore cannot
        enforce caller project scope. storage_key is described as digest-derived but
        not tenant-prefixed, and authoritative links are arbitrary JSONB ArtifactRefs
        rather than scoped foreign keys. The plan also calls S3 objects immutable
        without requiring conditional create semantics, so bytes can be overwritten
        or metadata can reference another project's artifact.
      required_change: >-
        Require TenantScope on every artifact operation; use tenant/project-prefixed
        digest keys or an equivalently enforced namespace; make authoritative
        references scoped foreign keys carrying artifact ID and expected checksum;
        use conditional create-only object writes; verify size and checksum before
        metadata commit and on every read; define orphan reconciliation after metadata
        failure.
      validation_method: >-
        Contract tests must prove project A cannot read, verify, infer existence of or
        attach project B's object; concurrent different-byte writes to one key must
        fail; overwrite attempts must fail; corrupted bytes, checksum/size mismatch,
        wrong-scope JSON references and object/metadata failure permutations must all
        fail closed.

    - id: "P2-PLAN-HIGH-005"
      severity: "HIGH"
      location: "phase-02-plan-v1.md:258-260; phase-02-data-model-v1.md:60-61; phase-02-architecture-v1.md:191-199; docs/architecture/03-domain-model.md:65-73; docs/implementation/definition-of-done.md:7-9"
      consequence: >-
        A result_ref row written before or after an external Git/GitHub side effect
        cannot atomically cover that side effect. A crash after push or PR creation
        but before recording the result will replay the operation. The table has no
        request hash, operation state, owner/fencing token or reconciliation state,
        and its uniqueness is not tenant-scoped.
      required_change: >-
        Specify a crash-safe side-effect protocol with tenant-scoped semantic keys,
        request fingerprints, PENDING/COMPLETED/FAILED state, ownership/fencing and
        remote reconciliation by natural key. Commit creation, exact-ref push and PR
        upsert must each distinguish retries from new business attempts and recover
        from crashes on both sides of the external call.
      validation_method: >-
        Fault-injection tests must terminate the executor immediately before and after
        each Git/object/GitHub call and before/after the corresponding database write.
        Restarting must converge to one commit, one expected remote ref and one PR,
        while reuse of a key with different input must fail.

    - id: "P2-PLAN-HIGH-006"
      severity: "HIGH"
      location: "phase-02-plan-v1.md:201-203,224,234-236,246-248; phase-02-architecture-v1.md:99-109,170-189; phase-02-research-register-v1.md:80-89"
      consequence: >-
        The plan asserts that the agent lacks .git write authority but does not define
        the OS mechanism. A linked worktree contains a writable .git indirection file;
        an in-process SDK or host process can overwrite it or reach shared Git
        metadata. Post-execution inspection is detection, not containment, and a
        malicious attempt can corrupt the mirror before inspection.
      required_change: >-
        Lock the Claude integration surface and execution topology before
        implementation. Run the untrusted agent in a separate sandboxed process with
        only the intended worktree files writable. Mount the .git indirection and all
        linked-worktree/mirror metadata read-only or omit them entirely and expose
        safe Git observations through trusted tooling. Do not run untrusted agent
        tools in the harness process.
      validation_method: >-
        OS-level tests from inside the agent sandbox must fail writes to .git,
        worktree administrative files, refs, objects, config, hooks and the mirror;
        host snapshots must remain byte-identical after commit/ref corruption
        attempts; the same tests must run through the real Claude adapter boundary.

    - id: "P2-PLAN-HIGH-007"
      severity: "HIGH"
      location: "phase-02-data-model-v1.md:32-34; phase-02-plan-v1.md:194-200,234-242; phase-02-threat-model-delta-v1.md:22,41; docs/operations/security-threat-model.md:7-20"
      consequence: >-
        repository_bindings stores an unconstrained remote_url used by trusted Git
        operations. Git accepts file, ssh, ext helpers, local paths, option-like
        values, submodule URLs and repository-controlled configuration. A malicious
        binding or repository can therefore trigger host file access, command
        execution, SSRF or credential leakage without ever invoking a shell.
      required_change: >-
        Construct clone/fetch URLs from validated forge identity instead of accepting
        an arbitrary transport URL. Allow only configured GitHub HTTPS hosts, reject
        userinfo and non-HTTPS/local/ext/ssh protocols, terminate option parsing,
        sanitize GIT_CONFIG*/SSH/askpass/proxy environment, disable unapproved
        protocols and hooks, and define a fail-closed submodule policy.
      validation_method: >-
        Real Git tests must reject file://, ext::, ssh, local paths, userinfo,
        newline/option injection, malicious insteadOf/config/askpass settings and
        hostile submodules while allowing only the configured GitHub host and exact
        repository identity.

    - id: "P2-PLAN-HIGH-008"
      severity: "HIGH"
      location: "phase-02-plan-v1.md:203-208,230,236; phase-02-exit-criteria-v1.md:30-47; packages/contracts/schema/evidence-bundle.schema.json:7-15; packages/observability/src/evidence.ts:29-54"
      consequence: >-
        The sequence builds the canonical EvidenceBundle before the harness commit,
        although resultSha is required and the final result SHA should be the
        harness-owned commit. The commit must also contain an ASEP-Evidence trailer.
        Without an explicit preallocated identity protocol, the commit and
        content-addressed evidence can become circular or the bundle will record a
        pre-commit/provider-supplied SHA.
      required_change: >-
        Define resultSha semantics as the final harness commit SHA. Preallocate a
        non-content-derived evidence artifact ID, run verification against the exact
        staged tree, commit with that stable ID in the trailer, then serialize and
        store the final bundle containing the resulting commit SHA before any push.
        Define recovery for a commit created before evidence persistence.
      validation_method: >-
        An integration test must reconstruct the chain from commit trailer to evidence
        artifact, verify EvidenceBundle.resultSha equals the pushed commit, verify the
        diff and checks correspond to that commit's tree, and recover without a second
        commit after crashes at each boundary.

    - id: "P2-PLAN-HIGH-009"
      severity: "HIGH"
      location: "phase-02-plan-v1.md:264-266,345-350; phase-02-risk-register-v1.md:10-16; phase-02-exit-criteria-v1.md:49-56,89-94; scripts/verify-all.sh:53-63; .github/workflows/ci.yml:16-45; scripts/lib/canonical-tests.mjs:91-102"
      consequence: >-
        Required PostgreSQL, MinIO and OS-enforced sandbox tests are not assigned a
        mandatory CI environment or required-suite marker. The existing CI provisions
        none of these services, while the risk register permits Docker tests to skip.
        CI can therefore pass while persistence, artifact or sandbox semantics never
        execute.
      required_change: >-
        Add a mandatory Phase 2 integration gate to verify-all and CI that provisions
        digest-pinned PostgreSQL, object storage and the verification sandbox, waits
        for health and fails rather than skips. Register machine-readable suite IDs
        for tenancy, migration, artifact, Git and sandbox critical suites. Only live
        Claude/GitHub tests may remain opt-in.
      validation_method: >-
        CI configuration tests must prove each required suite marker is enforced;
        deliberately unavailable PG/object storage/Docker must make the required job
        red; a clean CI run must report executed real-backend test counts and
        no-network canary evidence.

    - id: "P2-PLAN-HIGH-010"
      severity: "HIGH"
      location: "phase-02-plan-v1.md:141,152-157,270-284; phase-02-architecture-v1.md:115-127; phase-02-data-model-v1.md:102-107; phase-02-exit-criteria-v1.md:82-87; packages/contracts/src/validate.ts:48-61; packages/contracts/schema/run-event.schema.json:7-9,33-67"
      consequence: >-
        ExecutionEnvelope is called versioned but exists only as a TypeScript design
        sketch with no schema, validator, fixtures, compatibility policy or snapshot.
        Separately, exit criterion J2 requires every event to carry organization and
        repository IDs, but the closed RunEvent/v1 schema has neither field. The
        implementation must either make unplanned canonical changes or emit invalid
        events.
      required_change: >-
        Decide and document the envelope's contract class. Because it crosses
        API/CLI/worker/persistence and future Temporal boundaries, publish a canonical
        JSON Schema with generated type, AJV validation, fixtures and compatibility
        governance. Explicitly add optional organizationId and repositoryBindingId to
        RunEvent with the required minor version bump, or revise J2 and specify
        authoritative server-side correlation without claiming those fields are in
        RunEvent.
      validation_method: >-
        Boundary tests must reject malformed/unknown envelope versions; drift and
        compatibility gates must cover the new schema; persisted envelopes must
        round-trip without provider types; every emitted RunEvent must validate
        against its declared schema version.

  medium_findings:
    - id: "P2-PLAN-MED-001"
      severity: "MEDIUM"
      location: "phase-02-plan-v1.md:333-341; phase-02-exit-criteria-v1.md:89-95; docs/implementation/90-day-plan.md:13-22"
      consequence: >-
        The plan rejects synthetic fixtures but does not define whether all ten tasks
        must use the live provider and forge, reach a successful traceable outcome,
        be distinct business tasks rather than retries, and receive human
        adjudication. K2 requires only one live task, leaving a loophole for nine
        fake-provider or incomplete executions.
      required_change: >-
        Define a completed pilot task as a distinct, human-authorized WorkOrder run
        through real Claude, real sandbox, real GitHub App and real persistence,
        reaching the documented human-review outcome with a valid PR/evidence chain.
        Retries remain attempts under one task and do not increase the count.
      validation_method: >-
        A pilot manifest must list ten distinct task IDs, objectives, risks, base and
        result SHAs, provider sessions, PRs, evidence checksums and human dispositions;
        an automated verifier must reject duplicate tasks, fake adapters, failed
        traces and retry inflation.

    - id: "P2-PLAN-MED-002"
      severity: "MEDIUM"
      location: "phase-02-plan-v1.md:228-230,264-266; phase-02-architecture-v1.md:157-168; docs/architecture/adr/0009-raw-evidence-before-reduction.md:10-16"
      consequence: >-
        Raw output is promised but the port does not define streaming, byte limits,
        backpressure, truncation markers or behavior when artifact persistence fails.
        A noisy or malicious command can exhaust memory/disk, while silent truncation
        can destroy forensic evidence.
      required_change: >-
        Specify bounded streaming capture directly to immutable artifacts, separate
        display limits from evidence retention, record byte counts and explicit
        truncation/overflow state, and fail mandatory verification if complete
        evidence cannot be persisted.
      validation_method: >-
        Tests must generate output beyond UI and resource thresholds, verify exact
        retained bytes or explicit fail-closed overflow, preserve exit/signal data,
        and prove reducers never receive uncaptured output.

    - id: "P2-PLAN-MED-003"
      severity: "MEDIUM"
      location: "phase-02-plan-v1.md:192-212,282-299; phase-02-architecture-v1.md:191-199; docs/architecture/adr/0001-durable-orchestration.md:10-16; docs/architecture/adr/0013-no-framework-soup.md:10-16; docs/implementation/90-day-plan.md:24-31"
      consequence: >-
        Treating the entire multi-side-effect execute-task orchestration as one future
        Temporal activity gives Temporal little visibility into step-level retries,
        heartbeats and cancellation, while PostgreSQL checkpoints risk becoming a
        second durable orchestrator.
      required_change: >-
        Separate framework-free, idempotent step use cases from the Phase 2 sequential
        driver. Document which state is operational projection versus orchestration
        authority so Phase 3 can compose the same steps as Temporal activities without
        duplicating workflow ownership.
      validation_method: >-
        Provide a second thin test driver that resumes from each persisted step and
        demonstrate a Temporal-shaped fake workflow can compose the same step APIs
        with activity-level idempotency, heartbeat and cancellation boundaries.

    - id: "P2-PLAN-MED-004"
      severity: "MEDIUM"
      location: "phase-02-plan-v1.md:240-242; phase-02-threat-model-delta-v1.md:45; phase-02-exit-criteria-v1.md:67-74; phase-02-research-register-v1.md:88-91"
      consequence: >-
        Webhook HMAC/dedup is simultaneously promised, conditional and an open
        question, although inbound webhooks are not needed to create/update a Phase 2
        PR. This adds an externally exposed attack surface without a current vertical
        slice use case.
      required_change: >-
        Decide before plan lock. Prefer deferring inbound webhooks and remove their
        Phase 2 MUST/threat claims; if retained, identify the concrete current use
        case, authenticated route, payload limits, event allowlist, durable delivery
        deduplication and secret-rotation design.
      validation_method: >-
        The locked scope and exit criteria must agree. If deferred, no webhook route
        or dependency may exist. If retained, negative signature, replay,
        oversized-body, unsupported-event and rotated-secret tests are mandatory.

    - id: "P2-PLAN-MED-005"
      severity: "MEDIUM"
      location: "phase-02-plan-v1.md:240-242; phase-02-architecture-v1.md:180-182; phase-02-research-register-v1.md:52-58"
      consequence: >-
        JIT minting is described, but token expiry metadata, renewal after expiry,
        revocation and an authentication failure during push/PR creation are not.
        A roughly one-hour token can expire during a long attempt or retry.
      required_change: >-
        Treat credentials as opaque values paired with provider-reported expiry,
        mint separately for each bounded forge operation, never persist them, and
        define one safe re-mint/reconcile path for authentication expiry without
        replaying completed side effects.
      validation_method: >-
        Fake-clock transport tests must cover expiry before and during operations,
        revocation, rotation and re-minting, while log/artifact/database scans prove
        neither token value nor private key is retained.

    - id: "P2-PLAN-MED-006"
      severity: "MEDIUM"
      location: "phase-02-data-model-v1.md:88-100; phase-02-exit-criteria-v1.md:23-28; docs/implementation/definition-of-done.md:7-10"
      consequence: >-
        Migration validation covers clean forward application and checksum drift but
        does not explicitly require a second no-op run, concurrent migrator locking,
        transactional failure behavior or recovery from a partially applied
        non-transactional migration.
      required_change: >-
        Define migration locking, transaction rules, repeat-apply behavior and
        recovery policy. Applied migration files remain immutable and checksum
        mismatches must fail before executing later migrations.
      validation_method: >-
        Real PostgreSQL tests must apply twice, run two migrators concurrently,
        inject mid-migration failure, restart, and reject an edited applied migration.

    - id: "P2-PLAN-MED-007"
      severity: "MEDIUM"
      location: "phase-02-exit-criteria-v1.md:82-101; phase-02-plan-v1.md:270-272,327-335; docs/implementation/definition-of-done.md:3-15"
      consequence: >-
        Exit criteria require traces and audit but omit the Definition of Done's
        metrics dashboards, operator runbook, outage/recovery procedures and
        observation/rollback thresholds. A ten-task pilot would therefore lack an
        agreed operational interpretation of failure and recovery.
      required_change: >-
        Add pilot runbook, metrics/dashboard requirements, alert or observation
        thresholds, artifact/DB/GitHub outage recovery, retention/cleanup procedure
        and explicit rollback/stop conditions.
      validation_method: >-
        Conduct and preserve a pilot rehearsal covering provider timeout, DB restart,
        object-store outage, stale lease and GitHub rate limiting; verify dashboards
        and the runbook lead to the documented stop/recovery decision.

    - id: "P2-PLAN-MED-008"
      severity: "MEDIUM"
      location: "phase-02-architecture-v1.md:175-182; phase-02-plan-v1.md:216-218; phase-02-research-register-v1.md:9-24; docs/architecture/adr/0005-provider-ports.md:10-16"
      consequence: >-
        GitHubAppCredentialProvider is proposed as a shared application port despite
        being GitHub-specific, and most new dependencies use caret ranges despite the
        risk register saying versions will be pinned exactly. This weakens the
        provider-neutral boundary and supply-chain reproducibility.
      required_change: >-
        Keep GitHub credential minting internal to the GitHub adapter/composition
        root; application code should depend only on ForgeProvider. Reconcile the
        dependency policy by using exact direct dependency versions or explicitly
        documenting why lockfile-only pinning satisfies the threat model.
      validation_method: >-
        Architecture tests must reject GitHub installation/token types outside the
        adapter and composition root. Manifest tests must assert the locked version
        policy and frozen-lockfile installation from a clean checkout.

  low_findings:
    - id: "P2-PLAN-LOW-001"
      severity: "LOW"
      location: "phase-02-plan-v1.md:131-141; phase-02-exit-criteria-v1.md:14-20; phase-02-architecture-v1.md:75-98; apps/control-plane-api/src/index.ts:1-24"
      consequence: >-
        Calling apps and workers composition roots only is too literal: the
        control-plane app necessarily owns HTTP routing, validation and response
        mapping. An imprecise architecture test could reject legitimate driving
        adapter code or fail to detect actual business logic.
      required_change: >-
        Define composition-root-only as no domain decisions, persistence queries,
        provider calls or workflow sequencing in handlers, while allowing transport
        parsing, authentication hooks, validation and response mapping.
      validation_method: >-
        Architecture mutation tests must reject a seeded policy/SQL/Git/provider call
        in a handler while accepting a thin route that maps an authenticated request
        to an application use case.

  scope_leaks:
    - "P2-PLAN-MED-004"
    - "No Temporal runtime, scheduler, second-model runtime reviewer, Web Console, multi-agent runtime or memory implementation is otherwise planned."

  missing_invariants:
    - "P2-PLAN-CRIT-001"
    - "P2-PLAN-HIGH-001"
    - "P2-PLAN-HIGH-003"
    - "P2-PLAN-HIGH-004"
    - "P2-PLAN-HIGH-005"
    - "P2-PLAN-HIGH-006"
    - "P2-PLAN-HIGH-008"

  unnecessary_complexity:
    - "P2-PLAN-MED-004"
    - "Consider deferring the S3 adapter until the filesystem-backed vertical slice is proven unless MinIO is required for the ten live pilots."

  provider_lock_in:
    - "P2-PLAN-MED-008"
    - "The Claude model is otherwise appropriately placed behind a provider port, subject to P2-PLAN-HIGH-002."

  phase_3_coupling_risks:
    - "P2-PLAN-HIGH-005"
    - "P2-PLAN-HIGH-010"
    - "P2-PLAN-MED-003"

  security_gaps:
    - "P2-PLAN-CRIT-001"
    - "P2-PLAN-HIGH-001"
    - "P2-PLAN-HIGH-003"
    - "P2-PLAN-HIGH-004"
    - "P2-PLAN-HIGH-006"
    - "P2-PLAN-HIGH-007"
    - "P2-PLAN-MED-002"
    - "P2-PLAN-MED-005"

  test_gaps:
    - "P2-PLAN-HIGH-009"
    - "P2-PLAN-MED-001"
    - "P2-PLAN-MED-002"
    - "P2-PLAN-MED-006"

  operational_gaps:
    - "P2-PLAN-HIGH-005"
    - "P2-PLAN-MED-003"
    - "P2-PLAN-MED-005"
    - "P2-PLAN-MED-007"

  required_plan_changes:
    - "Resolve P2-PLAN-CRIT-001 before implementation: make direct protected/default-ref mutation and merge impossible by construction and repository policy."
    - "Add an explicit Phase 2 risk-admission matrix that preserves the locked Phase 1 approval and verification policies."
    - "Replace the as-is CodingAgentProvider reuse with a request-scoped workspace, attempt, policy and cancellation contract."
    - "Redesign tenancy constraints and authorization around server-derived TenantScope plus database-enforced hierarchical consistency."
    - "Make artifact operations scope-aware, create-only, checksum-bound and relationally consistent."
    - "Replace result-only idempotency rows with a crash-safe side-effect and reconciliation protocol."
    - "Specify OS-enforced agent separation from Git metadata and constrain all Git transports and configuration."
    - "Correct EvidenceBundle/commit ordering and define final resultSha semantics."
    - "Wire real PostgreSQL, object-store, Git and sandbox suites as mandatory CI gates that cannot skip."
    - "Publish and govern ExecutionEnvelope as a real versioned boundary contract and reconcile RunEvent fields with J2."
    - "Define ten-task completion so all ten are distinct live, traceable pilot outcomes rather than retries or fake-edge executions."

  optional_improvements:
    - "Defer inbound webhooks and possibly the S3 adapter until a current Phase 2 pilot use case requires them."
    - "Clarify application/worker architecture-test semantics so transport code is permitted but business decisions remain excluded."
    - "Add a machine-verifiable pilot manifest and evidence-chain verifier to prevent task-count inflation."
```
