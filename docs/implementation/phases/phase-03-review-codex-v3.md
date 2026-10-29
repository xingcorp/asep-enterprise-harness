<!--
Provenance: independent, read-only Codex review of the Phase 3 plan v3 and audit of the S2 code.
Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, run by the controller on 2026-10-29. The Codex CLI
0.147.0 binary was already loaded when the run started; the installed CLI is 0.165.0. The gateway appends its own
style instructions and tools to every request (reconciliation R16), so the review holds "via this gateway".
Reviewed snapshot: `5e9fb84` (branch phase/03-durable-orchestration, plan LOCKED v3). The review predates
`5b0afde` (R20: a non-replaceable agent failure beats the exhaustion path) and `e4fd343` (R20 recorded in the
docs).
Copied verbatim from the controller's review output. Two mechanical changes only: the absolute path of the
controller's lane directory is replaced by `<controller-lanes>/`, so no host path enters the public tree, and a
final newline is added.
Adjudication of every finding: `phase-03-review-log.md`, section "Review v3".
-->

VERDICT: REQUEST_CHANGES  confidence 0.98

## Phần 1 — Plan v3

Các tên `phase-03-*.md` dưới đây thuộc `docs/implementation/phases/`.
`reconciliation-v1.md` chỉ `<controller-lanes>/reconciliation-v1.md`.

`FOLDED` xác nhận nội dung plan đã sửa.
Trạng thái này không xác nhận implementation hoặc runtime đã đạt.

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P3-PLAN2-HIGH-001 | FOLDED | `phase-03-architecture.md:553`; `phase-03-architecture.md:560`; `phase-03-exit-criteria.md:374` | Plan đã tách verification reserve và chốt bảng agent outcome. Ngoại lệ R20 còn thiếu được ghi riêng bên dưới. |
| P3-PLAN2-HIGH-002 | FOLDED | `phase-03-architecture.md:574`; `phase-03-exit-criteria.md:357`; `phase-03-exit-criteria.md:429` | Plan đã tách `maxAttempts` khỏi từng nguyên nhân thiếu budget. Chỉ task cap được extension. |
| P3-PLAN2-HIGH-003 | FOLDED | `phase-03-architecture.md:514`; `phase-03-exit-criteria.md:328`; `phase-03-exit-criteria.md:336` | Plan đã chia ba critical unit. Assurance và approval wait có acceptance cancellation riêng. |
| P3-PLAN2-MED-001 | FOLDED | `phase-03-architecture.md:122`; `phase-03-plan.md:922` | S2 dùng purity check cục bộ. Shared AST rule thuộc S7 sau G-P2. |
| P3-PLAN2-MED-002 | FOLDED | `phase-03-architecture.md:86`; `phase-03-exit-criteria.md:79` | Plan đã loại tests/test-support khỏi production scan và cho phép imports nội bộ. Chất lượng detector còn lỗi trong audit S2. |
| P3-PLAN2-MED-003 | FOLDED | `phase-03-plan.md:555`; `phase-03-plan.md:569`; `phase-03-architecture.md:339` | Default slot tối thiểu thuộc S0. Replay gate bắt đầu tại S8 cùng corpus thật. |
| P3-PLAN2-MED-004 | FOLDED | `phase-03-plan.md:1014`; `phase-03-plan.md:1019` | SDK-specific injectors đã chuyển vào `adapters/temporal/src/test-support/`. Worker không nhận Temporal dependency. |
| P3-PLAN2-MED-005 | FOLDED | `phase-03-architecture.md:215`; `phase-03-data-model.md:120`; `phase-03-exit-criteria.md:433` | Retry giữ repair base, order, round và prior adjudication. |
| P3-PLAN2-MED-006 | FOLDED | `phase-03-architecture.md:351`; `phase-03-exit-criteria.md:484` | Thứ tự drain đã sửa. Khả năng đóng idle run vẫn thiếu, như finding mới HIGH-002. |
| P3-PLAN2-MED-007 | FOLDED | `phase-03-review-log.md:372`; `phase-03-review-log.md:636`; `phase-03-data-model.md:317`; `phase-03-exit-criteria.md:57` | Escalation đã đóng bằng R15. Storage boundary cấm fabricated operational run và giữ scoped FK. |
| P3-PLAN-HIGH-004 | PARTIAL | `phase-03-plan.md:852`; `phase-03-review-log.md:395`; `phase-03-exit-criteria.md:68` | Verbatim block, source SHA và byte comparison vẫn pending. R18 cho phép chờ hand-off, nhưng G-LB vẫn chặn S0. |
| P3-PLAN-MED-003 | FOLDED | `phase-03-research-register.md:93`; `phase-03-architecture.md:807`; `phase-03-exit-criteria.md:148` | Plan đã chốt flag, giá trị và retention read-back. JSON field và runtime assertion chưa được reviewer chạy. |
| P3-PLAN-MED-004 | FOLDED | `phase-03-architecture.md:325`; `phase-03-architecture.md:339`; `phase-03-architecture.md:351` | Manifest, bootstrap và thứ tự drain đã cụ thể. Liveness của idle run là finding mới. |
| P3-PLAN-LOW-001 | FOLDED | `phase-03-exit-criteria.md:119`; `phase-03-exit-criteria.md:495` | Acceptance đã yêu cầu giữ đầy đủ pull/inspect output. Evidence CI chưa tồn tại trong phạm vi kiểm này. |

