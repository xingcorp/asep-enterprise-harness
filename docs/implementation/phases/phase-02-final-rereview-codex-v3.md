VERDICT: REQUEST_CHANGES  confidence 0.99

| ID | verdict | file:line bằng chứng | ghi chú ngắn |
|---|---|---|---|
| HIGH-001 | RESOLVED | `.github/workflows/ci.yml:65-100`; `scripts/integration/run-integration.mjs:152-205`; `scripts/integration/lib.mjs:31-49` | Không regression: integration vẫn bắt buộc, fail-closed và hiện kiểm 6 suite thật. |
| HIGH-002 | PARTIAL | `packages/application/src/vertical-slice-workflow.ts:367-393`; `adapters/command-runner/src/sandbox-exec.itest.ts:179-210`; `adapters/agent-claude/src/claude-provider.ts:53-56,120-140` | `.git` đã được nested mount `:ro` và test thật ghi từ container. Nhưng Claude sandbox vẫn optional; thiếu config thì agent chạy trực tiếp trên host. E8/G3/G5 chưa đóng. |
| HIGH-003 | RESOLVED | `packages/application/src/governed-execution.ts:169-221`; `packages/application/src/governed-execution.test.ts:166-180` | Không regression: R2–R4 vẫn dừng trước lease/workspace/agent. |
| HIGH-004 | RESOLVED | `apps/control-plane-api/src/app.ts:104-125`; `apps/control-plane-api/src/auth.ts:139-157`; `apps/control-plane-api/src/control-plane.test.ts:232-325` | Org creation yêu cầu authenticated platform operator có `organizations:create`; anonymous, tenant token và operator thiếu capability đều không ghi DB. |
| HIGH-005 | PARTIAL | `adapters/persistence/src/repositories.ts:447-470`; `adapters/persistence/src/migrations.ts:373-390`; `adapters/persistence/src/migrations.ts:245-259`; `packages/application/src/pipeline-steps.ts:341,365-372` | Checksum evidence và task/run/attempt binding đã đóng. Nhưng `side_effect_records.scope` vẫn `text`, `result_ref` vẫn JSONB chứa commit/evidence/PR không scoped FK; C2b/D6 vẫn hở. |
| HIGH-006 | PARTIAL | `packages/application/src/pipeline-steps.ts:303-374`; `adapters/git-worktree/src/worktree-manager.ts:260-286`; `adapters/git-worktree/src/git-worktree.test.ts:392-429`; `packages/application/src/pipeline-steps.ts:468-494,528-560` | Commit `PENDING` đã reconcile trailer `ASEP-Attempt/ASEP-Evidence`; test dùng commit Git thật. Nhưng push và PR gặp `PENDING` vẫn gọi lại ngoại tác, không reconcile remote. |
| HIGH-007 | RESOLVED | `packages/application/src/execute-task.ts:124-139`; `adapters/git-worktree/src/git-worktree.test.ts:282-317` | Không regression: detached-HEAD commit thật vẫn bị phát hiện. |
| HIGH-008 | PARTIAL | `apps/control-plane-api/src/vertical-slice.ts:175-182,246-253,338-353`; `apps/control-plane-api/package.json:14-24`; `apps/control-plane-api/src/cli-main.ts:30-33` | Có seam `agentFor`/`forge`, nhưng không composition root nào instantiate `ClaudeCodingProvider` hoặc `GitHubAppForgePort`; package còn không phụ thuộc hai adapter này. CLI vẫn mock. Chỉ cấp credential chưa chạy được live task→PR. |
| HIGH-009 | PARTIAL | `scripts/pilot/verify-pilot-manifest.mjs:472-484`; `scripts/pilot/authority-resolver.mjs:68-149`; `scripts/pilot/verify-pilot-manifest.mjs:347-366`; `scripts/pilot/authority-resolver.mjs:123-130` | Pipe manifest COMPLETE 10 task bịa vào CLI thật: `exit=1`, không còn nuốt dữ liệu tự khai. Tuy nhiên resolver chỉ đọc metadata SQL, không đọc object bytes/live GitHub; call human-auth còn bỏ truyền `trace`, nên query scope rỗng. Verifier cũng không đối chiếu signed attempt/PR/result SHA. |
| MED-001 | RESOLVED | `adapters/persistence/src/concurrency.itest.ts:59-91,98-127,156-183` | Không regression: multi-connection PostgreSQL thật vẫn kiểm migration, lease race và optimistic concurrency. |
| MED-002 | PARTIAL | `adapters/github-app/src/credential-provider.ts:87-93`; `adapters/github-app/src/forge-provider.ts:66-75,191-213,223-276` | Bounded re-mint đã có, nhưng `expiresAt/isExpired()` không được dùng trước operation; mọi HTTP 403 bị coi là credential expiry, kể cả rate-limit/permission. |
| MED-003 | PARTIAL | `packages/observability/src/spans.ts:22-33`; `packages/application/src/governed-execution.ts:180-221`; `apps/control-plane-api/src/vertical-slice.itest.ts:163-198` | Runtime chỉ emit/audit 3 boundary: `workspace.lease`, `workspace.create`, `agent.invoke`. Thiếu `task.execute`, `context.build`, `command.execute`, `artifact.put`, `git.commit`, `forge.push`, `forge.pull_request`. |
| MED-004 | PARTIAL | `packages/application/src/vertical-slice-workflow.ts:264-289,396-455`; `apps/control-plane-api/src/vertical-slice.ts:54-66,75-139`; `scripts/forbidden-imports.test.ts:261-305,385-448` | Persistence/workflow chính đã chuyển về application. Nhưng `apps/*` vẫn implement fake agent/forge và trực tiếp gọi `runGit`; detector không bắt `runGit()`, `forge.pushBranch()` hoặc repository alias ngắn. B2 fitness vẫn quá hẹp. |
| MED-005 | PARTIAL | `docs/implementation/phases/phase-02-exit-criteria.md:116-121`; `docs/implementation/phases/phase-02-report.md:47-73,220-230`; `.phase-02-implementation-complete:ABSENT` | Cơ chế sentinel mới là hợp lý, nhưng sentinel hiện không tồn tại. `implementation_head_sha=bbabb5a…` đứng trước các implementation commit S3; report còn ghi 453/17 test và 4 suite thay vì trạng thái hiện tại. |
| MED-006 | PARTIAL | `adapters/persistence/src/pilot-rehearsal.test.ts:12-14,51-79,85-169`; `docs/implementation/phases/phase-02-pilot-rehearsal.md:3-9`; `adapters/agent-claude/src/claude-provider.ts:143-169` | Không có executable Fault 1; Claude vẫn thiếu wall-clock timer. Fault 2 dùng cùng client, không restart DB; Fault 3/5 chỉ kiểm seam đơn lẻ, không inject outage/rate-limit vào pipeline. |
| MED-NEW-001 | RESOLVED | `adapters/persistence/src/object-store.ts:106-201`; `adapters/persistence/src/object-store-s3.itest.ts:24-112`; `scripts/integration/lib.mjs:44-49` | MinIO không còn liveness-only: S3ObjectStore PUT/GET/create-only/idempotency chạy trên bucket thật và là suite bắt buộc. |
| MED-NEW-002 | RESOLVED | `scripts/integration/lib.mjs:31-49`; `apps/control-plane-api/src/vertical-slice.itest.ts:43` | `vertical-slice-real` đã là required integration suite. |

