# Phase 1 Plan — Independent Codex Review (v1)

- Reviewer: codex CLI (gpt-5.6-sol via vibecc, reasoning=high), read-only sandbox
- Base SHA: 83ba33db16072f05fb27f00f34cebd6774cb771a
- Reviewed file: docs/implementation/phases/phase-01-plan-v1.md
- Date: 2026-07-14

```yaml
review:
  verdict: REQUEST_CHANGES
  confidence: 0.98
  summary: >-
    The plan correctly excludes Temporal runtime, real provider adapters, memory
    systems, experimental reducers, and UI work. It also proposes the required
    twelve contracts, negative evaluations, false-completion and accepted-task
    cost metrics, one-writer execution, per-slice commits, and raw evidence.
    However, it does not deliver Phase 1 as defined: the pilot repository,
    30–50 genuine historical tasks, and empirical baseline are explicitly
    deferred. Contract, policy, compatibility, publication, evidence-storage,
    and completion-sentinel details also permit silent drift or unsafe public
    publication. These are material but repairable plan defects.

  critical_findings:
    - id: P1-CRIT-001
      severity: CRITICAL
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§5, 14, 15, 20–21; docs/implementation/90-day-plan.md Days 1–15"
      evidence: >-
        The 90-day plan requires choosing one pilot repository, collecting
        30–50 historical tasks, establishing baseline metrics, and exiting only
        when historical tasks can be represented and graded deterministically.
        The Phase 1 plan instead limits the dataset to at most ten synthetic
        seeds, states that metrics will not be empirically validated, and
        defers the pilot and historical tasks to Phase 2 or a later production
        dependency.
      consequence: >-
        Phase 1 could be declared complete without exercising its contracts,
        graders, risk rules, or metrics on the target task distribution. The
        stated Phase 1 exit criterion would therefore be false.
      required_change: >-
        Add selection of a real pilot repository and a provenance-controlled,
        privacy-reviewed set of 30–50 genuine historical tasks to Phase 1.
        Represent every task using the approved contracts, run deterministic
        graders, and publish a baseline scorecard. Synthetic adversarial
        fixtures should supplement rather than replace this dataset.
      validation_method: >-
        Verify a dataset manifest containing 30–50 unique historical task IDs,
        source references, labels, provenance, privacy classification, and
        grader expectations; run the evaluator twice from a clean checkout and
        confirm identical results and a generated baseline report.

  high_findings:
    - id: P1-HIGH-001
      severity: HIGH
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§9–11; packages/contracts/src/index.ts; templates/*.yaml"
      evidence: >-
        The repository already has incompatible representations of the same
        contracts. TypeScript contracts are flat, while templates use
        apiVersion/kind/metadata/spec envelopes and nested structures such as
        WorkOrder.spec.repository and ContextPack.spec.policy. The change map
        does not update or validate these templates. The proposed drift guard
        allows either generated types or a checked-in mapping, and runtime
        validation may be AJV-based or handwritten.
      consequence: >-
        JSON Schema, TypeScript, templates, fixtures, and handwritten
        validators could each accept different payloads while the advertised
        schema/type drift test still passes.
      required_change: >-
        Designate one authoritative contract representation, preferably JSON
        Schema. Generate TypeScript types and validators from it, or verify
        generated output byte-for-byte in CI. Validate every existing YAML
        template against its schema and remove handwritten duplicate shapes.
      validation_method: >-
        CI regenerates types and validators into a temporary directory, fails
        on any diff, and validates all templates plus positive and negative
        fixtures against the same compiled schemas.

    - id: P1-HIGH-002
      severity: HIGH
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§3, 10–12, 20"
      evidence: >-
        The compatibility strategy says optional additions are minor and
        breaking changes require a new major ID, but it does not define
        producer-versus-consumer compatibility, enum changes, property
        closure, format changes, numeric constraints, or an executable
        comparison against previously released schemas. The exit criteria
        mention a compatibility policy but not a compatibility regression
        gate.
      consequence: >-
        A schema change can be labeled additive while breaking stored
        documents, older consumers, generated types, or future producers.
      required_change: >-
        Specify the JSON Schema draft and exact backward/forward compatibility
        rules. Preserve released schema snapshots and add an automated
        compatibility checker covering required fields, enums, formats,
        additionalProperties, constraints, and major-version transitions.
      validation_method: >-
        Run compatibility fixtures containing known compatible and
        incompatible schema changes and require the checker to classify every
        case correctly against the checked-in v1 baseline.

    - id: P1-HIGH-003
      severity: HIGH
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§9, 11; packages/policy/src/index.ts; policies/risk-policy.yaml"
      evidence: >-
        The plan extends both TypeScript policy modules and YAML policy files
        without naming an authoritative source or a drift guard. Existing
        sources already differ: TypeScript assigns two independent reviewers
        to R4, while risk-policy.yaml omits that field for R4; TypeScript also
        includes auto-merge and different-model-family decisions not
        consistently represented in YAML.
      consequence: >-
        Risk routing, verification, approval, and runtime behavior may depend
        on which representation a component reads, violating ADR 0006 and the
        single-owner rule in ADR 0013.
      required_change: >-
        Make the policy data file or typed table canonical and derive the other
        representation. Include change categories, risk mapping, verification
        levels, approvals, and failure taxonomy in one versioned policy model.
      validation_method: >-
        Add a CI test that loads the canonical policy and asserts exact parity
        for every R0–R4 decision exposed by the TypeScript API, including
        negative and unknown-category cases.

    - id: P1-HIGH-004
      severity: HIGH
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§9, 13, 18, 20; ADR 0002; ADR 0009"
      evidence: >-
        S6 adds artifacts/phase-01/**, and §18 says that directory stores
        command output or checksums. Section 20 simultaneously requires no
        artifact in the tree. The current ignore rule covers .artifacts/, not
        artifacts/. Raw stdout, stderr, environment details, and commands can
        contain credentials, source fragments, usernames, or absolute paths.
      consequence: >-
        Generated evidence may be committed to the public repository, leak
        sensitive information, grow indefinitely, and confuse Git with the
        immutable artifact store identified by ADR 0002.
      required_change: >-
        Store raw evidence in an ignored or external immutable artifact
        location. Commit only a sanitized evidence manifest containing hashes,
        tool versions, exit status, and stable artifact references. Define
        retention, redaction, access, and integrity rules.
      validation_method: >-
        Execute gates containing synthetic secret and absolute-path canaries;
        confirm raw output remains outside Git, the committed manifest contains
        only safe metadata and hashes, and a clean-tree check passes afterward.

    - id: P1-HIGH-005
      severity: HIGH
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§1, 4, 9, 12–13; LICENSE-POLICY.md"
      evidence: >-
        The plan states that Apache-2.0 is confirmed, but the repository's
        LICENSE-POLICY.md says the license must be selected with legal counsel
        before public distribution and describes Apache-2.0 only as a common
        default. The proposed gates check license-file presence and use a
        'gitleaks-style grep', but do not specify dependency-license scanning,
        imported-content provenance, attribution, full-history secret
        scanning, or scanner self-tests.
      consequence: >-
        The repository could be published under an unapproved or incompatible
        license, with unrecorded third-party obligations or secrets missed by
        an ad hoc grep.
      required_change: >-
        Treat license approval as blocking unless documented in the repository.
        Add a machine-readable provenance/license inventory, dependency-license
        policy, attribution check, pinned secret scanner over tracked files and
        Git history, and positive/negative scanner fixtures.
      validation_method: >-
        Require recorded approval, a compatible dependency-license report,
        complete provenance entries for imported material, and scanner tests
        that detect seeded secrets while allowing documented placeholders.

    - id: P1-HIGH-006
      severity: HIGH
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§0, 6, 20, 22; docs/implementation/90-day-plan.md Days 16–30"
      evidence: >-
        The plan declares forge integration out of scope but makes a gated
        public push and an existing branch/PR part of Phase 1 completion.
        GitHub/forge integration belongs to Days 16–30. The GitHub owner and
        repository name are also unresolved, so an asserted Phase 1 exit
        condition depends on unavailable external information.
      consequence: >-
        Phase 1 gains an unnecessary external side effect, cannot complete
        deterministically from repository inputs, and crosses into Phase 2.
      required_change: >-
        Limit S1 to public-readiness files and offline publication checks.
        Remove repository creation, push, and PR existence from Phase 1 exit
        criteria; perform those actions under the Phase 2 forge-integration
        work or a separate human publication procedure.
      validation_method: >-
        Confirm Phase 1 can complete from a clean local checkout without GitHub
        credentials, remote creation, pushing, or PR APIs.

    - id: P1-HIGH-007
      severity: HIGH
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§0, 19–20"
      evidence: >-
        The implementer touches .task-complete before the final reviewer runs,
        while the exit criteria say .task-complete is last. The plan does not
        define removal or invalidation of the sentinel when review requests
        repairs or HEAD changes.
      consequence: >-
        A stale sentinel can report completion for an unreviewed or superseded
        commit, reproducing the false-completion condition the phase intends to
        measure.
      required_change: >-
        Separate implementation completion from phase acceptance. Bind each
        sentinel to the exact HEAD SHA and gate-manifest hash, invalidate it on
        repair, and create the final acceptance marker only after independent
        review and all repair gates pass.
      validation_method: >-
        Simulate reviewer rejection and repair; verify the old marker becomes
        invalid and dispatch cannot report completion until a new marker
        matches the final reviewed HEAD and evidence manifest.

    - id: P1-HIGH-008
      severity: HIGH
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§0, 16, 18 and final PLAN_STATUS block"
      evidence: >-
        The plan intended for a public repository contains session-specific
        infrastructure and operator details, including the 9router endpoint,
        authentication assumptions, ~/.openclaw and ~/.local paths, named
        local scripts, prompt sequencing, and an incident-like note about a
        prior staging mistake. Its proposed path scan targets absolute paths,
        usernames, and email but would not necessarily catch tilde paths,
        internal service names, or operational topology.
      consequence: >-
        Committing the plan can expose internal tooling and infrastructure,
        produce non-reproducible public instructions, and enlarge the attack
        surface.
      required_change: >-
        Remove session-local execution details from public architecture and
        implementation documents. Put necessary operator instructions in a
        separately classified runbook and expand publication scanning to
        internal endpoints, home-relative paths, credentials, and tool-specific
        run directories.
      validation_method: >-
        Run publication scanning against seeded internal endpoint and tilde-path
        fixtures, and manually verify that committed Phase 1 documents contain
        only repository-relative, portable instructions.

  medium_findings:
    - id: P1-MED-001
      severity: MEDIUM
      file_or_section: ".gitignore; package.json; docs/implementation/phases/phase-01-plan-v1.md §§4, 9, 12, 20"
      evidence: >-
        TypeScript build-info files are currently untracked and not ignored in
        every package. The S1 ignore update does not mention *.tsbuildinfo.
        CI proposes a format check, but package.json has no format script or
        formatter. The existing pnpm verify runs only typecheck and tests, so it
        is not equivalent to the proposed full gate set.
      consequence: >-
        Local verification dirties the worktree, generated files may be
        accidentally staged, and CI/local evidence may disagree or fail due to
        a nonexistent command.
      required_change: >-
        Ignore all generated build metadata, add a post-verification clean-tree
        assertion, and define one repository-owned verification command used
        identically by local execution and CI. Add a real formatter command or
        remove the format gate.
      validation_method: >-
        Run the canonical verification command from a clean checkout and assert
        zero untracked/generated files, zero Git diff, and identical commands
        in CI.

    - id: P1-MED-002
      severity: MEDIUM
      file_or_section: "docs/implementation/definition-of-done.md; docs/architecture/02-bounded-contexts.md; docs/implementation/phases/phase-01-plan-v1.md §11"
      evidence: >-
        The Definition of Done requires architecture tests, and the bounded
        context documentation defines an explicit dependency direction. The
        Phase 1 test strategy does not include a dependency fitness test
        preventing contracts/domain from importing provider SDKs, adapters, or
        application packages.
      consequence: >-
        Provider coupling or reversed dependencies can enter while unit,
        schema, and type tests remain green.
      required_change: >-
        Add an architecture test enforcing the documented package dependency
        direction and prohibiting provider/framework dependencies from
        contracts and domain packages.
      validation_method: >-
        Include deliberately invalid dependency fixtures or a temporary
        mutation proving CI rejects domain-to-adapter and contracts-to-provider
        imports.

    - id: P1-MED-003
      severity: MEDIUM
      file_or_section: "docs/implementation/90-day-plan.md Days 1–15; docs/platform/technology-radar.md; docs/implementation/phases/phase-01-plan-v1.md §§5, 20"
      evidence: >-
        Phase 1 requires accepted ADRs and a source/technology radar. ADR files
        are marked Accepted, but the technology radar has no approval status,
        approver, or lock criterion, and the Phase 1 exit list does not verify
        either artifact.
      consequence: >-
        Phase 2 may begin using architecture or technology choices that were
        never formally approved as Phase 1 inputs.
      required_change: >-
        Add a machine-checkable approval record for the ADR set, source
        register, and technology radar, including version/hash, decision owner,
        date, and status.
      validation_method: >-
        The exit checker verifies that every required document hash appears in
        an approved Phase 1 decision manifest with no DRAFT or unresolved
        status.

    - id: P1-MED-004
      severity: MEDIUM
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§9, 14; docs/platform/measurement-and-evaluation.md"
      evidence: >-
        The measurement dictionary includes formulas, source-events, and a
        privacy field, but the plan does not require source-event names and
        fields to resolve to the RunEvent contract. It also does not define the
        allowed privacy classes or their retention, redaction, and access
        behavior.
      consequence: >-
        Metrics can be formally present but impossible to compute, or collect
        data under an undefined privacy policy.
      required_change: >-
        Define a versioned event catalog and privacy-class enum with handling
        rules. Add referential-integrity checks from every formula operand and
        source event to a RunEvent type and field.
      validation_method: >-
        Fail validation for an unknown event, missing field, dimension without
        a source, undefined denominator behavior, or unknown privacy class.

    - id: P1-MED-005
      severity: MEDIUM
      file_or_section: "MANIFEST.sha256; VALIDATION.md; docs/implementation/phases/phase-01-plan-v1.md §§9, 12–13"
      evidence: >-
        The repository publishes a file manifest and a validation report tied
        to the imported baseline. Phase 1 will add and modify many files, but
        neither file appears in the change map or CI freshness checks.
      consequence: >-
        The public repository can ship stale integrity metadata and a
        validation report describing a different tree and test count.
      required_change: >-
        Regenerate the manifest deterministically and update or clearly
        supersede the validation report. Add a CI freshness check for both.
      validation_method: >-
        Recompute hashes from a clean checkout and require exact equality with
        the committed manifest; verify the report records final HEAD,
        environment, commands, and current gate results.

    - id: P1-MED-006
      severity: MEDIUM
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§0, 17, 20; ADR 0004"
      evidence: >-
        The plan says the worktree is removable and one writer is used, but it
        has no explicit lease acquisition/release record, stale-worktree
        cleanup task, orphan check, or exit criterion proving cleanup after
        success, interruption, or review repair.
      consequence: >-
        An interrupted phase can leave stale leases, branches, worktrees, or
        misleading completion markers, weakening the one-writer guarantee.
      required_change: >-
        Define lease identity and lifecycle, cleanup behavior for all terminal
        paths, and an exit check for orphaned worktrees and stale sentinels.
      validation_method: >-
        Interrupt execution before and after a slice commit, resume it, and
        verify one active writer, preserved commits/evidence, released lease,
        and no orphaned workspace at completion.

  low_findings: []

  missing_exit_criteria:
    - id: P1-EXIT-001
      severity: CRITICAL
      file_or_section: "Phase 1 exit criteria"
      evidence: "No criterion requires a selected pilot repository and 30–50 genuine historical tasks."
      consequence: "The explicit Days 1–15 dataset commitment can be deferred while Phase 1 is marked complete."
      required_change: "Add pilot selection and historical dataset acceptance criteria."
      validation_method: "Validate repository binding and a 30–50-entry provenance-controlled dataset manifest."

    - id: P1-EXIT-002
      severity: HIGH
      file_or_section: "Phase 1 exit criteria and measurement strategy"
      evidence: "The plan defines metrics but explicitly declines empirical baseline validation."
      consequence: "No before-state exists for evaluating later harness, model, prompt, or skill changes."
      required_change: "Require a reproducible baseline scorecard over the historical dataset."
      validation_method: "Re-run the baseline from clean checkout and compare deterministic results and declared tolerances."

    - id: P1-EXIT-003
      severity: HIGH
      file_or_section: "Phase 1 exit criteria and contract/versioning strategy"
      evidence: "No exit gate compares current schemas with released schema snapshots."
      consequence: "A breaking contract change can pass all fixture and drift tests."
      required_change: "Add executable backward/forward compatibility acceptance criteria."
      validation_method: "Run known compatible and incompatible schema mutations through the compatibility checker."

    - id: P1-EXIT-004
      severity: MEDIUM
      file_or_section: "Phase 1 exit criteria and technology governance"
      evidence: "No criterion verifies approval of the technology radar and source register."
      consequence: "Required Phase 1 governance inputs remain informal."
      required_change: "Require an approved, hashed decision manifest for ADRs, radar, and sources."
      validation_method: "Fail exit validation for missing hashes, owners, dates, or non-approved status."

    - id: P1-EXIT-005
      severity: MEDIUM
      file_or_section: "Phase 1 exit criteria and execution cleanup"
      evidence: "Tree cleanliness is checked, but worktree leases, stale markers, and orphan cleanup are not."
      consequence: "The implementation can leave unsafe execution state despite a clean branch."
      required_change: "Add lease release, stale-sentinel absence, and orphan-worktree checks."
      validation_method: "Inspect registered worktrees and execution metadata after success and interrupted-resume tests."

  unnecessary_scope:
    - id: P1-SCOPE-001
      severity: HIGH
      file_or_section: "docs/implementation/phases/phase-01-plan-v1.md §§0, 20, 22"
      evidence: >-
        Public repository creation, push, and PR existence are made part of
        Phase 1 even though forge integration is assigned to Days 16–30 and is
        declared out of scope elsewhere in the same plan.
      consequence: "Phase 1 gains external side effects and an unresolved GitHub dependency unrelated to deterministic historical grading."
      required_change: "Keep offline public-readiness checks; defer remote creation, push, and PR creation."
      validation_method: "Complete every Phase 1 gate without a configured Git remote or GitHub credential."

  architecture_conflicts:
    - id: P1-ARCH-001
      severity: HIGH
      file_or_section: "Policy implementation plan; ADR 0006; ADR 0013"
      evidence: "Risk and approval decisions are duplicated across YAML and TypeScript with no named owner or generation direction."
      consequence: "The system can have multiple assurance authorities and inconsistent R0–R4 behavior."
      required_change: "Establish one canonical policy model and derive all runtime representations."
      validation_method: "Assert exact parity for all policy outputs and fail on duplicate independently maintained tables."

    - id: P1-ARCH-002
      severity: HIGH
      file_or_section: "Evidence plan; ADR 0002; ADR 0009"
      evidence: "Raw evidence is assigned to a repository artifacts directory despite immutable artifacts being a separate canonical-state component."
      consequence: "Git may accidentally become the raw artifact store and public distribution channel."
      required_change: "Keep raw artifacts external or ignored and commit only sanitized, content-addressed manifests."
      validation_method: "Verify raw stdout/stderr are retrievable by hash but absent from Git."

    - id: P1-ARCH-003
      severity: MEDIUM
      file_or_section: "Contract plan; docs/architecture/02-bounded-contexts.md"
      evidence: "Provider independence is stated but not enforced by an architecture dependency test."
      consequence: "Future schema or validator work can introduce provider/framework coupling undetected."
      required_change: "Add dependency fitness rules for contracts, domain, ports, adapters, and provider SDKs."
      validation_method: "Prove forbidden imports fail CI."

  security_publication_risks:
    - id: P1-PUB-001
      severity: HIGH
      file_or_section: "LICENSE-POLICY.md and Phase 1 publication gates"
      evidence: "Repository evidence does not confirm Apache-2.0 approval, despite the plan treating it as confirmed."
      consequence: "Publication may occur under an unauthorized license."
      required_change: "Record approval or retain publication as blocked."
      validation_method: "Check an approved license decision record before allowing publication."

    - id: P1-PUB-002
      severity: HIGH
      file_or_section: "Phase 1 evidence and artifact paths"
      evidence: "Raw commands, output, and environment data may be placed under a non-ignored artifacts/ directory."
      consequence: "Secrets, internal paths, or proprietary source may be committed."
      required_change: "Separate raw evidence storage from public Git and enforce redaction/classification."
      validation_method: "Use secret/path canaries and verify no canary appears in tracked content."

    - id: P1-PUB-003
      severity: HIGH
      file_or_section: "Phase 1 plan document and publication scanner"
      evidence: "The plan itself contains internal endpoint, authentication, home-directory, and local-tool details."
      consequence: "Public documentation can disclose internal operational topology."
      required_change: "Sanitize the plan and scan for internal endpoints and home-relative paths."
      validation_method: "Run expanded scanner fixtures and manual public-content review."

    - id: P1-PUB-004
      severity: HIGH
      file_or_section: "Historical evaluation dataset"
      evidence: "The required historical tasks have no specified licensing, consent, privacy, or publication classification."
      consequence: "Fixing the dataset omission could expose private issues, code, customer data, or employee information."
      required_change: "Define dataset provenance and privacy review, allowing private content-addressed datasets when public release is prohibited."
      validation_method: "Require classification and publication eligibility for every historical task record."

  test_gaps:
    - id: P1-TEST-001
      severity: HIGH
      file_or_section: "templates/*.yaml and contract tests"
      evidence: "Existing templates are not included in the schema-validation test plan despite differing structurally from TypeScript types."
      consequence: "Public examples may remain invalid after canonical schemas are introduced."
      required_change: "Validate every template against the corresponding schema."
      validation_method: "Include templates in the contract-test file discovery and fail on any validation error."

    - id: P1-TEST-002
      severity: HIGH
      file_or_section: "Contract compatibility tests"
      evidence: "Valid/invalid instance fixtures do not test evolution compatibility between schema versions."
      consequence: "Breaking schema changes can pass."
      required_change: "Add schema-diff compatibility fixtures and released-version snapshots."
      validation_method: "Verify known compatible and breaking changes are classified correctly."

    - id: P1-TEST-003
      severity: HIGH
      file_or_section: "Risk policy tests"
      evidence: "No test is specified to prevent YAML and TypeScript policy drift."
      consequence: "Different components may apply different assurance requirements."
      required_change: "Add canonical policy generation or exact parity tests."
      validation_method: "Compare all R0–R4 outputs and every change category across representations."

    - id: P1-TEST-004
      severity: MEDIUM
      file_or_section: "Architecture test strategy"
      evidence: "No dependency-direction or provider-SDK prohibition test is planned."
      consequence: "Framework coupling can enter domain contracts."
      required_change: "Add architecture fitness tests."
      validation_method: "Inject forbidden dependency fixtures and require CI failure."

    - id: P1-TEST-005
      severity: HIGH
      file_or_section: "Evaluation strategy"
      evidence: "Prompt-injection, scope-violation, false-completion, and synthetic labels are planned, but no historical-task evaluation is included."
      consequence: "The runner is tested only against invented distributions."
      required_change: "Run the same graders over 30–50 genuine historical tasks with immutable labels."
      validation_method: "Generate deterministic per-task results and aggregate baseline metrics twice with identical output."

    - id: P1-TEST-006
      severity: MEDIUM
      file_or_section: "Publication and CI scanners"
      evidence: "Scanner implementation and positive/negative test fixtures are unspecified."
      consequence: "A scanner may always pass, over-match placeholders, or scan only the working tree."
      required_change: "Pin scanners and add canary tests for secrets, large files, paths, licenses, and history."
      validation_method: "Confirm seeded violations fail and documented safe fixtures pass."

  measurement_gaps:
    - id: P1-METRIC-001
      severity: CRITICAL
      file_or_section: "Phase 1 measurement strategy"
      evidence: "The plan defines metric contracts but explicitly postpones empirical validation and lacks the required historical baseline."
      consequence: "Later changes have no trustworthy comparison point."
      required_change: "Compute and version the Phase 1 baseline over the real historical dataset."
      validation_method: "Reproduce the baseline from dataset and harness version identifiers."

    - id: P1-METRIC-002
      severity: MEDIUM
      file_or_section: "Measurement dictionary and RunEvent contract"
      evidence: "No referential-integrity rule connects metric operands and source-event names to RunEvent fields."
      consequence: "Formulas such as false-completion rate or accepted-task cost may be documented but not computable."
      required_change: "Validate every numerator, denominator, dimension, and cost component against the event catalog."
      validation_method: "Fail dictionary validation for unknown events, fields, dimensions, or zero-denominator policy."

    - id: P1-METRIC-003
      severity: MEDIUM
      file_or_section: "Measurement privacy classification"
      evidence: "A privacy field is planned without an enum or operational handling rules."
      consequence: "Sensitive prompts, source, reviewer evidence, and historical task data may receive inconsistent treatment."
      required_change: "Define privacy classes with capture defaults, redaction, retention, access, and publication rules."
      validation_method: "Schema validation rejects unknown classes and policy tests verify handling for each class."

  required_plan_changes:
    - id: P1-CHANGE-001
      severity: CRITICAL
      file_or_section: "Scope and exit criteria"
      evidence: "Pilot selection, 30–50 historical tasks, and baseline measurement are deferred."
      consequence: "The plan cannot satisfy the stated Phase 1 exit."
      required_change: "Move all three into Phase 1 and make them blocking exit criteria."
      validation_method: "Review dataset manifest and reproducible baseline output."

    - id: P1-CHANGE-002
      severity: HIGH
      file_or_section: "Contract strategy"
      evidence: "Multiple contract representations and optional handwritten validators are allowed."
      consequence: "Silent contract drift remains possible."
      required_change: "Choose one schema source, generate types/validators, and validate templates."
      validation_method: "Regeneration-diff and template-validation gates pass."

    - id: P1-CHANGE-003
      severity: HIGH
      file_or_section: "Compatibility strategy"
      evidence: "Compatibility rules are descriptive rather than executable."
      consequence: "Breaking changes can be released as minor updates."
      required_change: "Add version snapshots and an automated compatibility checker."
      validation_method: "Compatibility mutation fixtures pass."

    - id: P1-CHANGE-004
      severity: HIGH
      file_or_section: "Risk, verification, approval, and failure policy"
      evidence: "YAML and TypeScript are independent mutable sources."
      consequence: "Assurance behavior can diverge."
      required_change: "Consolidate policy authority and add parity tests."
      validation_method: "All policy decisions derive from one versioned model."

    - id: P1-CHANGE-005
      severity: HIGH
      file_or_section: "Evidence plan"
      evidence: "Tracked raw artifacts conflict with public safety and canonical artifact architecture."
      consequence: "Sensitive generated data may enter Git."
      required_change: "Use external/ignored raw storage and sanitized committed manifests."
      validation_method: "Secret/path canaries remain outside tracked files."

    - id: P1-CHANGE-006
      severity: HIGH
      file_or_section: "Publication gates"
      evidence: "License approval, provenance, dependency licensing, and robust secret scanning are incomplete."
      consequence: "Unsafe or unlawful publication remains possible."
      required_change: "Add documented approval and executable license, provenance, attribution, history-secret, and scanner-self-test gates."
      validation_method: "Publication check fails on seeded violations and missing approval."

    - id: P1-CHANGE-007
      severity: HIGH
      file_or_section: "Phase boundaries"
      evidence: "Public push and PR existence cross into forge integration."
      consequence: "Phase 1 depends on external systems and unresolved GitHub information."
      required_change: "Remove remote publication and PR creation from Phase 1 completion."
      validation_method: "Phase 1 completes offline."

    - id: P1-CHANGE-008
      severity: HIGH
      file_or_section: "Completion protocol"
      evidence: "The implementer sentinel precedes final review and is not invalidated on repair."
      consequence: "Stale false completion is possible."
      required_change: "Bind markers to HEAD/evidence and create final acceptance only after review."
      validation_method: "Reviewer-rejection simulation cannot leave a valid completion marker."

    - id: P1-CHANGE-009
      severity: MEDIUM
      file_or_section: "CI and generated files"
      evidence: "tsbuildinfo is not ignored, format is undefined, and pnpm verify is not the full CI gate."
      consequence: "CI/local drift and accidental generated-file publication are likely."
      required_change: "Define one canonical verification command, ignore generated metadata, and assert clean tree."
      validation_method: "Clean-checkout verification leaves no diff or untracked generated files."

    - id: P1-CHANGE-010
      severity: MEDIUM
      file_or_section: "Governance and architecture gates"
      evidence: "ADR/radar approval and dependency fitness tests are absent from exit criteria."
      consequence: "Unapproved decisions or provider coupling may pass Phase 1."
      required_change: "Add approval-manifest and architecture-dependency gates."
      validation_method: "Exit fails for stale approvals or forbidden imports."

  optional_improvements:
    - id: P1-OPT-001
      severity: LOW
      file_or_section: "Phase 1 report"
      evidence: "The plan lists deliverables and gates but no single traceability matrix."
      consequence: "Reviewers must manually correlate requirements, files, tests, and evidence."
      required_change: "Generate a machine-readable matrix mapping every Phase 1 requirement to its implementation, tests, and evidence."
      validation_method: "Check that every requirement and exit criterion has at least one test and evidence reference."

    - id: P1-OPT-002
      severity: LOW
      file_or_section: "Evaluation runner reproducibility"
      evidence: "The runner is called deterministic, but ordering, seed, locale, timezone, and network behavior are not specified."
      consequence: "Nominally deterministic evaluations may differ across machines."
      required_change: "Pin ordering, locale, timezone, random seed, dependencies, and default-deny network behavior."
      validation_method: "Compare byte-identical evaluation output across two clean runs with shuffled input discovery order."

  final_recommendation: >-
    Do not lock or implement v1 unchanged. Revise the plan so Phase 1 actually
    selects the pilot, ingests 30–50 genuine historical tasks, and produces a
    reproducible baseline. Establish single authoritative sources for contracts
    and policy, executable compatibility and architecture gates, safe external
    raw-evidence storage, defensible license/provenance/publication controls,
    and a completion marker valid only after final review. Keep the current
    explicit exclusions for Temporal runtime, real providers, Mem0, Graphiti,
    OpenHands, ADK, RTK, Caveman, and Web Console work.
```
