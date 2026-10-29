<!--
Provenance: independent, read-only Codex re-audit of the Phase 3 plan v4 and of the S2 fixes.
Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, run by the controller on 2026-10-29 as a single
uninterrupted run of the Codex CLI 0.165.0. The gateway appends its own style instructions and tools to every
request (reconciliation R16), so the review holds "via this gateway".
Reviewed snapshot: `7694b8b` (branch phase/03-durable-orchestration, plan LOCKED v4).
Controller gate at `7694b8b`, on a clean detached worktree: `pnpm verify:all` three runs in a row, each exit 0,
731 pass, 0 fail, 0 skipped; 53 test files, 31 required suites; no V8 crash.
Copied verbatim from the controller's review output. Two mechanical changes only: host paths are replaced by
`<controller-lanes>/` (the controller's lane directory) and `<npx-cache>/` (the reviewer's npx cache), so no host
path enters the public tree, and a final newline is added.
Adjudication of every finding: `phase-03-review-log.md`, section "Review v4".
-->

VERDICT: REQUEST_CHANGES  confidence 0.98

## Phần 1 — Plan v4

Snapshot đã kiểm là `7694b8ba8c639f1b060775f8f06c596aab014113`. Lệnh `git rev-parse HEAD` xác nhận SHA này.

Các tên `phase-03-*.md` dưới đây thuộc `docs/implementation/phases/`. Các tên source S2 thuộc `packages/orchestration/src/`.

`reconciliation-v1.md` là `<controller-lanes>/reconciliation-v1.md`. Tài liệu này thắng plan theo dòng 5.

### Disposition của finding v3

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P3-PLAN3-HIGH-001 | FOLDED | `phase-03-architecture.md:610`; `phase-03-exit-criteria.md:410` | Never-replaceable failure thắng exhaustion. Overrun vẫn phải được ghi nhận. |
| P3-PLAN3-HIGH-002 | FOLDED | `phase-03-architecture.md:274`; `phase-03-data-model.md:395`; `phase-03-exit-criteria.md:211` | Plan có seal, fixed task list và carried sealed flag. Run rỗng sau seal đóng dưới `maxTasks`. |
| P3-PLAN3-MED-001 | FOLDED | `phase-03-architecture.md:624`; `phase-03-exit-criteria.md:425` | Wall-clock vượt cap cộng kill grace thuộc overrun. H11 có các boundary bắt buộc. |
| P3-PLAN3-MED-002 | FOLDED | `phase-03-data-model.md:405`; `phase-03-architecture.md:706`; `phase-03-exit-criteria.md:462` | Canonical decision mang `extensionUsd`. S7 sở hữu mapping và boundary test. |
| P3-PLAN3-MED-003 | FOLDED | `phase-03-exit-criteria.md:406`; `phase-03-architecture.md:651`; `phase-03-architecture.md:656` | H8 có ngoại lệ hết attempts và failure precedence. Disabled/unset đã thành một switch. Risk/threat còn lệch như finding mới bên dưới. |

Finding kế thừa `P3-PLAN-HIGH-004` vẫn **PARTIAL theo thiết kế**. CR-10 còn chờ verbatim hand-off tại `phase-03-plan.md:884`.

G-LB vẫn chặn S0 tại `phase-03-plan.md:580`. Việc chờ này phù hợp R18 tại `reconciliation-v1.md:206`.

