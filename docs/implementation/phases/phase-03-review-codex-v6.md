<!--
Provenance: independent, read-only Codex re-audit of the Phase 3 plan v6 and of the S2 fixes.
Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, run by the controller on 2026-10-30 as a single
uninterrupted run of the Codex CLI 0.165.0. The gateway appends its own style instructions and tools to every
request (reconciliation R16), so the review holds "via this gateway".
Reviewed snapshot: `392f259` (branch phase/03-durable-orchestration, plan LOCKED v6).
Controller gate at `392f259`, on a clean detached worktree: `pnpm verify:all` exit 0, 836 pass, 0 fail, 0 skipped;
53 test files, 31 required suites; no crash at load average 28.
Copied verbatim from the controller's review output. Two mechanical changes only: host paths are replaced by
`<controller-lanes>/` (the controller's lane directory) and `<npx-cache>/` (the reviewer's npx cache), so no host
path enters the public tree, and a final newline is added.
Adjudication of every finding: `phase-03-review-log.md`, section "Review v6".
-->

VERDICT: REQUEST_CHANGES  confidence 0.97

## Phần 1 — Plan v6

Snapshot kiểm bằng `git rev-parse HEAD` là `392f25948194d08cf71978088004cbf6cbefd4bc`.

Trong báo cáo, `phase-03-*.md` thuộc `docs/implementation/phases/`.
Các tên source S2 thuộc `packages/orchestration/src/`.
`RC` là `<controller-lanes>/reconciliation-v1.md`.

### Disposition finding plan v5

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P3-PLAN5-HIGH-001 | FOLDED | `phase-03-plan.md:360`; `phase-03-architecture.md:263`; `phase-03-exit-criteria.md:568` | Các đường có lease đã yêu cầu outcome trước release. Protocol acquire lỗi còn thuộc R29 bên dưới. |
| P3-PLAN5-HIGH-002 | FOLDED | `phase-03-architecture.md:227`; `phase-03-data-model.md:464`; `phase-03-exit-criteria.md:412` | Hai đường reconcile dùng chung predicate SHA, head branch và base. Khoảng trống repository được tách riêng. |
| P3-PLAN5-MED-001 | FOLDED | `phase-03-risk-register.md:31`; `phase-03-threat-model-delta.md:69` | PR3-18 và T3-19 đã giới hạn `publication-incomplete` vào publication không reconcile được. Prose khác còn lệch. |

### Đối chiếu R1–R29

