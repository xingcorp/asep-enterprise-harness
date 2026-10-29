<!--
Provenance: independent, read-only Codex re-audit of the Phase 3 plan v5 and of the S2 fixes.
Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, run by the controller on 2026-10-29 as a single
uninterrupted run of the Codex CLI 0.165.0. The gateway appends its own style instructions and tools to every
request (reconciliation R16), so the review holds "via this gateway".
Reviewed snapshot: `ac04c8c` (branch phase/03-durable-orchestration, plan LOCKED v5).
Controller gate at `ac04c8c`, on a clean detached worktree: `pnpm verify:all` exit 0, 777 pass, 0 fail, 0 skipped;
53 test files, 31 required suites.
Copied verbatim from the controller's review output. Two mechanical changes only: host paths are replaced by
`<controller-lanes>/` (the controller's lane directory) and `<npx-cache>/` (the reviewer's npx cache), so no host
path enters the public tree, and a final newline is added.
Adjudication of every finding: `phase-03-review-log.md`, section "Review v5".
-->

VERDICT: REQUEST_CHANGES  confidence 0.98

## Phần 1 — Plan v5

Snapshot đã kiểm là `ac04c8c06651d4228a72338750fd39223bd1773f`, theo `git rev-parse HEAD`.

Các tên `phase-03-*.md` dưới đây thuộc `docs/implementation/phases/`.
Các tên source S2 thuộc `packages/orchestration/src/`.
`RC` là `<controller-lanes>/reconciliation-v1.md`.

### Disposition finding plan v4

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P3-PLAN4-HIGH-001 | FOLDED | `phase-03-architecture.md:350`; `phase-03-data-model.md:439`; `phase-03-plan.md:620` | Effect được tách khỏi retryability. Failure thiếu effect được đọc thành `unknown`. S6/S7 có trách nhiệm mapping. |
| P3-PLAN4-HIGH-002 | FOLDED | `phase-03-architecture.md:672`; `phase-03-exit-criteria.md:460` | Plan yêu cầu phát hiện overrun trước saturation. Usage ngoài bound tự tạo incident. |
| P3-PLAN4-MED-001 | FOLDED | `phase-03-risk-register.md:28`; `phase-03-threat-model-delta.md:62`; `phase-03-exit-criteria.md:435` | PR3-16 và T3-13 đã có hai ngoại lệ R20 như H8. |

