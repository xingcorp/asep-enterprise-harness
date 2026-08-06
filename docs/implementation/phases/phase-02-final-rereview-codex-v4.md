VERDICT: REQUEST_CHANGES  confidence 0.99

| ID | verdict | file:line bằng chứng | ghi chú ngắn |
|---|---|---|---|
| HIGH-001 | RESOLVED | `.github/workflows/ci.yml:65-100`; `scripts/integration/run-integration.mjs:152-205`; `scripts/integration/lib.mjs:31-49` | Integration vẫn bắt buộc, health-check thật, fail-closed và giữ 6 required suite. |
| HIGH-002 | RESOLVED | `adapters/agent-claude/src/claude-provider.ts:92-103,153-174,179-220,242-256`; `adapters/agent-claude/src/agent-claude.test.ts:132-173,287-318`; `apps/control-plane-api/src/production-root.ts:40-50,104-112`; `apps/control-plane-api/src/production-root.test.ts:132-141` | Không còn host path do quên config: thiếu sandbox chỉ chạy được với literal waiver. Production bắt buộc sandbox. Timer thật gọi `SIGKILL`; hung child không có external abort trả `BUDGET_EXHAUSTED`. |
| HIGH-003 | RESOLVED | `packages/application/src/governed-execution.ts:169-221`; `packages/application/src/governed-execution.test.ts:164-180` | R2–R4 vẫn dừng trước lease/workspace/agent. |
| HIGH-004 | RESOLVED | `apps/control-plane-api/src/app.ts:104-125`; `apps/control-plane-api/src/auth.ts:139-157`; `apps/control-plane-api/src/control-plane.test.ts:232-325` | Org creation yêu cầu platform operator có capability; các đường thiếu quyền không ghi DB. |
| HIGH-005 | PARTIAL | `adapters/persistence/src/migrations.ts:394-422`; `adapters/persistence/src/side-effect-log.ts:90-104,182-193`; `packages/application/src/pipeline-steps.ts:298-301,341-372,560-605` | Insert chuẩn ghi binding scoped, nhưng cột mới vẫn nullable, không có `CHECK(scope = repository_binding_id)`. `result_ref` JSONB vẫn là authority khi adopt commit/evidence/PR, trái D6 “not arbitrary JSONB”. |
| HIGH-006 | PARTIAL | `packages/application/src/pipeline-steps.ts:468-517,551-605`; `adapters/github-app/src/forge-provider.ts:348-418`; `packages/application/src/pipeline-steps.test.ts:610-693`; `adapters/persistence/src/side-effect-log.ts:119-128,174-180`; `adapters/persistence/src/side-effect-log.test.ts:255-271` | Reconcile remote bằng branch/head thật đã có. Nhưng sau lease handoff, owner mới không thể complete PENDING của owner cũ; recovery không hội tụ sau stale-lease recovery. |
| HIGH-007 | RESOLVED | `packages/application/src/execute-task.ts:124-139`; `adapters/git-worktree/src/git-worktree.test.ts:282-317` | Detached-HEAD commit thật vẫn bị phát hiện và chặn. |
| HIGH-008 | PARTIAL | `apps/control-plane-api/src/production-root.ts:100-153`; `apps/control-plane-api/src/production-root.test.ts:83-114`; `apps/control-plane-api/package.json:14-27`; `apps/control-plane-api/src/cli-main.ts:30-33`; `packages/application/src/vertical-slice-workflow.ts:71-75`; `apps/control-plane-api/src/vertical-slice.ts:332-340`; `adapters/github-app/src/binding-resolver.ts:84-106` | Root thật đã instantiate Claude/GitHub App, nhưng chưa có runnable entrypoint. Workflow tạo binding không có `githubRepositoryId`, nên resolver production fail-closed; CLI vẫn mock. Chỉ cấp credential chưa chạy được live task→PR. |
| HIGH-009 | PARTIAL | `scripts/pilot/verify-pilot-manifest.mjs:351-373,479-499`; `scripts/pilot/verify-pilot-manifest.test.ts:367-377`; `scripts/pilot/authority-resolver.mjs:90-116,123-149`; `scripts/pilot/verify-pilot-manifest.mjs:306-372`; `adapters/persistence/src/migrations.ts:339-356` | CLI thật đã từ chối manifest COMPLETE 10 task bịa (`exit=1`); trace human-auth đã truyền đúng. Nhưng resolver chỉ đọc metadata SQL, không object bytes/live forge; verifier không so signed `attemptId`, `pullRequestId`, `reviewedResultSha` với trace/result. |
| MED-001 | RESOLVED | `adapters/persistence/src/concurrency.itest.ts:59-91,98-150,156-183` | Multi-connection PostgreSQL thật vẫn kiểm migration, lease race và optimistic concurrency. |
| MED-002 | PARTIAL | `adapters/github-app/src/forge-provider.ts:78-120,217-229,254-279,289-345`; `adapters/github-app/src/github-app.test.ts:278-314`; `adapters/github-app/src/forge-provider.ts:355-382` | `isExpired()` và phân loại bare 403 đã sửa đúng. Tuy nhiên `resolveRef` chỉ mint một lần, không bounded re-mint khi token hết hạn/revoked; vẫn thiếu transport fake-clock cho expiry-before-use/rotation theo H2. |
| MED-003 | PARTIAL | `packages/observability/src/spans.ts:22-33`; `packages/application/src/governed-execution.ts:148-167,180-221`; `apps/control-plane-api/src/vertical-slice.itest.ts:158-198` | Runtime vẫn chỉ emit/audit lease, workspace, agent; thiếu 7/10 boundary J1/J4. |
| MED-004 | PARTIAL | `apps/control-plane-api/src/vertical-slice.ts:54-164,250-256`; `apps/control-plane-api/src/principal-resolver.ts:40-84`; `scripts/forbidden-imports.test.ts:261-309` | Handlers chính gọi application use case, nhưng shipped `apps/*` vẫn chứa fake provider, `runGit()` và persistence-backed resolver. Detector không bắt `runGit`, port calls hay alias ngắn. |
| MED-005 | PARTIAL | `docs/implementation/phases/phase-02-report.md:35-39,47-73,216-230,246-248`; `docs/implementation/phases/phase-02-exit-criteria.md:116-121` | Report vẫn ghi chỉ K2/K6 pending, SHA/count cũ; `.phase-02-implementation-complete` không tồn tại nên L1/L4 chưa đạt. |
| MED-006 | PARTIAL | `adapters/agent-claude/src/agent-claude.test.ts:287-318`; `adapters/persistence/src/pilot-rehearsal.test.ts:12-14,51-79,85-169`; `docs/implementation/phases/phase-02-pilot-rehearsal.md:3-9` | Fault 1 timeout nay executable. Fault 2 vẫn không restart DB; Fault 3/5 không inject outage/rate-limit qua pipeline; tài liệu vẫn tự nhận là paper rehearsal. |
| MED-NEW-001 | RESOLVED | `adapters/persistence/src/object-store.ts:106-202`; `adapters/persistence/src/object-store-s3.itest.ts:62-113`; `scripts/integration/lib.mjs:43-49` | MinIO PUT/GET/create-only/idempotency vẫn là required integration proof. |
| MED-NEW-002 | RESOLVED | `scripts/integration/lib.mjs:39-49`; `apps/control-plane-api/src/vertical-slice.itest.ts:43,71-80` | K1 real-backend suite vẫn được đăng ký bắt buộc. |