### Đối chiếu R1–R21

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| R1 | Phù hợp ở plan | `phase-03-plan.md:721`; `phase-03-plan.md:738` | Plan rút fencing riêng. Reopen phải reconcile remote trước. Implementation phụ thuộc Phase 2 sau rebase. |
| R2 | Phù hợp ở plan | `phase-03-plan.md:723`; `phase-03-plan.md:733` | Plan rút `resultRef?: unknown`. Plan yêu cầu result binding đóng và DB-coherent. |
| R3 | Phù hợp có điều kiện | `phase-03-architecture.md:743`; `phase-03-architecture.md:780`; `phase-03-plan.md:886` | Placement, outcome và repair lineage đúng. Verbatim contract chưa được bàn giao; S0 chưa được phép vượt gate. |
| R4 | Phù hợp ở plan | `phase-03-data-model.md:291`; `phase-03-data-model.md:310`; `phase-03-exit-criteria.md:64` | Composite key, scoped FK, conflict-by-bytes và append-only có acceptance criteria. |
| R5 | Phù hợp ở plan | `phase-03-plan.md:688` | Plan giữ một superset bump `run-event` lên `1.2.0`. |
| R6 | Phù hợp ở plan | `phase-03-plan.md:670`; `phase-03-data-model.md:355` | Lane A giữ task status. Lane B giữ attempt status và CHECK riêng. |
| R7 | Phù hợp trong phạm vi Lane A | `phase-03-plan.md:675`; `phase-03-plan.md:684` | Lane A cộng ba schema của mình. Plan không chốt tổng schema liên lane. Implementation Lane B chưa được kiểm tại đây. |
| R8 | Đúng phân kỳ; detector còn thiếu | `phase-03-plan.md:585`; `phase-03-plan.md:609`; `purity.test.ts:102` | S2 giữ check cục bộ. Shared rule chờ S7. Check cục bộ còn hai bypass được chứng minh dưới đây. |
| R9 | Phù hợp ở plan | `phase-03-plan.md:1036` | Temporal và Grafana thuộc các section riêng. Plan yêu cầu union khi merge. |
| R10 | Phù hợp trong diff đã kiểm | `phase-03-plan.md:955`; `phase-03-plan.md:1066`; `phase-03-plan.md:1089` | Ownership composition roots rõ. Diff registry từ v3 rỗng theo lệnh kiểm bên dưới. |
| R11 | Phù hợp ở plan | `phase-03-plan.md:1139` | ADR `0017` thuộc Lane A. |
| R12 | Không thấy lệch trong phạm vi Phase 3 | `phase-03-architecture.md:365`; `reconciliation-v1.md:114` | Replay corpus Phase 3 lấy từ các run S8/S10/S11. Private bundle và corpus benchmark Lane B chưa được xác minh. |
| R13 | Phù hợp placement; chưa xác minh Lane B | `phase-03-architecture.md:745`; `reconciliation-v1.md:124` | Assurance wrapper chạy phía harness. Credential rotation và zero-request gateway stop chưa có evidence trong phạm vi S2. |
| R14 | Phù hợp phần Lane A | `phase-03-exit-criteria.md:145`; `phase-03-plan.md:614` | PostgreSQL restart smoke là pre-deployment gate. D5–D7 của Lane B chưa được kiểm tại đây. |
| R15 | Phù hợp trong diff đã kiểm | `phase-03-plan.md:581`; `phase-03-data-model.md:318`; `phase-03-architecture.md:758` | Chỉ S2 có code mới trước G-P2. Operational FK và fixed logical time vẫn được giữ. |
| R16 | Phù hợp ở plan | `phase-03-plan.md:880`; `phase-03-review-codex-v3.md:5` | Slot chuyển vào application. Provenance review ghi giới hạn “via this gateway”. |
| R17 | PARTIAL | `phase-03-architecture.md:596`; `task-core.ts:700`; `phase-03-architecture.md:556` | Reserve và lineage phù hợp. Nhánh push non-retryable vẫn cho cancellation kết thúc khi remote chưa được xác định. |
| R18 | Phù hợp gate | `phase-03-plan.md:886`; `phase-03-exit-criteria.md:46`; `phase-03-exit-criteria.md:69` | Hand-off chưa có. S0 phải tiếp tục chờ fixed block và conformance kit. |
| R19 | Phù hợp trong S2 | `task-core.ts:782`; `task-core.ts:858`; `defaults.ts:54` | Chỉ task cap được extension. Assurance infrastructure failure đi PROCEED/ESCALATE. Extension bound mặc định unset. |
| R20 | Code phù hợp; tài liệu PARTIAL | `task-core.ts:575`; `phase-03-exit-criteria.md:406`; `phase-03-risk-register.md:27` | Core và H8 đúng precedence. Risk/threat vẫn mô tả task luôn `BUDGET_EXHAUSTED` sau overrun. |
| R21 | PARTIAL | `budget.ts:50`; `task-core.ts:700`; `purity.test.ts:102`; `purity.test.ts:143` | Seal, pause, registration và hai mutation approval đã được xử lý. Money boundary, publication ambiguity và purity gate còn lỗi. |