## Regression check

- Không có test bị xóa; `git diff e1c3c68..594b628 --diff-filter=D -- '*.test.ts' '*.itest.ts'` rỗng. Không có `.skip/.todo/.only` trong source hiện tại. Canonical runner vẫn recursive-discover và bắt required markers tại `scripts/run-canonical-tests.mjs:45-69,91-113`.
- Không có thay đổi trong `packages/policy` hoặc `packages/contracts` từ cycle 2. Parity/compat guard vẫn giữ nguyên tại `packages/policy/src/parity.test.ts:63-112` và `packages/contracts/src/compat-gate.test.ts:28-67`.
- Persistence/workflow sequencing chính không lọt lại HTTP handlers, nhưng `apps/control-plane-api/src/vertical-slice.ts:54-139` vẫn chứa Git/provider implementation; đây là phần còn hở của MED-004.
- Fitness detector đã rộng hơn nhưng vẫn bypass được bằng alias hoặc `runGit()`/provider-port call tại `scripts/forbidden-imports.test.ts:261-305`.
- `@aws-sdk/client-s3` được pin exact `3.1093.0` tại `adapters/persistence/package.json:12-18`, chỉ nằm trong persistence adapter; application-layer AWS import bị cấm tại `scripts/forbidden-imports.test.ts:69-75,192-226`.