“Phù hợp ở plan” không xác nhận integration chưa triển khai.
S0 và integration vẫn bị gate tại `phase-03-plan.md:598`.

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| R1 | Phù hợp ở plan | `phase-03-plan.md:750`; `phase-03-plan.md:767` | Không tạo fencing song song. Reopen vẫn yêu cầu reconcile remote. |
| R2 | Phù hợp ở plan | `phase-03-plan.md:752`; `phase-03-plan.md:762` | Thiết kế `resultRef?: unknown` đã rút. Binding phụ thuộc primitive Phase 2 được chấp nhận. |
| R3 | Phù hợp có điều kiện | `phase-03-plan.md:464`; `phase-03-plan.md:915` | Composition và terminal hook đã ghi. Verbatim slot vẫn chờ hand-off. |
| R4 | Phù hợp ở plan | `phase-03-data-model.md:296`; `phase-03-data-model.md:307`; `phase-03-data-model.md:317` | Có tenant key, scoped FK, append-only và conflict theo bytes. |
| R5 | Phù hợp ở plan | `phase-03-plan.md:717` | Chỉ một superset bump `run-event` lên `1.2.0`. |
| R6 | Phù hợp ở plan | `phase-03-plan.md:699` | Ownership CHECK của task và attempt vẫn tách biệt. |
| R7 | Phù hợp phần Lane A | `phase-03-plan.md:713` | Chỉ cộng schema của Lane A. Không chốt tổng liên lane. |
| R8 | Phù hợp phân kỳ | `phase-03-plan.md:614`; `phase-03-architecture.md:148` | Guard cục bộ thuộc S2. Shared guard chờ framework Phase 2 ở S7. |
| R9 | Phù hợp ở plan | `phase-03-plan.md:1065` | Temporal và Grafana được phân section để union. |
| R10 | Phù hợp theo disposition | `phase-03-review-log.md:1483`; lệnh `git diff 00a6889 HEAD -- tsconfig.json scripts/lib/canonical-tests.mjs pnpm-lock.yaml` | Registry chung chỉ bổ sung. R27 đã bác finding xóa export nội bộ. |
| R11 | Phù hợp ở plan | `phase-03-plan.md:1168` | ADR `0017` vẫn thuộc Lane A. |
| R12 | Không thấy lệch trong diff | `phase-03-architecture.md:423`; lệnh `git diff --name-status 00a6889 HEAD` | Corpus Phase 3 lấy workflow histories. Diff không đổi collector hoặc lịch sử công khai. |
| R13 | Phù hợp ranh giới composition | `phase-03-plan.md:465`; `phase-03-plan.md:1274`; `RC:122` | Lane B giữ reviewer adapter. Credential lifecycle chưa được chứng minh trong S2. |
| R14 | Phù hợp ở plan | `phase-03-exit-criteria.md:166`; `phase-03-exit-criteria.md:650` | PostgreSQL restart smoke vẫn là pre-deployment gate. Review này không chạy gate đó. |
| R15 | Phù hợp | `phase-03-plan.md:610`; `phase-03-data-model.md:323`; `phase-03-architecture.md:834` | Chỉ S2 được code trước rebase. Operational FK và fixed logical time được giữ. |
| R16 | Phù hợp | `phase-03-plan.md:909`; `phase-03-review-log.md:1261` | Slot ở application. Provenance review ghi giới hạn gateway. |
| R17 | PARTIAL | `task-core.ts:780`; `types.ts:391`; `phase-03-plan.md:418` | Critical unit được giữ. Identity còn thiếu repository; prose finality còn mâu thuẫn. |
| R18 | Phù hợp gate | `phase-03-plan.md:609`; `phase-03-plan.md:915` | S0 vẫn chờ block được controller hand-off. |
| R19 | Phù hợp trong S2 | `task-core.ts:863`; `task-core.ts:933`; `phase-03-exit-criteria.md:581` | Extension chỉ áp dụng task cap. Assurance infrastructure failure giữ shadow/gating behavior. |
| R20 | Phù hợp trong phạm vi kiểm | `task-core.ts:598`; `phase-03-risk-register.md:29` | Failure precedence và hai ngoại lệ exhaustion vẫn được giữ. |
| R21 | PARTIAL | `task-core.ts:557`; `task-core.ts:780`; `invariants.test.ts:1020` | Counterexample wrong-head đã bị chặn. Repository identity chưa được biểu diễn. Registration lookup còn cần cập nhật R29. |
| R22 | Ngoài code Lane A đã đổi | `RC:313`; lệnh `git diff --name-status ac04c8c HEAD` | Không có collector hoặc freeze vocabulary của Lane B trong diff. |
| R23 | Phù hợp thứ tự S2 | `task-core.ts:527`; `task-core.ts:970`; `phase-03-architecture.md:268` | Outcome command đứng trước release. Caller-fence transaction vẫn chờ integration. |
| R24 | PARTIAL | `task-core.ts:723`; `phase-03-architecture.md:706`; `phase-03-exit-criteria.md:622` | Effect, overrun và drain-paused đã giữ đúng. Identity còn giới hạn được nêu bên dưới. |
| R25 | Phù hợp | `purity.test.ts:129`; `phase-03-architecture.md:140` | Deny set mở rộng và giới hạn detector đã được ghi. |
| R26 | Phù hợp phân công | `phase-03-review-log.md:1494`; `RC:448` | Workaround thuộc Phase 2. Các lượt review dùng `--no-wasm-code-gc`. |
| R27 | PARTIAL | `task-core.ts:780`; `types.ts:391`; `phase-03-review-log.md:1483` | Các clause được yêu cầu đã có. Repository/state/candidate vẫn nằm ngoài observation của core. LOW-001 đã disposition đúng. |
| R28 | PARTIAL, chờ integration/R29 | `phase-03-architecture.md:805`; `phase-03-architecture.md:272`; `phase-03-plan.md:631` | Money seam đã khóa micro-USD. Acquire lỗi chưa xác định durable lease history. |
| R29 | PARTIAL — đã biết, đang sửa | `task-core.ts:694`; `task-core.ts:699`; `RC:553` | Chưa có `findLease`, late-grant retry hoặc `attempt-state-unknown`. Quy tắc missing branch đã đúng. |

