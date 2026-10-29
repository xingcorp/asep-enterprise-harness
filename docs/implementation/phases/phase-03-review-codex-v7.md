<!--
Provenance: independent, read-only Codex re-audit of the Phase 3 plan v7 and of the S2 fixes.
Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, run by the controller on 2026-10-30 as a single
uninterrupted run of the Codex CLI 0.165.0. The gateway appends its own style instructions and tools to every
request (reconciliation R16), so the review holds "via this gateway".
Reviewed snapshot: `ac0a1bc` (branch phase/03-durable-orchestration, plan LOCKED v7).
Controller gate at `ac0a1bc`, on a clean detached worktree: `pnpm verify:all` exit 0, 935 pass, 0 fail, 0 skipped;
53 test files, 31 required suites.
Copied verbatim from the controller's review output. Two mechanical changes only: host paths are replaced by
`<controller-lanes>/` (the controller's lane directory) and `<npx-cache>/` (the reviewer's npx cache), so no host
path enters the public tree, and a final newline is added.
Adjudication of every finding: `phase-03-review-log.md`, section "Review v7".
-->

VERDICT: REQUEST_CHANGES  confidence 0.96

## Phần 1 — Plan v7

Snapshot đã kiểm là `ac0a1bc5480d2a80971b031876a8491a0e828336`, theo `git rev-parse HEAD`.

Trong báo cáo, `phase-03-*.md` nằm trong `docs/implementation/phases/`.
Các tên source nằm trong `packages/orchestration/src/`.
`RC` là `<controller-lanes>/reconciliation-v1.md`.

### Disposition finding plan v6

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P3-PLAN6-HIGH-001 | FOLDED | `phase-03-architecture.md:303`; `phase-03-architecture.md:400`; `phase-03-plan.md:659`; `phase-03-exit-criteria.md:259` | Flow, activity, slice và acceptance đã có found/absent/late-grant. L6 bổ sung telemetry gap tại `phase-03-exit-criteria.md:660`. |
| P3-PLAN6-MED-001 | FOLDED | `phase-03-plan.md:435`; `phase-03-architecture.md:664`; `phase-03-exit-criteria.md:441` | PR upsert lỗi nhưng reconcile đúng được tiếp tục. `publication-incomplete` chỉ áp dụng khi publication chưa reconcile được. |
| P3-PLAN6-MED-002 | FOLDED | `phase-03-data-model.md:468`; `phase-03-architecture.md:243`; `phase-03-exit-criteria.md:448` | Observation đã chứa repository, candidate set, state và merged flag. Predicate được giao cho core. |

### Đối chiếu R1–R32