### Finding mới của plan

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P3-PLAN4-HIGH-001 | CẦN SỬA | `phase-03-architecture.md:325`; `phase-03-architecture.md:336`; `phase-03-plan.md:332`; `phase-03-exit-criteria.md:376` | Plan đồng nhất non-retryable với “chắc chắn chưa push”. Chính error mapping lại chứa fencing error sau external effect. Điều này mâu thuẫn publication invariant tại `phase-03-architecture.md:556` và R21 tại `reconciliation-v1.md:292`. Phải tách retryability khỏi remote-effect certainty. |
| P3-PLAN4-HIGH-002 | CẦN SỬA | `phase-03-architecture.md:635`; `phase-03-architecture.md:638`; `phase-03-architecture.md:642`; `phase-03-review-log.md:947` | Plan cho cap bằng `MAX_USD`, đồng thời clamp usage vào chính bound này. Khẳng định “overrun either way” sai tại cap cực đại. Phải giữ overrun detection độc lập với saturation của ledger. |
| P3-PLAN4-MED-001 | CẦN SỬA | `phase-03-risk-register.md:27`; `phase-03-threat-model-delta.md:62`; `phase-03-exit-criteria.md:410` | PR3-16 và T3-13 vẫn kết luận task luôn `BUDGET_EXHAUSTED` sau overrun. H8 đã có hai ngoại lệ R20. Phải đồng bộ risk/threat với bảng outcome đã sửa. |

Seal không tự gỡ pause. Run đã seal nhưng còn queue vẫn chờ resume tại `run-core.ts:287`.

Test hiện tại yêu cầu hành vi này tại `decide.test.ts:1683`. Đây không phải vi phạm điều kiện “không còn task mở” của R21.

Drain procedure cần nêu rõ điều kiện chờ này. Các bước hiện tại chỉ seal rồi chờ tại `phase-03-architecture.md:391`.

## Phần 2 — S2 sau sửa

### Evidence chạy độc lập

Các lượt chạy dùng `node --disable-warning=ExperimentalWarning --input-type=module --eval` với driver trong bộ nhớ.

Driver dùng `registerHooks` để đọc source `.ts`. Driver không ghi file hoặc dùng worktree sống.

Driver ánh xạ `@asep/domain` vào source của snapshot. Driver ánh xạ `.js` tương đối sang `.ts` hiện hữu.

Purity suite dùng TypeScript `7.0.2` tại `<npx-cache>/node_modules/typescript/`.

| Evidence | Lệnh hoặc probe đã chạy | Kết quả |
|---|---|---|
| E1 | `git rev-parse HEAD`; `git status --porcelain=v1`; `git diff --check 5e9fb84..HEAD` | HEAD đúng SHA yêu cầu. Status rỗng trước và sau review. Diff check exit 0. |
| E2 | Driver Node nạp `decide.test.ts`, `invariants.test.ts`, `purity.test.ts` | **183 pass, 0 fail, 0 skipped**. |
| E3 | Driver Node chạy `CAP_PROBE`, `PUSH_PROBE`, `V3_WALL_PROBE` qua `runTaskSequentially()` | Hai probe đầu tái hiện lỗi mới. Probe wall-clock v3 đã bị chặn. |
| E4 | Driver mutation thay source lúc load và lúc purity đọc source | Bỏ expiry guard gây 5 test đỏ. Bỏ verified guard gây 3 test đỏ. Hai mutation purity mới vẫn giữ 183 test xanh. |
| E5 | Driver export `generate()` và `replaySteps()` trong bộ nhớ; duyệt seed 1–600 | Có 14 timer khi request pending. Có 13 approval expiry trong lúc verify decision. |
| E6 | Driver gọi `scanSources()` và `import.meta.resolve()` | Detector bắt các probe v3 cơ bản. Detector bỏ lọt reflective constructor và một số relative targets. |

### Disposition của finding S2 v3