### Đối chiếu R1–R20

| Điều khoản | Kết quả | Evidence |
|---|---|---|
| R1 | Plan dùng primitive Phase 2 và giữ invariant lease-bound claim. S2 không sửa fencing. | `phase-03-plan.md:687`; `phase-03-plan.md:694`; lệnh `git diff --name-only 98e92cf a133e32`. |
| R2 | Plan đã rút parallel result contract. Adoption implementation vẫn chờ rebase. | `phase-03-plan.md:689`; `phase-03-plan.md:699`. |
| R3 | Vị trí slot, bốn outcomes, repair base và terminal hook đã đúng. Verbatim contract vẫn pending. | `phase-03-architecture.md:666`; `phase-03-architecture.md:687`; `phase-03-plan.md:852`. |
| R4 | Unified table, sink, composite tenant key và append-only trigger đã được mô tả. | `phase-03-data-model.md:271`; `phase-03-data-model.md:291`; `phase-03-data-model.md:297`. |
| R5 | Plan giữ một superset bump `run-event` 1.2.0 tại S0. | `phase-03-plan.md:654`. |
| R6 | Ownership của hai status unions và CHECK constraints đã tách. | `phase-03-plan.md:637`; `phase-03-data-model.md:428`. |
| R7 | Lane A chỉ cộng ba schemas của mình. D-1 phía Lane B chưa được xác minh trong snapshot này. | `phase-03-plan.md:650`; `reconciliation-v1.md:84`. |
| R8 | Hai checkpoint S2/S7 đã đúng thứ tự. Purity detector cục bộ còn bỏ lọt vi phạm. | `phase-03-plan.md:922`; `packages/orchestration/src/purity.test.ts:117`. |
| R9 | Plan tách Temporal service khỏi Grafana provisioning mount. | `phase-03-plan.md:1000`. |
| R10 | Hai commit S2 chỉ append registries được phép. Composition-root ownership vẫn đúng trong plan. | Lệnh `git diff 98e92cf..HEAD -- tsconfig.json scripts/lib/canonical-tests.mjs pnpm-lock.yaml`; `phase-03-plan.md:1030`. |
| R11 | ADR 0017 vẫn thuộc Lane A. | `phase-03-plan.md:1101`. |
| R12 | Corpus Phase 3 lấy từ các run S8/S10/S11. Corpus và private bundle của Lane B ngoài phạm vi xác minh. | `phase-03-architecture.md:325`; `reconciliation-v1.md:114`. |
| R13 | Assurance wrapper nằm phía harness. Credential rotation và zero-request gateway stop của Lane B chưa được xác minh. | `phase-03-architecture.md:668`; `reconciliation-v1.md:122`. |
| R14 | Temporal PostgreSQL smoke đã thành pre-deployment gate. Các quyết định Phase 4 chưa được xác minh tại đây. | `phase-03-exit-criteria.md:140`; `reconciliation-v1.md:130`. |
| R15 | S2 giữ đúng phạm vi package và registry. Plan giữ operational FK, measurement boundary và fixed logical time. | Hai lệnh diff phạm vi bên dưới; `phase-03-data-model.md:317`; `phase-03-architecture.md:683`. |
| R16 | Slot location đã chuyển sang application. Ghi chú gateway injection đã có trong provenance của review v2. | `phase-03-plan.md:846`; `phase-03-plan-review-codex-v2.md:5`. |
| R17 | Reservation, lineage và critical units đã được fold. Wall-clock overrun và cancellation khi publication thất bại còn lệch. | `phase-03-architecture.md:566`; `packages/orchestration/src/task-core.ts:376`; `packages/orchestration/src/task-core.ts:634`. |
| R18 | G-LB chờ fixed block và O5 kiểm normalization. Conformance của block thực tế chưa thể xác nhận. | `phase-03-plan.md:547`; `phase-03-plan.md:569`; `phase-03-plan.md:852`. |
| R19 | Code đã sửa budget scopes, assurance failure và extension default. Lease renewal khi chờ được giao cho S7. | `packages/orchestration/src/task-core.ts:684`; `packages/orchestration/src/task-core.ts:751`; `packages/orchestration/src/defaults.ts:44`; `phase-03-review-log.md:709`. |
| R20 | Snapshot còn ưu tiên overrun trước never-replaceable class: **đã biết, đang sửa**. H8 và wording một switch cũng cần đồng bộ. | `packages/orchestration/src/task-core.ts:520`; `phase-03-exit-criteria.md:366`; `phase-03-review-log.md:506`; `reconciliation-v1.md:264`. |