“Phù hợp ở plan” chưa chứng minh integration.
G-P2 và G-LB vẫn chặn S0 tại `phase-03-plan.md:632`.

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| R1 | Phù hợp ở plan | `phase-03-plan.md:776`; `phase-03-architecture.md:524` | Plan dùng primitive Phase 2 và giữ reconciliation trước reopen. |
| R2 | Phù hợp ở plan | `phase-03-plan.md:778`; `phase-03-architecture.md:533` | Plan không dựng lại `resultRef?: unknown` hoặc result contract song song. |
| R3 | Phù hợp có điều kiện | `phase-03-plan.md:929`; `phase-03-exit-criteria.md:606` | Composition và terminal hook đã có. Verbatim block vẫn chờ hand-off. |
| R4 | Phù hợp ở plan | `phase-03-data-model.md:297`; `phase-03-data-model.md:304`; `phase-03-data-model.md:313` | DDL có tenant key, scoped FK, append-only và conflict theo bytes. |
| R5 | Phù hợp ở plan | `phase-03-plan.md:743` | Chỉ một superset bump `run-event` lên `1.2.0`. |
| R6 | Phù hợp ở plan | `phase-03-plan.md:725` | Task CHECK và attempt CHECK giữ ownership riêng. |
| R7 | Phù hợp phần Lane A | `phase-03-plan.md:739` | Plan chỉ cộng ba schema của Lane A. |
| R8 | Phù hợp phân kỳ | `phase-03-plan.md:640`; `phase-03-plan.md:1001` | S2 giữ guard cục bộ. Shared guard chờ framework sau rebase. |
| R9 | Phù hợp ở plan | `phase-03-plan.md:1091` | Temporal và Grafana giữ section riêng để union. |
| R10 | Phù hợp | `phase-03-review-log.md:1484`; lệnh `git diff 00a6889 HEAD -- tsconfig.json scripts/lib/canonical-tests.mjs pnpm-lock.yaml` | Registry chung chỉ bổ sung. R27 đã bác yêu cầu khôi phục export nội bộ. |
| R11 | Phù hợp | `phase-03-plan.md:1194` | ADR `0017` vẫn thuộc Lane A. |
| R12 | Phù hợp trong phạm vi diff | `phase-03-architecture.md:471`; lệnh `git diff --name-status 00a6889 HEAD` | Corpus Phase 3 dùng workflow histories. Diff không đổi collector hoặc public-history refs. |
| R13 | Chờ integration | `phase-03-plan.md:491`; `RC:124` | Reviewer adapter thuộc Lane B. S2 chưa chứng minh credential lifetime hoặc rotation. |
| R14 | Phù hợp ở plan | `phase-03-exit-criteria.md:171`; `phase-03-exit-criteria.md:699` | PostgreSQL restart smoke vẫn là pre-deployment gate. |
| R15 | Phù hợp | `phase-03-plan.md:636`; `phase-03-data-model.md:324`; `phase-03-architecture.md:882` | Chỉ S2 được code trước rebase. Operational FK và fixed logical time được giữ. |
| R16 | Phù hợp | `phase-03-plan.md:935`; `phase-03-review-log.md:428` | Slot ở application. Review log ghi giới hạn “via this gateway”. |
| R17 | Phù hợp trong S2 | `task-core.ts:628`; `task-core.ts:1000`; `phase-03-plan.md:369` | Exhaustion, reservation và publication critical units được giữ. |
| R18 | Phù hợp gate | `phase-03-plan.md:635`; `phase-03-architecture.md:840` | S0 vẫn chờ controller hand-off block đã sửa. |
| R19 | Phù hợp trong S2 | `task-core.ts:1025`; `task-core.ts:1088` | Extension chỉ áp dụng task cap. Assurance infrastructure failure giữ shadow/gating routing. |
| R20 | Phù hợp trong S2 | `task-core.ts:624`; `task-core.ts:1021` | Never-replaceable failure thắng exhaustion. Attempts exhausted vẫn thắng budget. |
| R21 | Phù hợp trong S2 | `validation.ts:39`; `task-core.ts:716`; `run-core.ts:265` | Registration reconciliation, never-replaceable classes và seal đã được kiểm lại bằng trace. |
| R22 | Ngoài phần code đã đổi | `RC:313`; lệnh `git diff --name-status 392f259 HEAD` | Diff không chạm collector hoặc vocabulary của Lane B. |
| R23 | Phù hợp thứ tự command | `task-core.ts:496`; `task-core.ts:546`; `task-core.ts:1132` | Terminal mang caller fence và đứng trước release. Transaction thật vẫn chờ integration. |
| R24 | Phù hợp trong S2 | `task-core.ts:755`; `sequential-interpreter.ts:126`; `phase-03-architecture.md:499` | Unknown effect không suy từ retryability. Drain không tự resume task paused. |
| R25 | Phù hợp | `purity.test.ts:109`; `purity.test.ts:134`; `phase-03-architecture.md:140` | Deny set mở rộng và giới hạn detector vẫn được công bố. |
| R26 | Phù hợp phân công | `phase-03-review-log.md:1495`; `RC:449` | Workaround gate thuộc Phase 2. Các driver review dùng `--no-wasm-code-gc`. |
| R27 | Phù hợp trong S2 | `task-core.ts:905`; `task-core.ts:916`; `task-core.ts:546` | Identity và outcome-before-release đã có regression đỏ khi bẻ fix. |
| R28 | Phù hợp có điều kiện | `phase-03-architecture.md:295`; `phase-03-architecture.md:856`; `task-core.ts:806` | Core xử lý pre-lease. Slot transaction và seam micro-USD vẫn chờ S0/integration. |
| R29 | Phù hợp trong S2 | `task-core.ts:775`; `task-core.ts:793`; `task-core.ts:855` | Lookup hữu hạn, unknown thắng cancel, audit và summary đều chứa idempotency key. |
| R30 | PARTIAL | `phase-03-architecture.md:570`; `phase-03-plan.md:1254`; `RC:584` | Plan chưa khóa push CAS, immutable PR content và takeover reconciliation theo quyết định mới. |
| R31 | PARTIAL | `validation.ts:25`; `invariants.test.ts:444`; `phase-03-exit-criteria.md:255` | Identity đã sửa. Git validation còn thiếu; repository-request oracle chưa đạt lời khai trong docs. |
| R32 | PARTIAL | `phase-03-exit-criteria.md:660`; `phase-03-plan.md:657`; `RC:660` | Code xử lý failed pre-lease write đúng. Prose và conformance chưa đồng bộ toàn bộ quyết định sau snapshot. |