| ID v3 | trạng thái | file:line | test chứng minh | ghi chú |
|---|---|---|---|---|
| P3-S2-HIGH-001 | RESOLVED | `task-core.ts:575` | `decide.test.ts:1149`; `decide.test.ts:1217` | Failure precedence chạy trước exhaustion. Bỏ guard ưu tiên này làm 9 test core/property đỏ trong mutation run. |
| P3-S2-HIGH-002 | RESOLVED trong S2 | `task-core.ts:797`; `defaults.ts:34`; `validation.ts:23` | `decide.test.ts:1262`; `decide.test.ts:1271`; `decide.test.ts:1286` | Ba class bị chặn tuyệt đối dù policy hostile. Bỏ hard deny làm 10 test đỏ. Loader thực tế vẫn thuộc S6 tại `phase-03-plan.md:608`. |
| P3-S2-HIGH-003 | PARTIAL | `task-core.ts:645`; `task-core.ts:700`; `task-core.ts:732` | `decide.test.ts:1480`; `decide.test.ts:1489`; `decide.test.ts:1494` | Successful/ambiguous push rồi PR failure đã kết thúc `publication-incomplete`. Non-retryable push vẫn bị coi là definitely-no-effect. E3 tái hiện cancellation che publication chưa reconcile. |
| P3-S2-HIGH-004 | RESOLVED | `run-core.ts:146`; `run-core.ts:223`; `run-core.ts:265`; `run-core.ts:279` | `decide.test.ts:1621`; `decide.test.ts:1632`; `decide.test.ts:1652`; `decide.test.ts:1665` | Seal đóng run dưới cap và tồn tại qua continue-as-new. Bỏ điều kiện hoàn tất theo seal làm 6 test đỏ. |
| P3-S2-HIGH-005 | RESOLVED | `task-core.ts:413` | `decide.test.ts:1191`; `decide.test.ts:1201`; `decide.test.ts:1217` | Boundary cap, cap cộng grace và vượt grace đều có test. Bỏ wall-clock overrun làm 6 test đỏ. Probe 34 phút/cap 30 phút hiện chỉ inspect, ghi `240000` ms overrun và không publish. |
| P3-S2-MED-001 | PARTIAL | `budget.ts:21`; `budget.ts:50`; `task-core.ts:416` | `decide.test.ts:225`; `decide.test.ts:247` | Probe `5.0000004` đã được chặn. Clamp mới làm mất overrun khi cap bằng `MAX_USD`. E3 tái hiện full publication trên input hợp lệ. |
| P3-S2-MED-002 | PARTIAL | `purity.test.ts:102`; `purity.test.ts:143`; `purity.test.ts:205` | `purity.test.ts:229`; `purity.test.ts:239`; E4; E6 | AST bắt lại probe v3 cơ bản. Reflective constructor và runtime module ngoài tập quét vẫn qua gate. |
| P3-S2-MED-003 | RESOLVED | `task-core.ts:378`; `task-core.ts:974`; `task-core.ts:1077`; `task-core.ts:1090` | `decide.test.ts:919`; `decide.test.ts:934`; `decide.test.ts:945`; `decide.test.ts:983` | Idle approval wait project `PAUSED` và khởi động timer. Bỏ lời gọi áp pause tại handler làm 9 test đỏ. |
| P3-S2-MED-004 | RESOLVED | `sequential-interpreter.ts:112`; `invariants.test.ts:229`; `invariants.test.ts:242`; `invariants.test.ts:613` | `decide.test.ts:1010`; `decide.test.ts:1021`; `decide.test.ts:1033`; E4; E5 | Timer thật sự xuất hiện trước result. Hai mutation v3 hiện gây lần lượt 5 và 3 test đỏ. |
| P3-S2-MED-005 | RESOLVED | `task-core.ts:536`; `task-core.ts:668`; `task-core.ts:1150`; `activity-options.ts:60` | `decide.test.ts:441`; `decide.test.ts:449`; `decide.test.ts:460`; `decide.test.ts:469` | Found, absent và unknown registration có hành vi riêng. Bỏ registered filter làm 3 test đỏ. Attempt chưa reconcile không nhận usage/outcome. |