## Finding mới

Không tách ID mới độc lập. Các lỗi mới thấy được gộp đúng vào finding hiện hữu:

- HIGH-009: human-authorization call thiếu `trace` và authority chưa kiểm object/live forge tại `scripts/pilot/verify-pilot-manifest.mjs:347-366`.
- MED-004: detector bỏ lọt `runGit()`/provider implementation trong `apps/*` tại `apps/control-plane-api/src/vertical-slice.ts:54-139`.
- MED-005: sentinel hiện absent và report stale tại `docs/implementation/phases/phase-02-report.md:47-73,220-230`.

## Tính trung thực của verdict

`IMPLEMENTATION_COMPLETE_PILOT_PENDING` chưa trung thực. Các MUST non-live còn chưa đạt:

- B2: `apps/*` chưa thuần composition root — `apps/control-plane-api/src/vertical-slice.ts:54-139`.
- C2b/D6: side-effect repository/artifact references chưa DB-scoped — `adapters/persistence/src/migrations.ts:245-259`.
- C7: push/PR `PENDING` vẫn replay — `packages/application/src/pipeline-steps.ts:468-494,528-560`.
- E8/G3/G5: Claude vẫn có host-execution path và không có timeout timer — `adapters/agent-claude/src/claude-provider.ts:53-56,120-169`.
- H2: expiry trước operation và phân loại 403 chưa đúng — `adapters/github-app/src/forge-provider.ts:66-75,191-208`.
- J1/J4: thiếu 7/10 runtime spans/audit boundaries — `apps/control-plane-api/src/vertical-slice.itest.ts:163-198`.
- K5: authority gate chưa resolve object/live PR đầy đủ và human-auth lookup đang sai scope — `scripts/pilot/authority-resolver.mjs:90-149`; `scripts/pilot/verify-pilot-manifest.mjs:347-366`.
- L1: sentinel không tồn tại; report SHA/count stale — `docs/implementation/phases/phase-02-exit-criteria.md:118`; `.phase-02-implementation-complete:ABSENT`.
- L2: còn HIGH-002, HIGH-005, HIGH-006, HIGH-008, HIGH-009 chưa resolved.
- M3: rehearsal chưa inject đủ năm fault trên recovery path thật — `adapters/persistence/src/pilot-rehearsal.test.ts:12-14,51-169`.

K1, I1 và K3 tự thân đã có proof real-PG/real-Git/real-sandbox tại `apps/control-plane-api/src/vertical-slice.itest.ts:71-156`; CLI mock không làm mất các proof này. Nó chỉ chứng minh production/live composition root cho K2 chưa tồn tại.

## Kết luận

Không phase-accept. Các blocker HIGH còn lại là HIGH-002, HIGH-005, HIGH-006, HIGH-008 và HIGH-009. Manifest giả không còn được CLI chấp nhận, nhưng authority gate, crash recovery push/PR, agent isolation, production wiring và completion sentinel vẫn chưa đạt locked MUST.