### Finding mới

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P3-PLAN3-HIGH-001 | HIGH | `phase-03-architecture.md:566`; `reconciliation-v1.md:264` | Bảng “any status” vẫn cho overrun thắng never-replaceable failure. Đây là lựa chọn cũ: **đã biết, đang sửa**. | Cho failure class bất khả thay thế thắng. Vẫn ghi overrun incident và cập nhật expected results tương ứng. |
| P3-PLAN3-HIGH-002 | HIGH | `phase-03-architecture.md:351`; `phase-03-architecture.md:235`; `packages/orchestration/src/run-core.ts:235` | Drain chặn submissions rồi chờ mọi workflow đóng. Idle run dưới `maxTasks` không có sự kiện hoàn tất bình thường. | Chốt protocol seal/drain run. Cho run xử lý hết queue rồi đóng dù chưa đạt `maxTasks`. |
| P3-PLAN3-MED-001 | MEDIUM | `phase-03-architecture.md:564`; `phase-03-architecture.md:566`; `reconciliation-v1.md:179` | Một dòng yêu cầu usage nằm trong mọi cap. Dòng overrun lại chỉ liệt kê cost/tool calls. | Chốt wall-clock vượt cap cũng thuộc overrun fail-closed. Phân biệt cap nghiệp vụ với timeout grace. |
| P3-PLAN3-MED-002 | MEDIUM | `phase-03-data-model.md:385`; `phase-03-plan.md:647`; `packages/orchestration/src/types.ts:355`; `packages/orchestration/src/approvals.ts:32` | Canonical approval message không mang `extensionUsd`. Core lại bắt buộc amount trước khi gọi verifier. | Đồng bộ canonical message và core DTO. Thêm mapping test cho budget-extension approve có amount hợp lệ. |
| P3-PLAN3-MED-003 | MEDIUM | `phase-03-exit-criteria.md:366`; `phase-03-architecture.md:579`; `phase-03-review-log.md:506` | H8 vẫn kết luận task luôn `BUDGET_EXHAUSTED` sau overrun. Bảng reservation cho `maxAttempts` thắng. Log còn tách disabled/unset. | Thêm ngoại lệ attempts exhausted vào H8. Gộp disabled/unset thành một điều kiện theo R20. |

## Phần 2 — Audit S2