### Đối chiếu R1–R24

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| R1 | Phù hợp ở plan | `phase-03-plan.md:733`; `phase-03-plan.md:750` | Fencing riêng đã rút. Reopen phải reconcile remote trước. |
| R2 | Phù hợp ở plan | `phase-03-plan.md:735`; `phase-03-plan.md:745` | Không thiết kế lại `resultRef?: unknown`. Plan phụ thuộc binding được Phase 2 chấp nhận. |
| R3 | Phù hợp có điều kiện | `phase-03-architecture.md:778`; `phase-03-architecture.md:826`; `phase-03-plan.md:886` | Placement và terminal hook được giữ. Verbatim slot vẫn chờ hand-off. |
| R4 | Phù hợp ở plan | `phase-03-data-model.md:295`; `phase-03-data-model.md:306`; `phase-03-data-model.md:311` | Có composite key, scoped FK, append-only và conflict-by-bytes. |
| R5 | Phù hợp ở plan | `phase-03-plan.md:700` | Chỉ một superset bump `run-event` lên `1.2.0`. |
| R6 | Phù hợp ở plan | `phase-03-plan.md:673`; `phase-03-plan.md:683` | Ownership task status và attempt status vẫn tách biệt. |
| R7 | Phù hợp phần Lane A | `phase-03-plan.md:696` | Lane A cộng schema của mình. Tổng liên lane không bị chốt cứng. |
| R8 | Phù hợp phân kỳ | `phase-03-plan.md:597`; `phase-03-plan.md:621` | Check cục bộ thuộc S2. Shared rule chờ S7. Detector còn lỗ hổng mới bên dưới. |
| R9 | Phù hợp ở plan | `phase-03-plan.md:1052` | Temporal và Grafana được phân section để union. |
| R10 | LỆCH nhỏ | `index.ts:19`; `RC:106` | Registry chung không đổi. Tuy nhiên export `usageMicroUsd` bị xóa, trái quy tắc export append-only. |
| R11 | Phù hợp ở plan | `phase-03-plan.md:1151` | ADR `0017` vẫn thuộc Lane A. |
| R12 | Không thấy lệch trong diff | `phase-03-architecture.md:389`; `RC:116` | Corpus Phase 3 lấy từ workflow histories. Diff không thay lịch sử hoặc corpus Lane B. |
| R13 | Phù hợp ranh giới Lane A | `phase-03-plan.md:448`; `phase-03-architecture.md:780`; `RC:124` | Wrapper ở harness/application. Credential lifecycle của reviewer adapter chưa được kiểm trong phạm vi S2. |
| R14 | Phù hợp ở plan | `phase-03-exit-criteria.md:156`; `phase-03-exit-criteria.md:624` | PostgreSQL restart smoke vẫn là pre-deployment gate. S2 không cung cấp bằng chứng gate này. |
| R15 | Phù hợp | `phase-03-plan.md:593`; `phase-03-data-model.md:322`; `phase-03-architecture.md:795` | Chỉ S2 được code trước rebase. Operational FK và fixed logical time được giữ. |
| R16 | Phù hợp ở plan | `phase-03-plan.md:614`; `phase-03-review-codex-v3.md:5` | Slot ở application. Provenance giữ giới hạn “via this gateway”. |
| R17 | PARTIAL ở publication | `task-core.ts:709`; `task-core.ts:754`; `phase-03-architecture.md:216` | Critical unit giữ cancel đúng. Reconcile PR vẫn có thể chấp nhận HEAD khác commit đã verify. |
| R18 | Phù hợp gate | `phase-03-plan.md:592`; `phase-03-plan.md:886` | S0 vẫn chờ fixed slot block. Đây không tự tạo finding mới. |
| R19 | Phù hợp trong S2 | `task-core.ts:833`; `task-core.ts:909`; `phase-03-plan.md:620` | Extension chỉ dành cho task cap. Assurance infrastructure failure giữ shadow/gating behavior. |
| R20 | Phù hợp trong phạm vi kiểm | `task-core.ts:584`; `phase-03-risk-register.md:28`; `phase-03-threat-model-delta.md:62` | Failure precedence và hai ngoại lệ exhaustion đã đồng bộ. |
| R21 | PARTIAL | `task-core.ts:754`; `invariants.test.ts:789`; `purity.test.ts:228` | Các sửa seal, pause, registration, precision và approval race được giữ. Publication còn thiếu kiểm HEAD. |
| R22 | Ngoài phần code đã đổi | `RC:313`; lệnh `git diff --name-status 7694b8b..HEAD` | Không có thay đổi corpus collector hoặc freeze vocabulary của Lane B. Không xác nhận implementation Lane B. |
| R23 | LỆCH | `phase-03-plan.md:348`; `task-core.ts:1202`; `RC:338` | Plan và core còn release lease trước terminal outcome. R23 bắt buộc thứ tự ngược lại. |
| R24 | PARTIAL | `phase-03-architecture.md:350`; `phase-03-architecture.md:659`; `phase-03-exit-criteria.md:593` | Các probe cũ đã bị chặn. Drain-paused và post-rebase kill grace đã được ghi. Publication còn lỗi HEAD mới. |

### Finding mới của plan

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P3-PLAN5-HIGH-001 | CẦN SỬA | `phase-03-plan.md:348`; `phase-03-plan.md:352`; `phase-03-architecture.md:225`; `RC:341` | Abandon, exhaustion và cancel vẫn mô tả release trước outcome. Thứ tự này không thể nối đúng helper fenced của R23. Phải cập nhật flow, slice và acceptance criterion. |
| P3-PLAN5-HIGH-002 | CẦN SỬA | `phase-03-architecture.md:216`; `phase-03-exit-criteria.md:396`; `phase-03-data-model.md:445` | Reconcile sau PR failure chỉ yêu cầu “PR found”. Plan chưa yêu cầu HEAD vẫn bằng commit của attempt. Phải khóa predicate này cho cả hai giai đoạn reconciliation. |
| P3-PLAN5-MED-001 | CẦN ĐỒNG BỘ | `phase-03-risk-register.md:30`; `phase-03-threat-model-delta.md:68`; `phase-03-exit-criteria.md:396` | PR3-18 và T3-19 vẫn nói PR upsert hết retry luôn thành `publication-incomplete`. G13 mới cho phép tiếp tục khi reconcile xác nhận PR. Phải giới hạn câu cũ vào publication không reconcile được. |

Mâu thuẫn finality trên xuất hiện khi v5 thêm đường recovery sau PR failure (`phase-03-architecture.md:216`).
Việc chờ verbatim slot không miễn thứ tự terminalization đã được controller khóa (`RC:341`).

## Phần 2 — S2 sau sửa

### Bằng chứng chạy độc lập