### Finding mới

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P3-S2R-HIGH-001 | HIGH | `budget.ts:50`; `task-core.ts:407`; `task-core.ts:416`; `decide.test.ts:247` | Usage bị clamp trước khi tính overrun. Với cap `100000000`, usage `100000001` trở thành usage bằng cap. E3 nhận `inputErrors:[]`, không có overrun, rồi verify/commit/push/PR thành công. | Tách phát hiện vượt cap khỏi accounting saturation. Usage ngoài bound phải giữ tín hiệu overrun hoặc fail closed. Thêm test cap bằng `MAX_USD`, usage vượt cap và boundary micro-USD gần bound. |
| P3-S2R-HIGH-002 | HIGH | `task-core.ts:700`; `task-core.ts:1143`; `types.ts:386`; `invariants.test.ts:527` | `nonRetryable` chỉ mô tả retry policy. Core lại dùng nó làm bằng chứng remote chưa đổi. E3 mô phỏng push đã tới remote rồi lỗi non-retryable. Kết quả là `CANCELLED`, `prNumber:null`, không upsert và không publication audit. | Mang trạng thái reconciliation riêng: confirmed, known-no-effect hoặc unknown. Không suy ra known-no-effect từ retryability. Unknown phải reconcile trước; thất bại phải báo `FAILED / publication-incomplete` với branch audit. Sửa oracle đang miễn trừ mọi non-retryable failure. |
| P3-S2R-MED-001 | MEDIUM | `purity.test.ts:64`; `purity.test.ts:143`; `purity.test.ts:229` | Detector chỉ nhận banned names trong các AST pattern đã liệt kê. `Reflect.get(() => {}, "constructor")("return Date.now()")()` gọi Function constructor và đọc clock mà không bị bắt. Mutation E4 giữ 183 test xanh. | Chặn hoặc kiểm soát đường reflective constructor. Thêm seeded violation cho constructor gián tiếp và computed/reflected access tương đương. |
| P3-S2R-MED-002 | MEDIUM | `purity.test.ts:102`; `purity.test.ts:135`; `purity.test.ts:182`; `purity.test.ts:205` | Detector normalize chuỗi specifier nhưng không chứng minh target thuộc tập được quét. Relative `.mjs` được phép trong khi scanner chỉ lấy `.ts`. Encoded/query targets cũng lọt. Mutation import module `.mjs` chứa `Date.now()` giữ 183 test xanh. | Resolve target theo quy tắc runtime/build. Yêu cầu mỗi runtime target thuộc closure được kiểm tra. Reject extension hoặc URL form chưa hỗ trợ. Thêm seed cho encoded path, query, nested test-support và module ngoài tập quét. |

**Chi tiết HIGH-001.** E3 dùng reserve bằng 0 và các money cap bằng `MAX_USD`.

`taskInputErrors()` trả `[]`. Kết quả là `WAITING_FOR_HUMAN_REVIEW`, `chargedCostUsd:100000000`, `prNumber:7`.

Không có `recordOverrun`. Trace chứa cả verification, commit, assurance, push và PR upsert.

Test hiện tại chỉ thử huge usage trên cap mặc định 5 tại `decide.test.ts:247`. Generator chỉ tạo attempt cap nhỏ tại `invariants.test.ts:84`.

**Chi tiết HIGH-002.** Counterexample có cơ sở từ thứ tự effect hiện hữu.

`pushStep` gọi `forge.pushBranch()` trước `log.complete()` tại `packages/application/src/pipeline-steps.ts:645`.

`log.complete()` có thể ném fencing error tại `adapters/persistence/src/side-effect-log.ts:177`.

Plan map fencing error sang non-retryable tại `phase-03-architecture.md:325`. Vì vậy non-retryable không chứng minh push chưa xảy ra.

Test hiện tại ghi thẳng giả định sai tại `decide.test.ts:1509`. Property oracle lặp lại giả định tại `invariants.test.ts:527`.

### Lựa chọn của lane

