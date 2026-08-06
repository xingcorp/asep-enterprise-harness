<!-- PROVENANCE NOTE (added when this transcript was committed to the repo).

Cycle 5 ran against a tree that did NOT contain the work it was asked to review.

- The prompt named commits `becb0b` (pilot entrypoint) and `7e5a911` (evidence
  reconcile). Neither SHA exists in this repository; `git cat-file -t` reports
  "Not a valid object name" for both.
- The prompt reported `pnpm verify:all -> PASS, 546 test`. The gate log from that
  run (verifyall-cycle4.log) records 507 tests and `check-publication: FAIL`.
  verify:all had not passed at that point.
- The review finished at 20:16; the pilot entrypoint and its test were written
  between 20:18 and 20:23 and were still uncommitted. The reviewer could not
  have read them.

The findings are kept in full because they are still informative -- in
particular "snapshot hiện tại không typecheck" was correct: the tree carried
three TS errors from an overload referencing two type names that do not exist
(fixed in 89a745b). But the per-finding verdicts must NOT be read as an
assessment of the current tree. Cycle 6 supersedes this document.
-->

VERDICT: REQUEST_CHANGES  confidence 0.999

| ID | verdict | file:line bằng chứng | ghi chú ngắn |
|---|---|---|---|
| HIGH-001 | RESOLVED | `.github/workflows/ci.yml:65-100`; `scripts/integration/lib.mjs:31-49`; `scripts/integration/run-integration.mjs:152-205` | Integration vẫn là job bắt buộc, 6 suite required, thiếu backend làm gate đỏ. |
| HIGH-002 | PARTIAL | `apps/control-plane-api/src/production-root.ts:47-50,109-112`; `adapters/agent-claude/src/claude-provider.ts:97-102,153-174`; `apps/control-plane-api/src/pilot-main.ts:83-94,127-153` | Host-mode không còn lọt qua `productionSeams`/pilot; waiver là opt-in. Nhưng agent image chỉ cần không rỗng, không kiểm digest; agent mount cả thư mục pilot `:rw` mà không phủ `.git` `:ro`, nên E8/F5 chưa đạt. |
| HIGH-003 | RESOLVED | `packages/application/src/governed-execution.ts:169-207`; `packages/application/src/governed-execution.test.ts:164-180` | R2–R4 dừng trước lease/workspace/agent/inspect. |
| HIGH-004 | RESOLVED | `apps/control-plane-api/src/app.ts:104-125`; `apps/control-plane-api/src/auth.ts:139-157`; `apps/control-plane-api/src/control-plane.test.ts:232-325` | Org creation yêu cầu platform operator có capability; các đường từ chối không ghi DB. |
| HIGH-005 | PARTIAL | `adapters/persistence/src/migrations.ts:245-260,410-421`; `adapters/persistence/src/side-effect-log.ts:96-104,163-211`; `packages/ports/src/index.ts:467-473`; `packages/application/src/pipeline-steps.ts:632-637` | `repository_binding_id` mới vẫn nullable, không có CHECK bằng `scope`; uniqueness/query vẫn dựa vào text. `result_ref` vẫn JSONB/`unknown`; PR adoption còn blind cast. C2b/D6 chưa đóng. |
| HIGH-006 | PARTIAL | `packages/application/src/pipeline-steps.ts:458-503`; `adapters/persistence/src/evidence-store.ts:101-122`; `packages/application/src/pipeline-steps.test.ts:828-892` | Đã adopt bundle có metadata và propagate integrity error. Nhưng crash sau object write, trước metadata insert vẫn khiến `getEvidence` báo absent; clock mới sinh bytes khác rồi create-only collision, tiếp tục wedge. Bundle được adopt cũng chưa đối chiếu task/attempt/base/result SHA. |
| HIGH-007 | RESOLVED | `packages/application/src/execute-task.ts:124-139`; `adapters/git-worktree/src/worktree-manager.ts:183-190`; `adapters/git-worktree/src/git-worktree.test.ts:282-317` | Detached-HEAD commit thật vẫn bị phát hiện và chặn. |
| HIGH-008 | PARTIAL | `apps/control-plane-api/src/pilot-main.ts:127-167`; `apps/control-plane-api/src/vertical-slice.ts:54-66,279-320,337-340`; `adapters/github-app/src/binding-resolver.ts:84-106`; `apps/control-plane-api/src/pilot-main.test.ts:ABSENT` | Entrypoint thực sự gọi `productionSeams` và truyền cả hai seam. Nhưng binding không ghi `githubRepositoryId`, nên resolver fail; forge nhận `dir` thay vì worktree; commit được tạo từ mirror tổng hợp, không từ repo pilot thật. Chỉ cấp credential chưa chạy được live task→PR. |
| HIGH-009 | PARTIAL | `scripts/pilot/authority-resolver.mjs:68-117`; `adapters/persistence/src/migrations.ts:100-123`; `scripts/pilot/verify-pilot-manifest.mjs:306-373` | Query attempt đọc cột `attempts.run_id` không tồn tại. Evidence chỉ đọc metadata SQL, không fetch/re-hash/parse object; PR chỉ đọc row SQL, không kiểm live PR/head SHA; human authorization chưa đối chiếu attempt/result SHA/PR đã ký. |
| MED-001 | RESOLVED | `adapters/persistence/src/concurrency.itest.ts:59-91,98-149,156-183` | Multi-connection PostgreSQL thật vẫn kiểm migration, lease race và optimistic concurrency. |
| MED-002 | RESOLVED | `adapters/github-app/src/forge-provider.ts:78-120,217-279,289-345`; `adapters/github-app/src/github-app.test.ts:278-398` | Kiểm expiry trước operation, bounded re-mint; rate-limit/permission 403 không còn bị coi là expiry. |
| MED-003 | PARTIAL | `packages/observability/src/spans.ts:22-33`; `packages/application/src/governed-execution.ts:148-215`; `apps/control-plane-api/src/vertical-slice.itest.ts:158-198` | Runtime vẫn chỉ chứng minh 3/10 span/audit boundaries; thiếu task/context/command/artifact/commit/push/PR. |
| MED-004 | PARTIAL | `apps/control-plane-api/src/vertical-slice.ts:54-165,253-330`; `scripts/forbidden-imports.test.ts:261-308`; `workers/workflow-worker/src/index.ts:14-26` | Worker sạch, nhưng `apps/*` vẫn chứa `runGit`, fake agent/forge và provider calls. Fitness matcher không bắt `runGit()` hoặc `forge.pushBranch()`. B2/B5 còn hở. |
| MED-005 | REGRESSED | `docs/implementation/phases/phase-02-report.md:35-39,47-73,216-230`; `.phase-02-implementation-complete:ABSENT` | Report vẫn claim chỉ K2/K6 pending, ghi 453/17 test thay vì 546/23; sentinel vắng và tree hiện không sạch. L1 chưa đạt. |
| MED-006 | PARTIAL | `adapters/persistence/src/pilot-rehearsal.test.ts:51-169`; `docs/implementation/phases/phase-02-pilot-rehearsal.md:3-9,35-104` | Fault 2 không restart DB; Fault 3 không inject outage vào pipeline; Fault 5 không inject rate-limit; Fault 1 không nằm trong rehearsal executable. M3 chưa đạt. |