### Finding của plan v6 và mâu thuẫn còn lại

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P3-PLAN6-HIGH-001 | PARTIAL — đã biết, đang sửa | `phase-03-architecture.md:277`; `phase-03-exit-criteria.md:224`; `RC:553`; `RC:559` | Plan vẫn để hai câu hỏi pre-lease mở. R29 đã quyết định protocol. Cần cập nhật flow, activity table, slices và acceptance cases. |
| P3-PLAN6-MED-001 | PARTIAL | `phase-03-plan.md:418`; `phase-03-architecture.md:616`; `phase-03-exit-criteria.md:406` | §17 và bảng cancel vẫn nói PR upsert hết retry luôn thành `publication-incomplete`. G13 cho recovery khi reconcile xác nhận identity. Phải đồng bộ prose. |
| P3-PLAN6-MED-002 | PARTIAL | `phase-03-data-model.md:460`; `phase-03-architecture.md:365`; `RC:465` | Contract chỉ truyền tên branch, SHA và base. Repository, trạng thái PR và cách phân giải nhiều candidate chưa được khóa. Cần quy định observation hoặc conformance tương ứng. |

R29 còn yêu cầu telemetry báo attempt thiếu terminal (`RC:561`).
J6 của Phase 3 hiện chứng minh khả năng cắm slot (`phase-03-exit-criteria.md:574`).
Plan phải chỉ rõ acceptance criterion telemetry tương ứng khi fold R29.

## Phần 2 — S2 sau sửa

### Disposition finding cũ

| ID | trạng thái | file:line | test chứng minh | ghi chú |
|---|---|---|---|---|
| P3-S2V5-HIGH-001 | PARTIAL | `task-core.ts:780`; `types.ts:391` | `decide.test.ts:1723`; `decide.test.ts:1733`; `invariants.test.ts:1020`; E3–E5 | Wrong SHA, head branch và base đã bị chặn. Identity mất repository/state/candidate còn được nêu tại HIGH-001 mới. |
| P3-S2V5-HIGH-002 | RESOLVED trong thứ tự command S2 | `task-core.ts:502`; `task-core.ts:527`; `task-core.ts:970` | `decide.test.ts:1786`; `decide.test.ts:1825`; `invariants.test.ts:580`; E6 | Mutation REPAIR làm 12 test đỏ. Bỏ guard vẫn còn hai test đỏ. Runtime completion của effect chưa được S2 chứng minh. |
| P3-S2V5-MED-001 | RESOLVED theo R27 | `purity.test.ts:141`; `purity.test.ts:155`; `purity.test.ts:290` | `purity.test.ts:479`; `purity.test.ts:542`; `purity.test.ts:543`; E7 | Locale mutation làm hai test đỏ. Bỏ allowlist làm bốn seed đỏ. Clean production và clean controls đều xanh. |
| P3-S2V5-LOW-001 | NOT_FIXED — REJECTED theo R27 | `index.ts:19`; `phase-03-review-log.md:1483`; `RC:480` | Không cần regression cho finding bị bác. | Không yêu cầu khôi phục export. Đây không còn là thay đổi bắt buộc. |
| P3-S2R-HIGH-002 | PARTIAL | `task-core.ts:723`; `task-core.ts:780`; `sequential-interpreter.ts:126` | `decide.test.ts:1609`; `decide.test.ts:1664`; E3–E5 | Retryability không còn suy ra `none`. Reconcile vẫn chưa phân biệt được PR ở repository khác. |
| P3-S2-HIGH-003 | PARTIAL | `task-core.ts:788`; `task-core.ts:818`; `task-core.ts:1218` | `decide.test.ts:1723`; `decide.test.ts:1699`; E3, E5, E9 | Wrong-head/read-failure thắng cancel. Observation thiếu metadata vẫn có thể bị coi là reconcile thành công. |