### Finding

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P3-S2-HIGH-001 | HIGH | `packages/orchestration/src/task-core.ts:514`; `packages/orchestration/src/task-core.ts:520`; `packages/orchestration/src/decide.test.ts:827` | `FAILED` với class bất khả thay thế vẫn đi exhaustion khi cost vượt cap. Cả ba class đều tái hiện được. Đây là R20 **đã biết, đang sửa**. | Ưu tiên never-replaceable class trước exhaustion. Giữ usage/overrun audit. Thêm bảng test ba class với cost/tool overrun. |
| P3-S2-HIGH-002 | HIGH | `packages/orchestration/src/task-core.ts:703`; `packages/orchestration/src/types.ts:155`; `packages/orchestration/src/defaults.ts:32` | `abandon()` tin hoàn toàn `replaceableFailureClasses`. Policy chứa `policy-violation` làm reducer retry rồi publish. “Never replaceable” hiện chỉ đúng với default. | Chặn ba class tuyệt đối trong core hoặc reject policy chứa chúng. Test policy override từng class. |
| P3-S2-HIGH-003 | HIGH | `packages/orchestration/src/task-core.ts:634`; `packages/orchestration/src/task-core.ts:986`; `packages/orchestration/src/task-core.ts:1021` | Push thành công, cancel pending, rồi PR upsert thất bại làm task kết thúc `CANCELLED`. `prNumber` vẫn null. Nhánh này phá invariant R17 branch kèm PR. | Không hoàn tất cancellation khi publication chưa reconcile đủ. Giữ đường recovery cho PR sau push. Test failure sau successful push và ambiguous push. |
| P3-S2-HIGH-004 | HIGH | `packages/orchestration/src/run-core.ts:36`; `packages/orchestration/src/run-core.ts:243`; `packages/orchestration/src/run-core.ts:265` | Run chỉ hoàn tất bình thường khi đạt `maxTasks`. Với một task hoàn tất trên cap mười, run rỗng vẫn mở. | Thêm sự kiện và carried state cho seal/drain theo plan đã chốt. Test đóng run dưới cap và qua continue-as-new. |
| P3-S2-HIGH-005 | HIGH | `packages/orchestration/src/task-core.ts:368`; `packages/orchestration/src/task-core.ts:376`; `packages/orchestration/src/invariants.test.ts:151` | Overrun detector bỏ qua harness-measured wall-clock. `AGENT_DONE` chạy 34 phút trên cap 30 phút vẫn verify, commit và publish. | So measured wall-clock với attempt cap trước khi chọn full path. Ghi incident và đi inspect-only khi vượt cap. |
| P3-S2-MED-001 | MEDIUM | `packages/orchestration/src/budget.ts:8`; `packages/orchestration/src/task-core.ts:377`; `packages/contracts/schema/work-order.schema.json:40` | Làm tròn trước so sánh làm mất overrun nhỏ. Cost `5.0000004` trên cap `5` vẫn publish. Schema không giới hạn precision. | Chốt precision và safe-integer bounds. Không làm tròn mất điều kiện vượt cap. Thêm fractional, sub-micro và boundary tests. |
| P3-S2-MED-002 | MEDIUM | `packages/orchestration/src/purity.test.ts:117`; `packages/orchestration/src/purity.test.ts:127`; `packages/orchestration/src/purity.test.ts:139` | Detector bỏ lọt alias/computed `Math.random` và re-export có comment. Nó cũng cho relative import ra ngoài package hoặc vào test-support. | Dùng AST và kiểm target của relative imports. Thêm seeded alias, computed access, comment, escaped identifier và excluded-module imports. |
| P3-S2-MED-003 | MEDIUM | `packages/orchestration/src/task-core.ts:964`; `packages/orchestration/src/task-core.ts:339`; `packages/orchestration/src/task-core.ts:854` | Pause tại approval wait chỉ đặt `paused=true`. Reducer không project `PAUSED` và không khởi động pause timer tại boundary đang idle. | Áp pause ngay khi không có in-flight request. Giữ approval expiry riêng và kiểm pause timeout tại cả hai approval kinds. |
| P3-S2-MED-004 | MEDIUM | `packages/orchestration/src/sequential-interpreter.ts:103`; `packages/orchestration/src/invariants.test.ts:190`; `packages/orchestration/src/invariants.test.ts:203`; `packages/orchestration/src/invariants.test.ts:417` | Generator không phát timer khi request pending. Verifier giả luôn trả `decision:null` khi `verified:false`. Hai mutation bảo vệ approval vẫn giữ 107 test xanh. | Test timer/result/control interleavings trực tiếp. Phát `verified:false` cùng decision/amount hợp lệ. Oracle phải kiểm verified result và event order. |
| P3-S2-MED-005 | MEDIUM | `packages/orchestration/src/task-core.ts:291`; `packages/orchestration/src/task-core.ts:607`; `packages/orchestration/src/task-core.ts:1028` | Nếu registration lỗi trước insert, core vẫn phát usage và outcome cho attempt chưa có identity. Trace tái hiện có `attemptId:null`. | Reconcile registration trước các effect gắn attempt. Phân biệt lỗi trước insert và lỗi sau commit. Giữ quy tắc không tạo replacement. |