### Finding plan mới và mâu thuẫn tài liệu

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P3-PLAN7-HIGH-001 | CẦN SỬA | `phase-03-architecture.md:572`; `phase-03-threat-model-delta.md:95`; `phase-03-plan.md:1256`; `RC:584` | Natural key và pre-call fence chưa đủ bảo vệ late remote write. Bổ sung push `--force-with-lease`, immutable PR content và reconciliation trước terminal. Khóa các interleaving tests của R30 vào acceptance. |
| P3-PLAN7-MED-001 | CẦN SỬA | `phase-03-architecture.md:323`; `phase-03-data-model.md:508`; `phase-03-exit-criteria.md:660`; `phase-03-exit-criteria.md:265` | L6 và data model chỉ nói lookup/read failure. D17 đã bao failed pre-lease write. Đồng bộ ngoại lệ read/write và mọi đường gap theo R32. |
| P3-PLAN7-MED-002 | CẦN SỬA | `phase-03-plan.md:657`; `phase-03-exit-criteria.md:49`; `RC:664` | Khóa mapping riêng `ReviewLoopContractError.code === 'lease-granted'` thành `recorded:false`. Không chuyển thành supersession hoặc generic activity failure. Bổ sung RLC-16 cho stateful slot và registration-before-effect conformance. |
| P3-PLAN7-MED-003 | CẦN SỬA | `phase-03-exit-criteria.md:255`; `phase-03-review-log.md:1698`; `types.ts:257`; `invariants.test.ts:444` | Docs nói mọi upsert/reconcile request mang repository và oracle kiểm theo input. Upsert DTO không có repository. Oracle hiện chỉ kiểm base. Chọn contract rõ ràng và sửa acceptance tương ứng. |
| P3-PLAN7-LOW-001 | CẦN LÀM RÕ | `phase-03-plan.md:657`; `phase-03-architecture.md:928`; `phase-03-architecture.md:934` | S0 đang nói blanket rằng pre-lease terminals map sang `infrastructure-failed`. Ghi rõ chỉ `failed` được đổi tên. `cancelled` phải giữ nguyên. |

R32 được viết sau snapshot, nên các thiếu sót R32 trên là yêu cầu đồng bộ mới, không phải regression của commit S2.

## Phần 2 — S2 sau sửa

### Disposition finding cũ