### Bằng chứng chạy độc lập

Các driver dùng lệnh sau với `registerHooks` và source overlay trong RAM:

```sh
node --no-wasm-code-gc --experimental-transform-types --disable-warning=ExperimentalWarning --input-type=module --eval '<driver>'
```

Driver resolve `@asep/domain` vào source của snapshot.
Driver resolve TypeScript từ `<npx-cache>/node_modules/typescript/`.
Không mutation nào được ghi xuống file.

| Evidence | Lệnh hoặc probe đã chạy | Kết quả |
|---|---|---|
| E1 | `git rev-parse HEAD`; `git status --porcelain=v1`; `git diff --check ac04c8c HEAD` | HEAD đúng yêu cầu. Status rỗng trước và sau review. Diff check exit 0. |
| E2 | Driver nạp `decide.test.ts`, `invariants.test.ts`, `purity.test.ts` | **288 pass, 0 fail, 0 skipped**. |
| E3 | `PR_WRONG_HEAD_PROBE`, không cancel và có cancel | Cả hai trả `FAILED / publication-incomplete`, `prNumber:null`. |
| E4 | Export RAM `generate`, `generatePublication` và các oracle | Seed 1351 trả `FAILED / publication-incomplete`. Seed 1–10000 của cả hai generator đều qua các oracle đã chạy. |
| E5 | Mutation đổi `if (ownRemote && pr !== null)` thành `if (pr !== null)` | **271 pass, 17 fail**. Wrong-head tests, property tests và seed 1351 đều đỏ. |
| E6 | Mutation release trước `endAttempt` trong REPAIR | **276 pass, 12 fail**. Bỏ thêm guard: **286 pass, 2 fail**. |
| E7 | Mutation thêm `toLocaleString()` vào production source và scanner overlay | **286 pass, 2 fail**. Bỏ ambient allowlist riêng: **284 pass, 4 fail**. |
| E8 | `BASE_INPUT`, `NONDEFAULT_BASE`, `HARDCODE_MAIN_COUNTEREXAMPLE` | Input không hợp lệ không bị validator bắt. Code hiện truyền base `release` đúng. Mutation ép `main` vẫn xanh toàn bộ suite. |
| E9 | `IDENTITY_MATRIX` trên hai đường reconcile, có và không cancel | Metadata fork/closed/merged/multiple bị bỏ qua. Hai publication oracle vẫn xanh. |
| E10 | `R29_acquire-failure`, `R29_acquire-cancel`, `R29_lookup-failure`, `R29_lookup-failure-cancel` | Không có lookup lease. Lookup failure dùng reason cũ; cancel còn đổi task thành `CANCELLED`. |
| E11 | `TERMINAL_PATH_*`: overrun, publication expiry, repair-extension expiry, registration-found, double-unknown | Thứ tự outcome/release đều đúng. Double-unknown reconcile hai lần rồi handoff. |
| E12 | Mutation reflective constructor qua computed key bị ép literal type | **288 pass, 0 fail**. Scanner cũng trả `violations:[]`. |

E4 kiểm 10.000 task trace bằng bốn oracle.
E4 kiểm thêm 10.000 publication trace bằng hai oracle.
Các hàm oracle nằm tại `invariants.test.ts:362`, `:739`, `:787` và `:818`.

### Identity predicate và `baseBranch`

Hai nhánh reconcile dùng chung predicate tại `task-core.ts:780`.
Tên head khác, SHA khác hoặc base khác đều bị từ chối (`decide.test.ts:1710`).