Các lượt Node dùng `--experimental-transform-types --disable-warning=ExperimentalWarning --input-type=module --eval`.

Driver dùng `registerHooks` để nạp source và mutation trong RAM.
Driver resolve `@asep/domain` vào source của snapshot.
TypeScript checker lấy từ `<npx-cache>/node_modules/typescript/`.

| Evidence | Lệnh hoặc probe đã chạy | Kết quả |
|---|---|---|
| E1 | `git rev-parse HEAD`; `git status --porcelain=v1`; `git diff --check 7694b8b..HEAD` | HEAD đúng yêu cầu. Status rỗng trước và sau review. Diff check exit 0. |
| E2 | Driver nạp `decide.test.ts`, `invariants.test.ts`, `purity.test.ts` | **229 pass, 0 fail, 0 skipped**. |
| E3 | `CAP_PROBE`, `PUSH_PROBE`, matrix cancel trong reconciliation, `EXACT_CAP_DOUBLE_UNKNOWN` | Các counterexample cũ đã được chặn. Hai unknown liên tiếp reconcile hai lần rồi kết thúc. |
| E4 | Mutation bằng loader và source overlay của purity checker | Bỏ bound guard: 4 test đỏ. Bỏ unknown-push reconciliation: 10 test đỏ. Bỏ import closure: 11 test đỏ. |
| E5 | Export `generate()` và `replaySteps()` trong RAM; duyệt seed 1–600 | Có 14 timer khi request pending. Có 13 expiry khi verify decision. Hai approval kind đều có content-valid `verified:false`. |
| E6 | `scanCore()` với các purity probe v4 | Alias, comment, global escape, dynamic import, test-support, reflected constructor, encoded path, query và hidden `.mjs` đều bị bắt. |
| E7 | `PR_WRONG_HEAD_PROBE`; mở rộng generator qua seed 601–10000 | Remote HEAD sai vẫn được handoff hoặc cancel như publication thành công. Oracle hiện tại vẫn xanh. |
| E8 | Mutation thêm `toLocaleString()`; mutation đảo thứ tự outcome/release trong REPAIR | Cả hai mutation giữ **229/229 test xanh**. |

Lần dùng strip-only ban đầu không nạp được parameter property của purity suite.
Lần chạy E2 dùng transform-types và nạp đủ ba suite.
Không ghi nhận V8 crash trong các lượt tập trung trên.

### Disposition finding cũ

| ID | trạng thái | file:line | test chứng minh | ghi chú |
|---|---|---|---|---|
| P3-S2R-HIGH-001 | RESOLVED | `budget.ts:55`; `task-core.ts:411`; `task-core.ts:427` | `decide.test.ts:273`; `decide.test.ts:291`; E3, E4 | Cap bằng `MAX_USD` không còn che overrun. Bỏ `usageOutOfBound` khỏi guard làm 4 test đỏ. |
| P3-S2R-HIGH-002 | PARTIAL | `task-core.ts:709`; `task-core.ts:754`; `sequential-interpreter.ts:126` | `decide.test.ts:1593`; `decide.test.ts:1648`; E3, E7 | Retryability không còn suy ra `none`. Tuy nhiên reconciliation sau PR failure bỏ qua HEAD sai. |
| P3-S2R-MED-001 | RESOLVED | `purity.test.ts:94`; `purity.test.ts:113`; `purity.test.ts:257` | `purity.test.ts:382`; E6 | Reflected constructor cũ bị bắt. Bỏ kiểm identifier `Reflect` làm seed tương ứng đỏ: 228 pass, 1 fail. |
| P3-S2R-MED-002 | RESOLVED | `purity.test.ts:228`; `purity.test.ts:296` | `purity.test.ts:366`; `purity.test.ts:367`; `purity.test.ts:369`; E4, E6 | Compiler resolution phải đưa target vào closure. Bỏ closure check làm 11 test đỏ. |
| P3-S2-HIGH-003 | PARTIAL | `task-core.ts:716`; `task-core.ts:763`; `task-core.ts:783` | `decide.test.ts:1658`; `decide.test.ts:1683`; E7 | PR failure hoặc read failure đã giữ `publication-incomplete` thắng cancel. PR tồn tại ở HEAD sai vẫn bị coi thành công. |
| P3-S2-MED-001 | RESOLVED | `budget.ts:21`; `budget.ts:55`; `task-core.ts:411` | `decide.test.ts:230`; `decide.test.ts:273`; `decide.test.ts:291`; E3, E4 | Sub-micro overrun và boundary cạnh bound được giữ. Bỏ phần fix ngoài bound làm regression tests đỏ. |
| P3-S2-MED-002 | RESOLVED với các evasions đã nêu | `purity.test.ts:205`; `purity.test.ts:228`; `purity.test.ts:247` | `purity.test.ts:357`; `purity.test.ts:378`; E4, E6 | Các probe v3/v4 đều bị bắt. Lỗ hổng ambient-locale mới được tách thành finding bên dưới. |