### Kết quả đối chiếu hành vi

| Nhánh | Đánh giá | Evidence |
|---|---|---|
| `AGENT_DONE` tại đúng cost cap | Core vẫn chạy verification reserve và full publication path. | `packages/orchestration/src/decide.test.ts:780`; `packages/orchestration/src/task-core.ts:539`. |
| Cap-triggered exhaustion | Core inspect-only, ghi terminal và xét reservation mới. | `packages/orchestration/src/task-core.ts:535`; `packages/orchestration/src/task-core.ts:721`; `packages/orchestration/src/decide.test.ts:794`. |
| Cost/tool overrun | Nhánh thông thường ghi incident và không publish. R20 và precision còn lỗi riêng. | `packages/orchestration/src/task-core.ts:415`; `packages/orchestration/src/decide.test.ts:827`. |
| Reservation failure | Core kiểm attempts trước budget. Extension chỉ áp cho task cap khi policy có bound. | `packages/orchestration/src/budget.ts:43`; `packages/orchestration/src/task-core.ts:684`. |
| Extension approve/reject/expiry | Nhánh cơ bản có test hành vi. Hai race mutations chưa được bảo vệ. | `packages/orchestration/src/decide.test.ts:503`; `packages/orchestration/src/decide.test.ts:521`; `packages/orchestration/src/decide.test.ts:532`. |
| Failed mandatory verification | Core không mở assurance, approval hoặc publication. | `packages/orchestration/src/task-core.ts:732`; `packages/orchestration/src/decide.test.ts:359`. |
| Cancel trong commit/evidence | Happy-result traces hoàn tất unit rồi cancel trước assurance/push. Failure reconciliation chưa đủ. | `packages/orchestration/src/task-core.ts:257`; `packages/orchestration/src/decide.test.ts:719`; `packages/orchestration/src/decide.test.ts:1018`. |
| Cancel trong push/PR | Happy-result traces giữ PR rồi cancel. PR failure còn phá invariant. | `packages/orchestration/src/decide.test.ts:732`; `packages/orchestration/src/decide.test.ts:1029`; finding HIGH-003. |
| Cancel trong assurance/approval wait | Các trace được R17 yêu cầu đã có. | `packages/orchestration/src/decide.test.ts:993`; `packages/orchestration/src/decide.test.ts:1007`. |
| Retry của repair | Core giữ base, repair order, round và adjudication lineage qua agent death. | `packages/orchestration/src/task-core.ts:712`; `packages/orchestration/src/decide.test.ts:936`. |
| Assurance activity failure | Core audit rồi tiếp tục `PROCEED` trong shadow, `ESCALATE` trong gating. | `packages/orchestration/src/task-core.ts:751`; `packages/orchestration/src/decide.test.ts:969`. |
| Admission/registration failure | Terminal routing khớp R19. Registration effects còn thiếu phân biệt existence. | `packages/orchestration/src/task-core.ts:604`; `packages/orchestration/src/task-core.ts:607`; finding MED-005. |

### Purity và determinism

Không thấy clock, random hoặc I/O trực tiếp trong các reducer hiện tại.
Imports production bên ngoài chỉ là type import contracts tại `packages/orchestration/src/types.ts:14`.

Hai `Object.keys()` đọc object literals có thứ tự cố định.
Chúng không lấy thứ tự từ nguồn bên ngoài.
Evidence: `packages/orchestration/src/approvals.ts:8`; `packages/orchestration/src/defaults.ts:8`.