Base đổi trước reconciliation read cũng bị từ chối (`decide.test.ts:1715`).
Successful upsert chỉ trả PR number, nên S2 không tự kiểm trạng thái remote sau đó (`types.ts:381`).

DTO không chứa head repository hoặc base repository (`types.ts:391`).
DTO cũng không chứa state, merged flag hoặc candidate set (`types.ts:391`).

E9 thêm metadata ngoài DTO để kiểm việc mất thông tin.
Kết quả chứng minh core không phân biệt các observation đó.
E9 không chứng minh GitHub adapter thực tế đã trả PR đóng.

Comment yêu cầu “open PR” tại `types.ts:386`.
Điều kiện này hiện phụ thuộc activity chưa triển khai tại `phase-03-plan.md:637`.
Nhiều PR cùng head cũng chưa có quy tắc chọn candidate tại `phase-03-data-model.md:460`.

`baseBranch` được dùng nhất quán ở hai request hiện tại (`task-core.ts:764`; `task-core.ts:797`).
Tuy nhiên, `taskInputErrors` không validate trường này (`validation.ts:43`).

E8 thử `undefined`, `null`, chuỗi rỗng và `main..evil`.
Mọi trường hợp đều nhận `errors:[]`.
Với fixture echo expected base, các trường hợp đó còn đi tới handoff.

### Terminal, lease và khả năng kẹt

Chỉ hai vị trí gọi helper release: `task-core.ts:528` và `task-core.ts:972`.
Cả hai đều đứng sau `endAttempt`.

Abandon, exhaustion và close đi qua `finishAttempt` (`task-core.ts:885`; `:908`; `:1226`).
Cancel và pause timeout cũng đi qua close (`task-core.ts:1184`; `:1118`).

E11 kiểm thêm overrun, approval expiry và repair-extension expiry.
Registration-found không phát release vì chưa request lease, đúng mô hình hiện tại (`task-core.ts:503`).

Seal không kết thúc child đang chạy (`run-core.ts:259`).
Drain vẫn chờ child hoặc operator xử lý pause (`phase-03-exit-criteria.md:620`).

Không thấy release trước outcome trên đường hợp lệ đã kiểm.
Guard tại `task-core.ts:504` không nổ trong baseline hoặc generator mở rộng.

Nếu guard nổ, reducer không trả decision chứa terminal commands (`task-core.ts:160`).
Một interpreter retry cùng state/event sẽ tiếp tục gặp cùng lỗi.
Mutation E6 chứng minh failure này, nhưng chưa tìm thấy đường hợp lệ kích hoạt nó.

S2 interpreter chỉ thu thập effects; nó không thực thi outcome write (`sequential-interpreter.ts:81`).
Vì vậy, S2 chứng minh thứ tự phát command.
S2 chưa chứng minh outcome activity hoàn tất trước release.

Cam kết await từng effect thuộc S7 (`phase-03-plan.md:638`).
Fenced-write failure và recovery thực tế vẫn cần integration test.

### Finding mới

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P3-S2V6-HIGH-001 | HIGH | `types.ts:391`; `task-core.ts:780`; `invariants.test.ts:705` | Identity dùng tên branch chưa gắn repository. PR từ fork có thể chiếu thành cùng DTO hợp lệ. State và candidate ambiguity cũng không được biểu diễn. Oracle lặp cùng giới hạn. | Khóa identity có repository. Quy định open/unmerged và cách chọn candidate. Truyền observation cần thiết hoặc chứng minh normalization bằng conformance tests. |
| P3-S2V6-HIGH-002 | HIGH — đã biết, đang sửa | `task-core.ts:699`; `task-core.ts:1180`; `types.ts:354`; `RC:553` | Acquire lỗi/abort đi thẳng terminalization mà không lookup grant đã commit. E10 không phát `findLease`. Khi nối R28, workflow có thể thiếu caller fence và mất terminal write. | Thêm non-cancellable lookup lease. Xử lý found/absent và late-grant refusal bằng tối đa hai lookup theo R29. |
| P3-S2V6-HIGH-003 | HIGH — đã biết, đang sửa | `task-core.ts:694`; `task-core.ts:1218`; `RC:559` | Lookup failure vẫn trả `attempt-registration-failed`. Pending cancel còn thắng thành `CANCELLED`. Audit thiếu idempotency key; summary ghi zero attempts trong E10. | Trả `FAILED / attempt-state-unknown` kể cả có cancel. Audit idempotency key. Báo telemetry gap và giữ ngoại lệ terminal minh bạch. |
| P3-S2V6-MED-001 | MEDIUM | `validation.ts:43`; `invariants.test.ts:102`; `decide.test.ts:1754` | `baseBranch` chưa được validate. Toàn bộ input fixture dùng `main`. Mutation ép upsert sang `main` vẫn qua 288 test. | Validate Git branch name tại input boundary. Thêm negative cases và base khác `main`. Oracle phải kiểm base của upsert request độc lập. |