| Lựa chọn | Đánh giá | Evidence |
|---|---|---|
| PR upsert hết retry policy kết thúc `FAILED / publication-incomplete` | **Hợp lý.** Kết quả bị chặn an toàn và branch được nêu để reconcile thủ công. Lane đã công khai phần diễn giải mở rộng R21. | `task-core.ts:732`; `phase-03-review-log.md:927`; `reconciliation-v1.md:292` |
| `MAX_USD = 100_000_000` | **Chấp nhận được làm input bound.** Mười attempts với agent và reserve cùng bound chỉ đạt `2 × 10^15` micro-USD. Clamp trước overrun detection thì sai. | `budget.ts:12`; `phase-03-architecture.md:638`; P3-S2R-HIGH-001 |
| Kill grace mặc định 0 | **Đúng với snapshot.** Adapter gọi SIGKILL ngay tại timeout. Sau Phase 2 rebase phải đối chiếu lại stop-to-kill interval. | `defaults.ts:55`; `adapters/agent-claude/src/claude-provider.ts:229`; `phase-03-plan.md:608` |
| Đổi hook sang `eventsDuring(request, activeTimers)` | **Đúng.** Hook cho timer chạy trước result của request đang pending. E5 xác nhận generator thực sự dùng khả năng này. | `sequential-interpreter.ts:41`; `sequential-interpreter.ts:112`; `invariants.test.ts:242` |
| Import `typescript/unstable/*` từ dependency root | **Chấp nhận được cho test.** Đây là dependency hiện hữu. Lockfile pin phiên bản; API instability đã được ghi thành risk. | `purity.test.ts:36`; `package.json:30`; `pnpm-lock.yaml:27`; `phase-03-risk-register.md:53` |
| Ba projection pause edges chờ S1 | **Đúng phân kỳ R15.** S2 dùng bảng cục bộ. S1 được giao cập nhật domain và test tương ứng. | `projection.ts:23`; `phase-03-data-model.md:348`; `phase-03-plan.md:603`; `reconciliation-v1.md:144` |

Kill grace khác engine start-to-close grace. Engine timeout còn phần cộng riêng tại `activity-options.ts:126`.

Việc hai giá trị khác nhau không tự tạo business tolerance. Overrun detector chỉ dùng `agentKillGraceSeconds` tại `task-core.ts:414`.

### Sức mạnh generator và detector

Generator đã sửa đúng điểm yếu chính của v3. E5 đo được 14 timer khi request pending trên 600 seed.

Trong đó, 13 timer là approval expiry khi đang verify decision. Code phát timer nằm tại `invariants.test.ts:242`.

Coverage cho unverified decision vẫn mỏng:

| Seed | Kết quả verifier | Đánh giá |
|---|---|---|
| 418 | `verified:false`, budget-extension approve, `extensionUsd:2` | Nội dung hợp lệ. Probe E5 xác nhận case này trước expiry. |
| 535 | `verified:false`, publish-change approve, `extensionUsd:4` | Nội dung không hợp lệ vì publish-change phải mang null. Quy tắc nằm tại `approvals.ts:33`. |

Marker `unconfirmed-approve` không kiểm amount tại `invariants.test.ts:691`. Vì vậy marker này chưa chứng minh coverage hợp lệ cho từng approval kind.

Direct tests vẫn bảo vệ cả hai kind tại `decide.test.ts:1021`. Điều này đủ làm mutation bỏ verified guard đỏ.

| Probe purity đã thử | Kết quả | Evidence |
|---|---|---|
| Alias `const m = Math; m.random()` | Bị bắt. | E6; `purity.test.ts:259` |
| Computed `Math["random"]()` | Bị bắt. | E6; `purity.test.ts:260` |
| Escaped identifier của `Date` | Bị bắt. | E6; `purity.test.ts:164` |
| Re-export có comment từ `node:fs` | Bị bắt. | E6; `purity.test.ts:244` |
| `globalThis["Date"].now()` | Bị bắt. | E6; `purity.test.ts:64`; `purity.test.ts:160` |
| Dynamic import | Bị bắt. | E6; `purity.test.ts:152` |
| Relative import trực tiếp vào test-support | Bị bắt. | E6; `purity.test.ts:250` |
| Reflective Function constructor | Bị bỏ lọt. | E4; P3-S2R-MED-001 |
| `./%74est-support/fixtures.ts` | Bị bỏ lọt dù Node resolve vào excluded directory. | E6; `purity.test.ts:102` |
| `./decide.test.ts?cache` | Bị bỏ lọt. | E6; `purity.test.ts:106` |
| Relative `.mjs` chứa clock | Bị bỏ lọt và module không thuộc tập quét. | E4; `purity.test.ts:211` |