| ID | trạng thái | file:line | test chứng minh | ghi chú |
|---|---|---|---|---|
| P3-S2V6-HIGH-001 | RESOLVED | `types.ts:424`; `task-core.ts:905`; `task-core.ts:916` | `decide.test.ts:1906`; `decide.test.ts:1914`; `invariants.test.ts:1177` | Đạt observation và predicate R31. Mutation bỏ các điều kiện PR gây **38 test đỏ**. Giới hạn stable repository identity được tách riêng bên dưới. |
| P3-S2V6-HIGH-002 | RESOLVED | `task-core.ts:724`; `task-core.ts:793`; `task-core.ts:821`; `task-core.ts:1346` | `decide.test.ts:2046`; `decide.test.ts:2058`; `decide.test.ts:2070`; `decide.test.ts:2097`; `decide.test.ts:2111` | Found/absent/late-grant đã hoạt động. Bỏ lookup sau acquisition failure gây **17 test đỏ**. |
| P3-S2V6-HIGH-003 | RESOLVED | `task-core.ts:855`; `task-core.ts:1395`; `task-core.ts:1424` | `decide.test.ts:633`; `decide.test.ts:645`; `decide.test.ts:652`; `decide.test.ts:2120` | Cho cancel thắng unknown gây **6 test đỏ**. Xóa gap khỏi summary gây **10 test đỏ**. |
| P3-S2V6-MED-001 | PARTIAL | `validation.ts:25`; `invariants.test.ts:444` | `decide.test.ts:278`; `decide.test.ts:1937`; probe `BASE_INPUT` | Bốn input v6 bị từ chối. Mutation ép base thành `main` gây **6 test đỏ**. Một số Git branch không hợp lệ vẫn được nhận. |
| P3-S2V5-HIGH-001 | RESOLVED | `task-core.ts:905`; `task-core.ts:936` | `decide.test.ts:1853`; `decide.test.ts:1861`; `invariants.test.ts:1214` | Bỏ so branch SHA gây **14 test đỏ**. Wrong-head không còn được handoff hoặc che bằng cancel. |
| P3-S2R-HIGH-002 | RESOLVED | `task-core.ts:755`; `sequential-interpreter.ts:126` | `decide.test.ts:1777`; `decide.test.ts:1785`; `decide.test.ts:1829` | Mutation coi unknown push là none gây **41 test đỏ**. Retryability không còn đại diện cho remote effect. |
| P3-S2-HIGH-003 | RESOLVED | `task-core.ts:936`; `task-core.ts:967` | `decide.test.ts:1804`; `decide.test.ts:1861`; `decide.test.ts:1914` | Các case có cancel giữ `FAILED / publication-incomplete`. Mutation bỏ identity làm những case này đỏ. |
| E12 / R31 purity hardening | RESOLVED | `purity.test.ts:242`; `purity.test.ts:252`; `purity.test.ts:330` | `purity.test.ts:520`; `purity.test.ts:606`; mutation E12 | Expression sống sót của v6 nay gây **2 test đỏ** khi chèn vào production source trong RAM. |

### Finding S2 mới

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P3-S2V7-MED-001 | MEDIUM | `validation.ts:25`; `decide.test.ts:254` | Validator nhận `/main`, `.hidden`, `release/.hidden` và `a.lock/b`. Git từ chối cả bốn tên. | Kiểm leading slash và từng path component. Thêm negative cases độc lập với implementation. |
| P3-S2V7-MED-002 | MEDIUM | `invariants.test.ts:93`; `invariants.test.ts:108`; `invariants.test.ts:444`; `decide.test.ts:1893` | Hai mutation identity có tác động thật vẫn qua **387/387** test. Repository luôn cố định; generator không phát head branch chỉ khác hoa thường. | Thay đổi repository trong fixture/generator. Assert request repository bằng input. Thêm branch case-collision trên cả hai reconciliation path. |
| P3-S2V7-MED-003 | MEDIUM | `types.ts:178`; `task-core.ts:900`; `phase-03-data-model.md:373` | DTO chỉ nhận diện repository bằng owner/name. Nó không phân biệt repository khác tái dùng pathname sau rename/transfer. | Khóa policy rename/transfer trước integration. Đối chiếu numeric repository ID tại activity, hoặc mang stable ID vào observation. Thêm conformance test đổi ID nhưng giữ pathname. |