`Set` của sequential interpreter giữ thứ tự timer theo commands đầu vào.
Map dùng trong fixtures thuộc test-support.
Evidence: `packages/orchestration/src/sequential-interpreter.ts:70`; `packages/orchestration/src/test-support/fixtures.ts:125`.

Budget arithmetic hiện vẫn deterministic trên cùng input.
Tuy nhiên, deterministic không đồng nghĩa accounting chính xác.
`Math.round()` và thiếu bounds tạo lỗi tại finding MED-001 (`packages/orchestration/src/budget.ts:8`).

Các probe chạy trực tiếp qua `findPurityViolations()` cho kết quả sau:

| Probe | Kết quả |
|---|---|
| `const m = Math; const value = m.random();` | Không phát hiện. |
| `export const value = Math["random"]();` | Không phát hiện. |
| `export /* bridge */ { readFileSync as read } from "node:fs";` | Không phát hiện. |
| `export * from "../../domain/src/index.js";` | Không phát hiện. |
| Import từ `./test-support/fixtures.js` | Không phát hiện. |
| `globalThis["Date"].now()` | Có phát hiện `globalThis`. |
| `import("node:fs")` | Có phát hiện dynamic import. |

Các kết quả trên đến từ lệnh `node --eval` với loader chỉ đọc và import `purity.test.ts`.
Locus detector: `packages/orchestration/src/purity.test.ts:120`.

### Chất lượng test và exit criteria

| Exit criterion | Coverage hiện tại | Giới hạn |
|---|---|---|
| B2 | Có production scan, valid seeds và violation seeds. | Các cách né tại MED-002 vẫn xanh. Evidence: `purity.test.ts:178`; `purity.test.ts:188`. |
| D5 core | Có worker death, replacement, non-replaceable default và failure sau push. | Không kiểm policy override hoặc post-push cancellation failure. Evidence: `decide.test.ts:289`; `decide.test.ts:319`; `decide.test.ts:328`. |
| D7 core | Có sequential children, dedup và carry qua continue-as-new. | Không chứng minh run có thể drain dưới `maxTasks`. Evidence: `decide.test.ts:1052`; `decide.test.ts:1075`; `decide.test.ts:1097`. |
| H1 | Property oracle cộng ledger effects trước mỗi reservation. | Oracle dùng cùng `toMicroUsd()` với implementation. Caps được generate bằng số nguyên. Evidence: `invariants.test.ts:69`; `invariants.test.ts:255`. |
| I6 | Có allowed kinds và verification-stop tests. | Approval verification/expiry defenses chưa được bảo vệ đầy đủ. Evidence: `decide.test.ts:188`; `decide.test.ts:359`; finding MED-004. |
| J3 core | Có bốn outcomes và malformed outcomes. | Shared-contract assignability vẫn thuộc O5 sau hand-off. Evidence: `decide.test.ts:388`; `decide.test.ts:420`; `decide.test.ts:467`; `phase-03-exit-criteria.md:68`. |
| J5 | Property test đếm một usage/outcome mỗi `ensureAttempt` request. | Nó không phân biệt registration thành công với registration thất bại. Evidence: `invariants.test.ts:284`; `task-core.ts:291`. |
| J7 | Có assertion assurance trước publication và cấm publish sau `REPAIR`/`BLOCK`. | Driver tuần tự không tạo đủ result/timer races. Evidence: `invariants.test.ts:341`; `sequential-interpreter.ts:103`. |

Các tên test rút gọn trong bảng này thuộc `packages/orchestration/src/`.

Bốn trace R17 đều có test tương ứng.
Chúng nằm tại `decide.test.ts:794`, `decide.test.ts:883`, `decide.test.ts:936` và `decide.test.ts:993`.

Generator có coverage assertion, nhưng chưa đủ mạnh cho các tổ hợp quan trọng.
Instrumentation chỉ trong bộ nhớ trên 600 seeds cho kết quả:

- Có 5 trace repair và 2 trace retry giữ repair lineage.
- Có 2 trace assurance unavailable trong shadow và 1 trong gating.
- Có 19 trace publish sau `AGENT_DONE` vượt wall-clock cap.