Không thấy vòng lặp reconcile mới trong E4 và E11.
Hai lượt unknown kết thúc sau hai read tại `task-core.ts:783` và `task-core.ts:788`.

Không thấy false positive trên production core trong E2.
Clean controls cũng xanh tại `purity.test.ts:587`.

Boundary vẫn đúng theo các lệnh sau:

```sh
git diff --name-status ac04c8c HEAD
git diff --name-status 00a6889 HEAD
git diff 00a6889 HEAD -- tsconfig.json scripts/lib/canonical-tests.mjs pnpm-lock.yaml
rg -n '@temporalio' packages/orchestration
```

Diff sau v5 chỉ chạm docs và `packages/orchestration`.
Diff từ base chỉ bổ sung registry, project reference và workspace links được R15 cho phép.
Không có `@temporalio` trong package.

### Mutation không bị bắt

**Mutation 1: ép base PR thành `main`.**

Tại `task-core.ts:797`, đổi:

```ts
baseBranch: step.s.input.baseBranch,
```

thành:

```ts
baseBranch: 'main',
```

E8 chạy toàn bộ ba suite: **288 pass, 0 fail**.

Test lẽ ra phải bắt là test base tại `decide.test.ts:1749`.
Test này chỉ dùng `TASK_BASE_BRANCH = 'main'` (`test-support/fixtures.ts:24`).

Generator cũng chỉ dùng base đó (`invariants.test.ts:102`).
Publication oracle không kiểm base của upsert request (`invariants.test.ts:623`).

Counterexample E8 dùng input base `release`.
Upsert request mang `main`, còn reconcile request mang `release`.
Suite hiện tại không phát hiện sự không nhất quán này.

**Mutation 2: constructor qua computed key có type assertion.**

E12 thêm vào `task-core.ts` trong RAM:

```ts
export const reviewClock = ((() => {})[("constr" + "uctor") as "name"] as unknown as (body: string) => () => number)("return Date.now()")();
```

Scanner nhận key type `"name"` tại `purity.test.ts:297`.
Runtime key vẫn là `"constructor"`.

E12 giữ **288 pass, 0 fail**.
Test production determinism tại `purity.test.ts:479` không bắt được.

Đây nằm trong giới hạn arbitrary computation đã công bố (`phase-03-architecture.md:140`).
Không coi đây là regression mới của allowlist.
Detector vẫn cần bundler/replay evidence như plan đã yêu cầu (`phase-03-architecture.md:142`).

## Kết luận

Các counterexample SHA, thứ tự release và locale của v5 đã có regression đỏ khi bỏ fix; E3–E7 xác nhận.

Snapshot chưa đủ để chấp nhận identity toàn diện và protocol R29 (`types.ts:391`; `task-core.ts:694`; `task-core.ts:699`).

Cần hoàn tất R29 **đã biết, đang sửa**, khóa repository identity, bổ sung validation/base tests và đồng bộ prose finality.

Review không chạy `verify:all`.
Không sửa file; `git status --porcelain=v1` cuối lượt vẫn rỗng.