MED-003 là giới hạn mô hình ngoài predicate owner/name đã khóa ở R31.
Probe không chứng minh GitHub adapter thật đang đọc nhầm repository.
Binding hiện đã có numeric ID tại `adapters/github-app/src/binding-resolver.ts:101`.

### Mutation không bị bắt

**Mutation 1 — So head branch không phân biệt hoa thường.**

Tại `task-core.ts:923`, thay:

```ts
pr.headBranch !== a.branch
```

bằng:

```ts
pr.headBranch.toLowerCase() !== a.branch?.toLowerCase()
```

Driver `M_HEAD_CASE` chạy cùng 387 callback: **387 pass, 0 fail**.

Counterexample dùng PR head `ASEP/RUN-1/TASK-1/ATT-1`.
Attempt branch vẫn là `asep/run-1/task-1/att-1`.

Driver `M_HEAD_CASE_COUNTEREXAMPLE` trả:

| cancel pending | kết quả mutant |
|---|---|
| Không | `WAITING_FOR_HUMAN_REVIEW`, PR 7. |
| Có | `CANCELLED`, PR 7. |

Code hiện tại từ chối đúng hai trường hợp này tại `task-core.ts:923`.
Test identity tại `decide.test.ts:1906` và `decide.test.ts:1914` lẽ ra phải bắt mutation.

**Mutation 2 — Cố định repository trong reconciliation request.**

Tại `task-core.ts:890`, thay:

```ts
repository: s.input.repository,
```

bằng:

```ts
repository: { owner: 'acme', name: 'widgets' },
```

Driver `M_REPO_HARDCODE` giữ **387 pass, 0 fail**.

Counterexample `NONDEFAULT_REPOSITORY` dùng input `different-org/different-repo`.
Baseline handoff thành công.
Mutant đọc `acme/widgets` rồi trả `FAILED / publication-incomplete`.

Generator cố định repository tại `invariants.test.ts:108`.
Fixture cũng cố định repository tại `test-support/fixtures.ts:28`.
Oracle tại `invariants.test.ts:444` chưa kiểm repository của request.

Hai property tests tại `invariants.test.ts:1066` và `invariants.test.ts:1177` lẽ ra phải bắt mutation này.

### Bằng chứng chạy độc lập

Các driver chạy source của snapshot bằng invocation sau:

```sh
node --no-wasm-code-gc --experimental-transform-types --disable-warning=ExperimentalWarning --input-type=module --eval '<driver RAM>'
```

Driver dùng `registerHooks` để resolve `.js` sang source `.ts`.
`@asep/domain` được resolve vào source cùng snapshot.
Mutation và purity overlay chỉ tồn tại trong RAM.