Các property tests vẫn xanh với những counterexample wall-clock này.
Evidence nguồn generator/oracle: `invariants.test.ts:69`, `invariants.test.ts:151`, `invariants.test.ts:234`.
Lệnh instrumentation dùng `node --eval` và `registerHooks`, không ghi source.

### Mutation không bị bắt

Hai mutation chỉ thay module được load trong bộ nhớ.
Cả hai đều giữ nguyên kết quả **107 pass / 0 fail / 0 skipped**.

1. **Xóa nhánh `ap.expiryFired` tại `packages/orchestration/src/task-core.ts:875`.**

   Trace `approval → verify pending → timer fired → verified approve` phát `publishBranch`.
   Mutant không phát `expireApprovalRequest`.
   Bộ test không làm đỏ vì driver chỉ phát timer khi idle (`sequential-interpreter.ts:103`).

2. **Bỏ kiểm `result.verified` tại `packages/orchestration/src/task-core.ts:879`.**

   Mutant chỉ còn kiểm decision khác null và amount hợp lệ.
   Test giả luôn ghép `verified:false` với `decision:null`, nên điều kiện còn lại vẫn chặn.
   Evidence: `packages/orchestration/src/decide.test.ts:542`; `packages/orchestration/src/invariants.test.ts:190`.

### Phạm vi và kiểm tra đã chạy

HEAD đã xác nhận bằng `git rev-parse HEAD`:

```text
5e9fb84a9272dedcf98de039923f0fa4e8a59abd
```

Hai lệnh sau xác nhận phạm vi hai commit S2:

```text
git diff --name-only 98e92cf a133e32
git diff --name-only 7cbf5d3 5e9fb84
```

Không thấy S2 sửa ports, contracts, migrations hoặc composition roots.
Các file ngoài package chỉ là ba registry được R15 cho phép.

Diff registry chỉ thêm package reference, workspace links và suite entries.
Evidence: lệnh `git diff 98e92cf..HEAD -- tsconfig.json scripts/lib/canonical-tests.mjs pnpm-lock.yaml`.

Không thấy external runtime import trong production source.
`@asep/domain` chỉ phục vụ test và được khai báo devDependency.
Evidence: `packages/orchestration/src/types.ts:14`; `packages/orchestration/src/decide.test.ts:15`; `packages/orchestration/package.json:15`.

Snapshot không có dependencies để chạy canonical runner nguyên trạng.
Tôi chạy ba suite S2 bằng Node `v24.6.0`, native TypeScript stripping và module resolution chỉ đọc:

```bash
node --disable-warning=ExperimentalWarning --input-type=module --eval '
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@asep/domain") {
      return nextResolve(
        new URL("./packages/domain/src/index.ts", pathToFileURL(process.cwd() + "/")).href,
        context
      );
    }
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(url)) return nextResolve(url.href, context);
    }
    return nextResolve(specifier, context);
  }
});

await import("./packages/orchestration/src/decide.test.ts");
await import("./packages/orchestration/src/invariants.test.ts");
await import("./packages/orchestration/src/purity.test.ts");
'
```

Kết quả baseline là **107 pass / 0 fail / 0 skipped**.
Lần chạy này không thay thế typecheck hoặc `pnpm verify:all`.

Không chạy `pnpm verify:all` vì script xóa build outputs rồi emit lại.
Evidence: `scripts/verify-all.sh:72`, `scripts/verify-all.sh:79`.

Các số 633 và 655 chưa được xác minh độc lập.
`git diff --check 98e92cf..HEAD` thành công.
`git status --porcelain=v1` cuối lượt trả rỗng.

## Kết luận

Chưa accept S2 tại snapshot này.
Các blocker độc lập với R20 gồm policy bypass, publication cancellation, run drain và wall-clock overrun.

R20 precedence được ghi nhận là **đã biết, đang sửa**.
Shared slot contract vẫn PARTIAL đúng gate R18; S0 phải tiếp tục chờ G-LB (`phase-03-plan.md:547`).

Sửa các finding HIGH và bổ sung regression tests trước khi controller kiểm lại exact SHA.
Giữ G-P2/G-LB cho phần tích hợp (`phase-03-plan.md:544`).