### Effect, cancellation và giới hạn

Core không còn suy ra `none` từ retryability (`task-core.ts:709`).
`PublicationEffect` giới hạn `none` vào pre-call proof hoặc remote absence (`types.ts:387`).
Failure thiếu effect được interpreter chuyển thành `unknown` (`sequential-interpreter.ts:126`).

Adapter cung cấp proof thực tế vẫn thuộc S6 sau rebase (`phase-03-plan.md:620`).
Review S2 chưa chứng minh adapter tuân thủ điều kiện đó.

Unknown luôn phát `reconcilePublication` trên các nhánh failure đã kiểm (`task-core.ts:712`; `task-core.ts:717`).
Reconcile là request không cancellable (`activity-options.ts:77`).
Pause và pending cancel không giữ lại request này (`task-core.ts:263`).

E3 gửi cancel ngay trong reconciliation.
Read failure ở cả push và PR đều cho `FAILED / publication-incomplete`, kèm branch audit.

E3 cũng chạy attempt cuối với cost và wall-clock đúng toàn bộ cap.
Hai unknown liên tiếp vẫn reconcile đủ hai lần rồi handoff.
Core không có vòng lặp reconciliation vô hạn trên đường này (`task-core.ts:754`).

Seal giữ run mở khi child còn chạy (`run-core.ts:259`).
Probe `SEALED_CHILD_PENDING` xác nhận seal không kết thúc child đang pending.
Drain-paused đã được mô tả đúng tại `phase-03-exit-criteria.md:593`.

Overrun bị chặn trước verification và publication (`task-core.ts:588`; `task-core.ts:603`).
`CAP_PROBE` với usage `100000001` hiện chỉ inspect và ghi incident.
Usage bằng `100000000` vẫn được phép đi tiếp, theo E3.

Tuy nhiên remote read chưa luôn được đánh giá đúng.
Sau push confirmed, core chỉ kiểm `prNumber !== null` (`task-core.ts:763`).
Đây là blocker của reconciliation hiện tại.

### Finding mới

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P3-S2V5-HIGH-001 | HIGH | `task-core.ts:763`; `types.ts:377`; `invariants.test.ts:583` | Sau PR-upsert failure, remote HEAD khác commit attempt nhưng có PR vẫn được handoff. `PR_WRONG_HEAD_PROBE` trả `WAITING_FOR_HUMAN_REVIEW`, PR 9, không incident. Có cancel thì trả `CANCELLED` như publication đã reconcile. | Kiểm HEAD bằng commit attempt trên cả hai nhánh reconciliation. HEAD sai hoặc mất phải thành `FAILED / publication-incomplete` với branch audit. Thêm direct tests và oracle kiểm identity của PR/HEAD. |
| P3-S2V5-HIGH-002 | HIGH | `task-core.ts:859`; `task-core.ts:883`; `task-core.ts:1202`; `RC:341` | Abandon, exhaustion và close còn emit `releaseLease` trước `recordAttemptOutcome`. Khi gắn helper fenced của R23, terminal write sẽ chạy sau khi mất lease. Đây là lệch contract mới, không phải regression do đổi thứ tự trong các commit v5. | Emit terminal outcome trước release trên mọi đường có lease. Khóa riêng protocol cho registered attempt chưa acquire được lease. Thêm oracle thứ tự theo attempt và test helper từ chối write sau release. |
| P3-S2V5-MED-001 | MEDIUM | `purity.test.ts:94`; `purity.test.ts:247`; `purity.test.ts:344` | Detector bỏ lọt API phụ thuộc locale và ambient host. `(1234.5).toLocaleString()` và `navigator.hardwareConcurrency` đều được scan sạch trong E6. Mutation locale giữ 229 test xanh. | Thêm guard và seed cho ambient locale/host reads. Giữ clean controls trên production core. Ghi giới hạn còn lại của detector rõ ràng. |
| P3-S2V5-LOW-001 | LOW | `index.ts:19`; `RC:106` | Commit đổi export đã xóa tên `usageMicroUsd`. Đây không phải append-only theo chữ nghĩa R10. | Giữ export tương thích bằng wrapper an toàn. Không khôi phục behavior clamp che overrun. Thêm export mới theo dạng additive. |