## Regression check

- `git diff 7b7a2f5..HEAD --diff-filter=D -- '*.test.ts' '*.itest.ts'` rỗng; `rg '\.(skip|todo|only)\s*\('` không có kết quả. Recursive discovery và required-marker enforcement vẫn tại `scripts/lib/canonical-tests.mjs:41-86,91-160` và `scripts/run-canonical-tests.mjs:45-69,91-120`.
- Không có thay đổi Cycle 4 trong `packages/policy` hoặc `packages/contracts`. Policy parity vẫn khóa monotonicity/approval tại `packages/policy/src/parity.test.ts:63-112`; schema compatibility vẫn có live gate và mutation rejection tại `packages/contracts/src/compat-gate.test.ts:28-67`.
- Test bare 403 không bị làm yếu: nó tách rate-limit/permission khỏi credential expiry tại `adapters/github-app/src/github-app.test.ts:278-310`, đúng implementation `adapters/github-app/src/forge-provider.ts:91-119`.
- Test H5 vẫn pin chính xác toàn bộ callable surface và cấm merge/squash/rebase tại `adapters/github-app/src/port-adapter.test.ts:308-339`. `resolveRef` dùng `ls-remote`; `findPullRequest` dùng REST list, đều read-only tại `adapters/github-app/src/forge-provider.ts:348-418`. Không có write/merge capability mới.
- Fitness B2/B5 còn hẹp: pattern chỉ bắt raw spawn/repository suffix/pipeline-step tên cố định tại `scripts/forbidden-imports.test.ts:261-309`, trong khi `runGit()` và fake forge nằm tại `apps/control-plane-api/src/vertical-slice.ts:54-164`.
- `@octokit/rest` được pin exact `22.0.1` tại `apps/control-plane-api/package.json:14-27`; import chỉ ở composition root tại `apps/control-plane-api/src/production-root.ts:25-34`. Application không phụ thuộc Octokit tại `packages/application/package.json:13-19`.