| Evidence | Lệnh hoặc probe đã chạy | kết quả |
|---|---|---|
| E1 | `git rev-parse HEAD`; `git status --porcelain=v1`; `git diff --check 392f259 HEAD` | HEAD đúng. Status rỗng trước và sau review. Diff check exit 0. |
| E2 | Node test runner nạp `decide.test.ts`, `invariants.test.ts`, `purity.test.ts` | **387 pass, 0 fail, 0 skipped, 0 cancelled**. |
| E3 | `IDENTITY_MATRIX`, hai reconciliation path, có và không cancel | Fork, closed, merged, multiple, wrong repository, wrong branch và wrong SHA đều bị từ chối. |
| E4 | Bốn probe `R29_acquire-failure`, `R29_acquire-cancel`, `R29_lookup-failure`, `R29_lookup-failure-cancel` | Acquisition được lookup trước terminal. Lookup failure luôn thành `FAILED / attempt-state-unknown`. |
| E5 | `R29_late-grant`, `R29_second-absent`, lease-lookup failure và pre-lease-write failure có cancel | Late grant dùng hai lookup. Second absent và store failure đều có audit key cùng summary gap. |
| E6 | `BASE_INPUT`; `NONDEFAULT_BASE`; `git check-ref-format --branch <value>` | Bốn input v6 bị validator bắt. Bốn tên Git không hợp lệ của MED-001 vẫn trả `errors:[]`. |
| E7 | Hai mutation sống sót v6: base ép `main`, constructor E12 | Lần lượt **6** và **2** test đỏ. |
| E8 | `EXTENDED_10000` | **10.000 task trace** qua năm oracle. **10.000 publication trace** qua hai oracle. Có 170 unknown-state trace và 87 late-grant trace. |
| E9 | `M_IDENTITY_EXISTENCE`, `M_BRANCH_SHA`, `M_UNKNOWN_PUSH_NONE` | Lần lượt **38**, **14**, **41** test đỏ. |
| E10 | `M_NO_FINDLEASE`, `M_CANCEL_WINS_UNKNOWN`, `M_HIDE_GAP` | Lần lượt **17**, **6**, **10** test đỏ. |
| E11 | `M_HEAD_CASE`, `M_REPO_HARDCODE` | Cả hai giữ **387/387** test xanh. Counterexample riêng chứng minh thay đổi hành vi. |
| E12 | `M_RELEASE_GUARD`; `M_REPAIR_ORDER_NO_GUARD` | Bỏ guard riêng giữ 387 test xanh. Đảo release/outcome và bỏ guard gây **2 test đỏ**. |

Review này không chạy `verify:all`.
Con số 935/935 của lane không được dùng làm bằng chứng.

### Publication observation

So repository không phân biệt hoa thường là đúng với GitHub.
OpenAPI cache ghi owner và repository name đều “not case sensitive” tại các dòng `84785` và `84787` của:

```text
<npx-cache>/node_modules/@octokit/plugin-rest-endpoint-methods/node_modules/@octokit/openapi-types/types.d.ts
```

Core dùng `toLowerCase()`, không dùng locale conversion, tại `task-core.ts:901`.

| trường hợp | kết luận và bằng chứng |
|---|---|
| Repository chỉ khác hoa thường | Được nhận đúng trong `IDENTITY_MATRIX`. Regression có tại `decide.test.ts:1923`. |
| Rename hoặc transfer làm canonical owner/name đổi | Bị từ chối bằng `branch-other-repository` trong `IDENTITY_MATRIX`. Predicate nằm tại `task-core.ts:907`. |
| Repository khác tái dùng pathname cũ | DTO không phân biệt được. `RENAME_SLUG_REUSE` với ID kỳ vọng 101 và ID quan sát 202 vẫn handoff. |
| Head branch có `#`, `%2F`, `+`, `$`, `&` | `SPECIAL_BRANCH` giữ nguyên chuỗi và reconcile đúng. Chuỗi bị decode hoặc thêm suffix bị từ chối. |
| PR draft | Được nhận nếu vẫn open, unmerged và đúng identity. R31 không yêu cầu ready-for-review tại `RC:631`. |
| Cùng repository, head branch khác case hoặc suffix | Code hiện từ chối đúng tại `task-core.ts:923`. Mutation case-fold vẫn chưa có regression bảo vệ. |
| Fork, closed, merged hoặc nhiều candidate | Đều trả `FAILED / publication-incomplete` trong `IDENTITY_MATRIX`. Audit ghi finding và observation tại `task-core.ts:967`. |

Probe special branch chỉ chứng minh core giữ và so chuỗi chính xác.
Nó chưa chứng minh URL encoding hoặc pagination của GitHub activity; activity thuộc S6 tại `phase-03-plan.md:663`.

Observation hiện không kiểm PR title/body tại `types.ts:441`.
Vì vậy, observation chưa thay thế nghĩa vụ content reconciliation của R30 tại `RC:594`.

### R29, terminal và khả năng kẹt

Lookup đầu được tạo tại `task-core.ts:775`.
Absent chỉ tạo một pre-lease write tại `task-core.ts:806`.