## Regression check

- Không thấy test bị xóa từ cycle 3 tới HEAD và không có `.skip/.todo/.only`; canonical discovery/required markers vẫn fail-closed tại `scripts/lib/canonical-tests.mjs:45-78,91-115` và `scripts/run-canonical-tests.mjs:45-56,91-120`.
- Không có nới lỏng `packages/policy`/`packages/contracts`; parity và compatibility guards giữ nguyên tại `packages/policy/src/parity.test.ts:63-113` và `packages/contracts/src/compat-gate.test.ts:28-67`.
- Sửa fake `getEvidence()` thành lỗi mang tên `EvidenceNotFoundError` là đúng contract, không phải làm yếu test: real store phát đúng lỗi này tại `adapters/persistence/src/evidence-store.ts:126-140`, còn application chỉ được ghi khi nhận absence tại `packages/application/src/pipeline-steps.ts:473-478`.
- Worker không lọt persistence/sequencing tại `workers/workflow-worker/src/index.ts:14-26`; vi phạm còn nằm trong app composition root tại `apps/control-plane-api/src/vertical-slice.ts:54-165`.
- Snapshot hiện có regression compile: `pipeline-steps.ts` dùng `SideEffectResultRefError` nhưng không import tại `packages/application/src/pipeline-steps.ts:46-60,320-323`. Typecheck trực tiếp trả TS2304; gate PASS được báo không đại diện cho snapshot hiện tại.

## Finding mới

- Provenance giao nộp không khớp: `docs/implementation/phases/phase-02-final-rereview-codex-v4.md:ABSENT`, các object `becb0b`/`7e5a911` không tồn tại; HEAD quan sát là `bb11d00` và `pilot-main.ts` còn untracked.
- `pilot-main.test.ts` với “7 test” được mô tả không tồn tại; chỉ có sáu test của `production-root.test.ts:83-173`, không test entrypoint/environment/wiring thực.

## Tính trung thực của verdict

`IMPLEMENTATION_COMPLETE_PILOT_PENDING` chưa trung thực. Không chỉ K2/K6 còn pending. Các MUST chưa đạt chính xác:

- B2/B5 — app root vẫn chứa Git/provider implementation: `apps/control-plane-api/src/vertical-slice.ts:54-165`.
- C2b/D6 — side-effect binding chưa DB-coherent; authoritative `result_ref` vẫn JSONB tự do: `adapters/persistence/src/migrations.ts:245-260,410-421`.
- C7/D7/D8 — evidence orphan boundary vẫn có thể wedge: `adapters/persistence/src/evidence-store.ts:101-122`; `packages/application/src/pipeline-steps.ts:458-503`.
- E8/F5/G3/G5 — pilot agent image không digest-validated và Git metadata vẫn writable qua parent mount: `apps/control-plane-api/src/pilot-main.ts:83-94,127-138`.
- J1/J4 — mới emit/audit 3/10 boundary: `apps/control-plane-api/src/vertical-slice.itest.ts:158-198`.
- K5 — resolver production SQL lỗi và chưa kiểm object bytes/live PR: `scripts/pilot/authority-resolver.mjs:68-117`.
- L1/L2 — sentinel vắng, report stale, còn HIGH unresolved: `docs/implementation/phases/phase-02-report.md:35-73`; `.phase-02-implementation-complete:ABSENT`.
- M3 — rehearsal chưa inject đủ năm fault trên recovery path thật: `adapters/persistence/src/pilot-rehearsal.test.ts:51-169`.
- K2/K6 không đơn thuần thiếu credential: entrypoint hiện không resolve được repository numeric id/worktree và dùng lịch sử Git tổng hợp, tại `apps/control-plane-api/src/vertical-slice.ts:54-66,337-340` và `adapters/github-app/src/binding-resolver.ts:91-106`.

## Kết luận

Không phase-accept. HIGH-002, HIGH-005, HIGH-006, HIGH-008 và HIGH-009 vẫn PARTIAL; ngoài ra snapshot hiện tại không typecheck, thiếu test entrypoint, thiếu sentinel và không khớp các commit/provenance được mô tả.