## Finding mới

Không tách ID mới. Các khoảng hở mới quan sát được đã gộp vào finding hiện hữu:

- HIGH-006: PENDING không thể chuyển owner sau lease handoff tại `adapters/persistence/src/side-effect-log.ts:119-128,174-180`.
- HIGH-008: production workflow không ghi numeric GitHub repository ID và agent factory bỏ qua `worktreePathOf` tại `packages/application/src/vertical-slice-workflow.ts:71-75`; `apps/control-plane-api/src/production-root.ts:124-132`.
- MED-002: read-only `resolveRef` không dùng bounded re-mint tại `adapters/github-app/src/forge-provider.ts:355-382`.

## Tính trung thực của verdict

`IMPLEMENTATION_COMPLETE_PILOT_PENDING` chưa trung thực. Ngoài K2/K6 live pilot, các MUST non-live còn chưa đạt:

- B2/B5: `apps/*` chưa composition-root-only và fitness bỏ lọt provider/Git calls — `apps/control-plane-api/src/vertical-slice.ts:54-164`; `scripts/forbidden-imports.test.ts:261-309`.
- C2b/D6: side-effect binding chưa bắt buộc/coherent; authoritative `result_ref` vẫn JSONB — `adapters/persistence/src/migrations.ts:410-422`; `adapters/persistence/src/side-effect-log.ts:182-193`.
- C7: crash recovery không hội tụ sau lease reassignment — `adapters/persistence/src/side-effect-log.test.ts:255-271`.
- H2: credential recovery chưa đầy đủ cho reconciliation operation và test matrix — `adapters/github-app/src/forge-provider.ts:355-382`.
- J1/J4: chỉ 3/10 boundary được emit/audit — `apps/control-plane-api/src/vertical-slice.itest.ts:158-198`.
- K5: authority chưa kiểm object bytes/live forge và signed attempt/PR/result linkage — `scripts/pilot/authority-resolver.mjs:90-149`; `scripts/pilot/verify-pilot-manifest.mjs:306-372`.
- L1/L2: sentinel absent, report stale và còn HIGH-005/006/008/009 PARTIAL — `docs/implementation/phases/phase-02-report.md:35-73,216-230`; `docs/implementation/phases/phase-02-exit-criteria.md:118-121`.
- M3: chưa inject đủ năm fault qua recovery path thật — `adapters/persistence/src/pilot-rehearsal.test.ts:12-14,51-169`.

## Kết luận

Không phase-accept. HIGH-002 đã đóng; bốn blocker HIGH còn lại là HIGH-005, HIGH-006, HIGH-008 và HIGH-009. CLI pilot đã fail-closed trước manifest bịa, nhưng persistence authority, crash convergence, production live wiring và completion protocol vẫn chưa đạt locked MUST.