Encoded/query probes chứng minh lỗ hổng detector. Review này không dùng chúng để khẳng định cold TypeScript build sẽ chấp nhận.

### Mutation không bị bắt

Mutation thứ nhất nối đoạn sau vào `task-core.ts` trong bộ nhớ:

```ts
const escapedClock = Reflect.get(() => {}, "constructor")("return Date.now()")();
```

Driver cho purity suite đọc cùng source đã mutate. Toàn bộ **183 test vẫn xanh**, theo E4.

Test phải bắt mutation này là `every core source file parses and is deterministic...` tại `purity.test.ts:229`.

Mutation thứ hai thêm runtime import vào core:

```ts
import "./purity-hidden.mjs";
```

Module được driver cung cấp trong bộ nhớ có nội dung:

```js
export const hiddenClock = Date.now();
```

Toàn bộ **183 test vẫn xanh**, theo E4. Scanner bỏ module này vì chỉ thu thập `.ts` tại `purity.test.ts:211`.

Test tại `purity.test.ts:229` phải kiểm cả runtime dependency closure. Check hiện tại chỉ kiểm các source tự thu thập.

Hai mutation v3 đã được thử lại độc lập:

| Mutation | Kết quả | Test bắt được |
|---|---|---|
| Bỏ nhánh `ap.expiryFired` tại `task-core.ts:983` | 178 pass, **5 fail** trên 183 test. | Direct expiry/cancel traces tại `decide.test.ts:1010`, `decide.test.ts:1033`; property tại `invariants.test.ts:648`. |
| Bỏ `result.verified` tại `task-core.ts:987` | 180 pass, **3 fail** trên 183 test. | Direct unconfirmed traces tại `decide.test.ts:1021`; property tại `invariants.test.ts:648`. |

### Ranh giới thay đổi

Lệnh `git diff --name-only 5e9fb84..HEAD` chỉ liệt kê docs và `packages/orchestration/`.

Lệnh `git diff --name-only f5fd317^..4d6ce51` chỉ liệt kê `packages/orchestration/`.

Lệnh sau trả diff rỗng:

```sh
git diff --numstat 5e9fb84..HEAD -- tsconfig.json scripts/lib/canonical-tests.mjs pnpm-lock.yaml
```

Production source chỉ có external type import từ contracts tại `types.ts:14`. Các runtime import production hiện hữu là relative imports.

Domain runtime import nằm trong test tại `decide.test.ts:15`. Domain được khai báo devDependency tại `packages/orchestration/package.json:15`.

Lệnh `rg -n '@temporalio' packages/orchestration` trả exit 1 và không có match.

## Kết luận

S2 đã giải quyết bảy finding v3 trong phạm vi core. Ba finding còn **PARTIAL** được nêu trong bảng disposition.

Hai lỗi HIGH vẫn cho phép publication trái invariant. Evidence là `CAP_PROBE` và `PUSH_PROBE` trong E3.

Cần sửa money saturation và remote-effect certainty trước khi nhận S2. Cần bổ sung detector cùng các mutation đã sống sót.

Plan phải sửa các giả định tương ứng. Risk/threat phải đồng bộ ngoại lệ R20 với H8.

Lượt độc lập xác nhận **183/183 test tập trung**, không xác nhận con số 731 của lane.

Tôi không chạy `verify:all` vì script xóa build outputs tại `scripts/verify-all.sh:72`. Review này chưa xác minh cold build hoặc integration.

Các lượt tập trung không tái hiện V8 crash. Evidence hiện tại chưa xác định nguyên nhân crash của gate toàn bộ.

Lệnh `git status --porcelain=v1` cuối cùng vẫn rỗng. Không file nào bị sửa.