Pre-lease refusal tạo lookup thứ hai tại `task-core.ts:831`.
Second absent kết thúc unknown tại `task-core.ts:802`.

Found chuyển sang terminalization tại `task-core.ts:797`.
Không có đường quay lại pre-lease write từ lookup thứ hai trong protocol này.

Lookup failure và failed pre-lease write cùng đi vào `attemptStateUnknown` tại `task-core.ts:727`.
Unknown thắng cancel tại `task-core.ts:864`.

Audit chứa idempotency key tại `task-core.ts:860`.
Summary chứa gap tại `task-core.ts:1424`.
Các attempt unknown không nhận usage, outcome hoặc release tại `task-core.ts:1395`.

Các activity này không cancellable và có retry hữu hạn tại `activity-options.ts:66`.
Trong E4, E5 và E8, không thấy vòng lặp hoặc terminal mất mà không báo gap.

Việc chuyển summary gap sang telemetry thật vẫn thuộc S7 tại `phase-03-plan.md:664`.
Review chưa chứng minh telemetry integration.

R32 xác nhận failed pre-lease write → unknown là đúng tại `RC:660`.
Không yêu cầu đổi hành vi này.

### Đánh giá guard “release trước outcome”

Nhận định của lane đúng trong miền state hợp lệ đã kiểm.

Chỉ hai call site phát release: `task-core.ts:547` và `task-core.ts:1134`.
Cả hai đều gọi `endAttempt` trước.

`endAttempt` gọi `recordOutcome` tại `task-core.ts:488`.
`recordOutcome` đặt `outcomeRecorded=true` trước khi trả về tại `task-core.ts:499`.

Vì vậy, bỏ riêng release guard không đổi hành vi reachable hiện tại.
E12 xác nhận mutation này giữ 387 test xanh.

Mutation đảo thứ tự REPAIR vẫn bị bắt khi đã bỏ guard.
Hai test đỏ là:

- Test per-path REPAIR tại `decide.test.ts:2019`.
- Property ordering tại `invariants.test.ts:1066`, với counterexample seed 38.

Test lease-settlement guard tại `decide.test.ts:2168` cố ý xóa fence khỏi state.
Test này chứng minh guard tồn tại, không chứng minh state đó reachable.

Nếu guard nổ, reducer ném trước khi trả decision tại `task-core.ts:155`.
S2 không chứng minh recovery runtime cho trường hợp đó.

S2 interpreter chỉ thu thập effects tại `sequential-interpreter.ts:81`.
Nghĩa vụ await outcome write trước release vẫn thuộc S7 tại `phase-03-plan.md:664`.

### Lỗi mới và ranh giới

Không thấy nondeterminism mới trong production core qua E2 và replay properties tại `invariants.test.ts:1227`.
Các lookup mới giữ tiến trình hữu hạn trong E8.

Validator thiếu Git rules là lỗi còn lại của commit sửa base tại `validation.ts:25`.
Hai mutation sống sót là thiếu coverage, không phải hành vi sai hiện hữu của predicate.

Các lệnh boundary đã chạy:

```sh
git diff --name-status 392f259 HEAD
git diff --name-status 00a6889 HEAD
git diff 00a6889 HEAD -- tsconfig.json scripts/lib/canonical-tests.mjs pnpm-lock.yaml
rg -n '@temporalio' packages/orchestration
```

Sau v6, diff chỉ chạm docs và `packages/orchestration`.
Từ base, registry chỉ thêm suite, project reference và workspace links được R15 cho phép.
`rg` không tìm thấy `@temporalio` trong package.

## Kết luận

Các HIGH S2 được hỏi đã sửa thực chất theo phạm vi R31, với regression đỏ khi bẻ fix.

Chưa nhận lock plan v7 vì thiếu invariant và acceptance R30, tại P3-PLAN7-HIGH-001.

Cần đồng bộ R32, hoàn thiện Git validation và khóa hai mutation identity mới trước khi chốt vòng kiểm này.