E7 mở rộng generator thêm 9.400 seed.
Cả bốn oracle hiện tại đều pass.
Seed 1351 vẫn handoff PR 11 khi remote HEAD là `ffffffffffffffffffffffffffffffffffffffff`.

Generator đã tạo được phản ví dụ.
Oracle bỏ qua nó vì nhánh kiểm publication chỉ chạy khi `prNumber === null` (`invariants.test.ts:583`).
Oracle effect chỉ kiểm request reconcile được phát, chưa kiểm kết quả reconcile (`invariants.test.ts:645`).

### Mutation không bị bắt

**Mutation 1: thêm ambient locale read vào production core.**

```ts
export const reviewLocale = (1234.5).toLocaleString();
```

Driver thêm dòng này vào `task-core.ts` trong RAM.
Purity checker đọc cùng source đã mutate.
Kết quả E8 là **229 pass, 0 fail**.

Test lẽ ra phải bắt là production determinism check (`purity.test.ts:344`).
Các lệnh đã chạy chứng minh cùng expression cho kết quả khác nhau:

```sh
LC_ALL=en_US.UTF-8 node --input-type=module --eval 'console.log((1234.5).toLocaleString(), "ä".localeCompare("z"))'
LC_ALL=de_DE.UTF-8 node --input-type=module --eval 'console.log((1234.5).toLocaleString(), "ä".localeCompare("z"))'
LC_ALL=sv_SE.UTF-8 node --input-type=module --eval 'console.log((1234.5).toLocaleString(), "ä".localeCompare("z"))'
```

Kết quả lần lượt là `1,234.5 -1`, `1.234,5 -1` và `1 234,5 1`.

**Mutation 2: release trước outcome trên REPAIR.**

Tại `task-core.ts:945`, driver chèn:

```ts
releaseLease(step, a);
```

Dòng được chèn trước `endAttempt(step, a, 'repair-requested')`.
Kết quả E8 vẫn là **229 pass, 0 fail**.

Test REPAIR hiện tại lẽ ra phải bắt thứ tự này (`decide.test.ts:628`).
Property cũng phải kiểm outcome trước release.
Hiện property chủ yếu kiểm số lượng outcome và resource disposal (`invariants.test.ts:389`; `invariants.test.ts:552`).

Không phải mọi oracle đều sao chép implementation.
Money oracle tự tính micro-USD tại `invariants.test.ts:75`.
Approval oracle có predicate nội dung riêng tại `invariants.test.ts:725`.

Hai mutation approval cũ vẫn bị bắt.
Bỏ expiry guard làm **5 test đỏ**.
Bỏ verified guard làm **3 test đỏ**, theo E4.

Generator hiện có content-valid unconfirmed decisions cho cả hai kind.
E5 thấy budget-extension ở seed 589.
E5 thấy publish-change ở seed 148 và 535.
Coverage marker kiểm validity theo kind tại `invariants.test.ts:797`.

### Ranh giới và giới hạn xác minh

Lệnh `git diff --name-status 7694b8b..HEAD` chỉ liệt kê docs và `packages/orchestration/`.

Lệnh sau trả diff rỗng:

```sh
git diff --numstat 7694b8b..HEAD -- tsconfig.json scripts/lib/canonical-tests.mjs pnpm-lock.yaml
```

Production external import hiện chỉ là contracts type-only (`types.ts:14`).
Các runtime imports còn lại nằm trong package, theo production purity check E2.
Domain runtime import nằm trong test (`decide.test.ts:15`).

Lệnh `rg -n '@temporalio' packages/orchestration` không có match.

Expanded deny set không tạo false positive trên production core hiện tại.
Production scan và clean controls đều pass trong E2 (`purity.test.ts:344`; `purity.test.ts:437`).

Không chạy `verify:all`.
Script này xóa build outputs tại `scripts/verify-all.sh:72`.
Con số 777 của lane chưa được xác minh trong lượt này.
Cold build và integration cũng chưa được xác minh.

## Kết luận

Chưa nhận S2 tại snapshot này vì hai blocker HIGH (`task-core.ts:763`; `task-core.ts:1202`).

Các probe v4 đã được sửa thực chất, theo E3 và E6.
Plan vẫn phải đồng bộ R23 và predicate reconciliation mới.

Sửa HEAD validation, terminalization order và các regression tests trước lượt kiểm exact SHA tiếp theo.
Giữ G-P2/G-LB cho phần tích hợp (`phase-03-plan.md:589`; `phase-03-plan.md:592`).

`git status --porcelain=v1` cuối lượt vẫn rỗng.
Không file nào bị sửa.
