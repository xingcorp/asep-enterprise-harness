<!--
Provenance: independent, read-only Codex lock-check of the Phase 3 plan v2.
Reviewer: Codex `gpt-6.1-sol` via the kiro-proxy gateway, run by the controller on 2026-10-29, with Codex CLI
0.147.0. That CLI version warned that it fell back to default model metadata for `gpt-6.1-sol`; the controller
has since moved to Codex CLI 0.165.0. The gateway appends its own style instructions and tools to every request
(reconciliation R16), so the review holds "via this gateway".
Reviewed snapshot: `98e92cf` (branch phase/03-durable-orchestration, plan LOCKED v2).
Copied verbatim from the controller's review output. Two mechanical changes only: the absolute path of the
controller's lane directory is replaced by `<controller-lanes>/`, so no host path enters the public tree, and a
final newline is added.
Adjudication of every finding: `phase-03-review-log.md`, section "Lock-check v2".
-->

VERDICT: REQUEST_CHANGES  confidence 0.97

| ID lần một | trạng thái | file:line ở HEAD | ghi chú |
|---|---|---|---|
| P3-PLAN-CRIT-001 | FOLDED | `docs/implementation/phases/phase-03-architecture.md:316`; `docs/implementation/phases/phase-03-exit-criteria.md:181`; `docs/implementation/phases/phase-03-plan.md:525` | Thiết kế epoch độc lập đã bị rút. Claim phải kiểm lease trong cùng transaction. E4/E5 chứng minh invariant tại S3/S6; F7 bổ sung zombie test tại S10. |
| P3-PLAN-HIGH-001 | FOLDED | `docs/implementation/phases/phase-03-plan.md:642`; `docs/implementation/phases/phase-03-architecture.md:325`; `docs/implementation/phases/phase-03-exit-criteria.md:216`; `docs/implementation/phases/phase-03-plan.md:528` | `resultRef?: unknown` không còn là contract đề xuất. Phase 3 dùng typed binding của Phase 2. E13/D6 kiểm adoption và convergence sau rebase. |
| P3-PLAN-HIGH-002 | FOLDED | `docs/implementation/phases/phase-03-architecture.md:332`; `docs/implementation/phases/phase-03-exit-criteria.md:216`; `docs/implementation/phases/phase-03-exit-criteria.md:272`; `docs/implementation/phases/phase-03-plan.md:532` | Đã thêm lifecycle `FAILED`, reconcile trước reopen và giữ timeout mơ hồ ở `PENDING`. S6/S10 có table test và ba crash case tương ứng. |
| P3-PLAN-HIGH-003 | FOLDED | `docs/implementation/phases/phase-03-data-model.md:199`; `docs/implementation/phases/phase-03-architecture.md:519`; `docs/implementation/phases/phase-03-exit-criteria.md:278`; `docs/implementation/phases/phase-03-plan.md:531` | Đã thêm transactional outbox, relay và redelivery khi POST được retry. F19/S9 kiểm SIGKILL đúng boundary decision-commit → Update. |
| P3-PLAN-HIGH-004 | PARTIAL | `docs/implementation/phases/phase-03-architecture.md:546`; `docs/implementation/phases/phase-03-exit-criteria.md:358`; `docs/implementation/phases/phase-03-plan.md:801`; `docs/implementation/phases/phase-03-review-log.md:396` | Semantics, repair base và terminal hook đã đổi thật. Tuy nhiên, contract TypeScript, source SHA và byte comparison vẫn pending. Chưa thể xác nhận hai lane có contract nối được. |
| P3-PLAN-HIGH-005 | FOLDED | `docs/implementation/phases/phase-03-plan.md:1046`; `docs/implementation/phases/phase-03-exit-criteria.md:325`; `docs/implementation/phases/phase-03-plan.md:526` | CR-25/S4 đã yêu cầu enforce từng request cap và fail closed khi không hỗ trợ. H9/CX-26 chứng minh adapter; cách core xử lý budget vẫn mâu thuẫn tại finding mới HIGH-001. |
| P3-PLAN-HIGH-006 | FOLDED | `docs/implementation/phases/phase-03-plan.md:1063`; `docs/implementation/phases/phase-03-exit-criteria.md:224`; `docs/implementation/phases/phase-03-exit-criteria.md:303`; `docs/implementation/phases/phase-03-plan.md:533` | Đã thêm per-call signal, composition với constructor signal và reaper. E14/G10 kiểm process group, container và trạng thái cuối tại S4/S11. |
| P3-PLAN-HIGH-007 | FOLDED | `docs/implementation/phases/phase-03-data-model.md:263`; `docs/implementation/phases/phase-03-exit-criteria.md:48`; `docs/implementation/phases/phase-03-plan.md:522` | DDL đã hợp nhất tenant key, payload hash, append-only trigger và scoped run FK. S0/O2/O3 kiểm sink và integrity. Việc Lane B thực sự rút migration chưa được kiểm trên worktree của lane đó. |
| P3-PLAN-HIGH-008 | FOLDED | `docs/implementation/phases/phase-03-plan.md:1079`; `docs/implementation/phases/phase-03-exit-criteria.md:210`; `docs/implementation/phases/phase-03-plan.md:527` | Đã thêm S5 riêng cho adapter thật với HTTP double. E12 kiểm concurrent create, mất response và reconcile `422`; không còn claim live-GitHub uniqueness. |
| P3-PLAN-MED-001 | FOLDED | `docs/implementation/phases/phase-03-architecture.md:436`; `docs/implementation/phases/phase-03-exit-criteria.md:265`; `docs/implementation/phases/phase-03-plan.md:532` | Callback/message boundary đã được định danh. F16/F17/S10 inject tại completion và gRPC transport. Cách đặt SDK test còn xung đột confinement tại MED-004 mới. |
| P3-PLAN-MED-002 | FOLDED | `docs/implementation/phases/phase-03-plan.md:81`; `docs/implementation/phases/phase-03-exit-criteria.md:204`; `docs/implementation/phases/phase-03-plan.md:528` | G8 đã được đánh dấu stale. Deterministic evidence time chỉ còn là hardening tại E10/S6. |
| P3-PLAN-MED-003 | PARTIAL | `docs/implementation/phases/phase-03-architecture.md:675`; `docs/implementation/phases/phase-03-exit-criteria.md:111`; `docs/implementation/phases/phase-03-plan.md:889`; `docs/implementation/phases/phase-03-research-register.md:93` | Loopback, connection guard, principal và history hygiene đã có thay đổi thật. Retention vẫn chưa chốt flag/value và chưa có assertion đọc lại namespace configuration. C1/C7/C8 không chứng minh retention. |
| P3-PLAN-MED-004 | PARTIAL | `docs/implementation/phases/phase-03-architecture.md:281`; `docs/implementation/phases/phase-03-exit-criteria.md:75`; `docs/implementation/phases/phase-03-architecture.md:296`; `docs/implementation/phases/phase-03-plan.md:529` | Manifest, digest và minimum scenarios đã được thêm. Tuy nhiên, gate S7 cần corpus sinh ở slice sau. Thủ tục drain-only còn sai thứ tự. |
| P3-PLAN-MED-005 | FOLDED | `docs/implementation/phases/phase-03-exit-criteria.md:117`; `docs/implementation/phases/phase-03-exit-criteria.md:450`; `docs/implementation/phases/phase-03-plan.md:534` | C9/S12 đã thêm production-shaped smoke trên PostgreSQL với restart thật. N5 cấm claim production readiness khi chưa chạy thành công. |
| P3-PLAN-MED-006 | FOLDED | `docs/implementation/phases/phase-03-data-model.md:404`; `docs/implementation/phases/phase-03-exit-criteria.md:21`; `docs/implementation/phases/phase-03-plan.md:523`; `docs/implementation/phases/phase-03-plan.md:525` | Hai status union và CHECK migration đã tách đúng. Không hard-code tổng schema là tuân thủ R7, không phải bỏ sót yêu cầu cũ. |
| P3-PLAN-MED-007 | FOLDED | `docs/implementation/phases/phase-03-exit-criteria.md:441`; `docs/implementation/phases/phase-03-plan.md:535` | N3 đã yêu cầu zero unresolved CRITICAL/HIGH. Disposition đơn thuần không còn đủ. Controller kiểm tại completion protocol/S13. |
| P3-PLAN-MED-008 | FOLDED | `docs/implementation/phases/phase-03-plan.md:495`; `docs/implementation/phases/phase-03-risk-register.md:47`; `docs/implementation/phases/phase-03-exit-criteria.md:12` | G-P2 đã chuyển thành implementation gate. Các slice dùng fencing/runtime đều nằm sau rebase. Ngoại lệ S2 vẫn cần sửa fitness scope theo MED-001 mới. |
| P3-PLAN-MED-009 | FOLDED | `docs/implementation/phases/phase-03-exit-criteria.md:141`; `docs/implementation/phases/phase-03-exit-criteria.md:154`; `docs/implementation/phases/phase-03-exit-criteria.md:235`; `docs/implementation/phases/phase-03-plan.md:524`; `docs/implementation/phases/phase-03-plan.md:532` | Đã tách agent death → attempt mới khỏi verification death → redelivery cùng activity. D5/D9/D12 và F2/F3 không còn mâu thuẫn cũ. |
| P3-PLAN-LOW-001 | PARTIAL | `docs/implementation/phases/phase-03-research-register.md:79`; `docs/implementation/phases/phase-03-research-register.md:93`; `docs/implementation/phases/phase-03-exit-criteria.md:98`; `docs/implementation/phases/phase-03-exit-criteria.md:434`; `docs/implementation/phases/phase-03-plan.md:530` | Đã ghi observation từ developer host và bổ sung version/digest log tại S8. Tuy nhiên, acceptance contract chưa yêu cầu lưu đầy đủ CI pull/inspect output như finding cũ. |

`FOLDED` chỉ xác nhận thay đổi trong plan, không xác nhận implementation hoặc runtime. Đối chiếu dùng `git diff 80bb76a..98e92cf -- docs/` và các lệnh `git diff --unified=0` theo từng tài liệu.

## Finding mới

### P3-PLAN2-HIGH-001 — S2 chưa có một quy tắc nhất quán cho budget exhaustion

Architecture đưa `cap exceeded` thẳng tới `ATTEMPT_ABANDONED`. CR-25/H9 yêu cầu adapter trả `BUDGET_EXHAUSTED` khi vượt cap. Tuy nhiên, architecture và H5 vẫn yêu cầu chạy mọi mandatory verification khi budget cạn trong agent step. Tài liệu chưa phân biệt rõ các trường hợp này. (`docs/implementation/phases/phase-03-architecture.md:138`; `docs/implementation/phases/phase-03-plan.md:1052`; `docs/implementation/phases/phase-03-exit-criteria.md:320`; `docs/implementation/phases/phase-03-exit-criteria.md:325`)

S2 đang sở hữu reducer và budget arithmetic, nên implementer phải tự chọn nhánh tại đây. (`docs/implementation/phases/phase-03-plan.md:524`)

**Yêu cầu:** Chốt bảng chuyển trạng thái cho `AGENT_DONE`, cap-triggered `BUDGET_EXHAUSTED`, usage overrun và lỗi hạ tầng. Bảng phải nói rõ trường hợp nào vẫn inspect/verify, trường hợp nào abandon và trường hợp nào được tạo attempt mới. Thêm core table test và e2e tương ứng với H5/H9.

### P3-PLAN2-HIGH-002 — `REPAIR` hết budget có hai kết quả bắt buộc khác nhau

Architecture đưa `REPAIR` về `BUDGET_CHECK`. Reservation thất bại có thể mở `budget-extension`; reject/expiry kết thúc bằng `BUDGET_EXHAUSTED`. H3/H4 yêu cầu cùng hành vi. (`docs/implementation/phases/phase-03-architecture.md:131`; `docs/implementation/phases/phase-03-architecture.md:149`; `docs/implementation/phases/phase-03-exit-criteria.md:317`)

J4 lại yêu cầu `REPAIR` không còn budget phải kết thúc ngay bằng `FAILED / repair-capacity-exhausted`. J4 không nêu ngoại lệ khi approvals được bật. (`docs/implementation/phases/phase-03-exit-criteria.md:378`)

**Yêu cầu:** Tách hết `maxAttempts` khỏi thiếu reservation có thể được gia hạn. Chốt một kết quả cho `REPAIR + còn attempt + hết budget + approvals enabled`. Thêm case này vào acceptance của S2 và S11.

### P3-PLAN2-HIGH-003 — Critical section `commit → PR` bao trùm assurance có thể hủy và vòng repair

Cancel semantics vẫn yêu cầu hoàn tất critical section từ commit tới PR trước khi xử lý cancellation. Risk register cũng giữ nguyên phạm vi này. (`docs/implementation/phases/phase-03-architecture.md:456`; `docs/implementation/phases/phase-03-risk-register.md:27`)

V2 đặt assurance sau commit/evidence, đánh dấu activity này cancellable, rồi cho `REPAIR` quay lại vòng attempt. Publication approval cũng nằm trước push. Phạm vi critical section hiện không tương thích với các nhánh mới. (`docs/implementation/phases/phase-03-architecture.md:142`; `docs/implementation/phases/phase-03-architecture.md:149`; `docs/implementation/phases/phase-03-architecture.md:155`; `docs/implementation/phases/phase-03-architecture.md:231`)

**Yêu cầu:** Định nghĩa critical section theo từng thao tác cần reconciliation. Đặt assurance, repair planning và approval wait ngoài phạm vi không thể hủy. Thêm cancel-during-assurance và cancel-during-publication-approval; G7 hiện chỉ kiểm cancellation trong publication. (`docs/implementation/phases/phase-03-exit-criteria.md:296`)

### P3-PLAN2-MED-001 — Fitness acceptance của S2 vẫn phụ thuộc framework Phase 2 chưa được accept

S2 phải giao determinism fitness và đạt B2. B2 trỏ tới shared forbidden-import suite. CR-12 lại yêu cầu dùng AST framework của Phase 2 sau rebase, nhưng vẫn gán ownership cho S2. (`docs/implementation/phases/phase-03-plan.md:524`; `docs/implementation/phases/phase-03-exit-criteria.md:64`; `docs/implementation/phases/phase-03-exit-criteria.md:67`; `docs/implementation/phases/phase-03-plan.md:843`; `docs/implementation/phases/phase-03-plan.md:850`)

R8 yêu cầu fitness rules dùng framework đã được Phase 2 accept. R15 chỉ nêu ngoại lệ append registry cho package S2 trước rebase. (`<controller-lanes>/reconciliation-v1.md:95`; `<controller-lanes>/reconciliation-v1.md:144`)

**Yêu cầu:** Cho S2 một purity self-check nằm trong package và không sửa shared rule framework. Chuyển phần nối vào `scripts/forbidden-imports.test.ts` sang slice sau G-P2. Ghi rõ hai acceptance checkpoint này.

### P3-PLAN2-MED-002 — Purity rule bao gồm cả các test cần runtime imports

B2 áp dụng cho toàn bộ `packages/orchestration/src/**` và chỉ cho phép `import type`. Hai suite bắt buộc của S2 lại nằm trong `src/decide.test.ts` và `src/invariants.test.ts`. (`docs/implementation/phases/phase-03-exit-criteria.md:67`; `docs/implementation/phases/phase-03-plan.md:858`)

Theo pattern hiện có, test dùng runtime imports từ `node:test`, `node:assert/strict` và module đang kiểm. Rule literal hiện tại sẽ cấm chính những test đó. (`packages/domain/src/operational.test.ts:1`)

**Yêu cầu:** Tách production source khỏi test và seeded fixture. Cho phép runtime imports nội bộ thuần giữa các module production nếu cần. Tiếp tục cấm runtime dependency bên ngoài và nguồn nondeterminism. Thêm self-check cho cả import hợp lệ lẫn vi phạm.

### P3-PLAN2-MED-003 — Gate theo từng slice có phụ thuộc ngược chưa được giải quyết

S0 phải đạt O1 với `NotConfiguredAssuranceSlot`, nhưng implementation của default binding được giao cho S6. (`docs/implementation/phases/phase-03-plan.md:522`; `docs/implementation/phases/phase-03-exit-criteria.md:42`; `docs/implementation/phases/phase-03-plan.md:528`)

S7 giao replay suite bắt buộc. Suite phải đỏ khi corpus rỗng hoặc thiếu scenario, nhưng corpus được export từ S8/S10/S11. Mỗi slice vẫn phải chạy `verify:all` trước commit. (`docs/implementation/phases/phase-03-plan.md:529`; `docs/implementation/phases/phase-03-architecture.md:281`; `docs/implementation/phases/phase-03-plan.md:543`)

**Yêu cầu:** Chuyển default binding tối thiểu vào S0, hoặc đổi rõ acceptance của S0. Chốt cách bootstrap replay corpus trước khi bật strict required gate. Không giải quyết bằng skip, corpus rỗng hoặc nới final B5.

### P3-PLAN2-MED-004 — Test callback được đặt ngoài biên Temporal SDK đã khóa

CR-16 thêm trực tiếp `@temporalio/client` vào `workers/temporal-worker` để dùng `AsyncCompletionClient`. B1 và architecture lại cấm mọi import `@temporalio/*` ngoài `adapters/temporal/**`, không có ngoại lệ test. (`docs/implementation/phases/phase-03-plan.md:937`; `docs/implementation/phases/phase-03-exit-criteria.md:64`; `docs/implementation/phases/phase-03-architecture.md:109`)

**Yêu cầu:** Đặt SDK-specific callback injector trong test-support của `adapters/temporal`. Worker chaos suite gọi helper không lộ SDK type. Đồng bộ CR-16, confinement rule và acceptance F16. (`docs/implementation/phases/phase-03-exit-criteria.md:265`)

### P3-PLAN2-MED-005 — Retry của một repair attempt chưa có quy tắc giữ repair context

Nhánh `REPAIR` tạo attempt tại `repairBaseSha` với repair ContextPack. Khi attempt đó gặp lỗi replaceable, nhánh abandonment chuyển attempt tiếp theo thành `kind = retry`. Tài liệu chỉ gắn repair base và ContextPack đặc biệt với repair attempt. (`docs/implementation/phases/phase-03-architecture.md:134`; `docs/implementation/phases/phase-03-architecture.md:149`; `docs/implementation/phases/phase-03-architecture.md:161`; `docs/implementation/phases/phase-03-architecture.md:590`)

S2 chưa có quy tắc rõ cho base, repair order, round và prior adjudication của retry này. Implementer có thể vô tình quay về task base hoặc mất repair context. (`docs/implementation/phases/phase-03-plan.md:524`; `docs/implementation/phases/phase-03-data-model.md:108`)

**Yêu cầu:** Tách attempt kind khỏi effective repair lineage. Thêm trace `REPAIR → agent death → replacement → assurance` và kiểm lineage không bị mất.

### P3-PLAN2-MED-006 — Drain-only dừng worker trước khi workflow được drain

Thủ tục hiện tại yêu cầu dừng old workers rồi chờ không còn open workflow. Trong topology đã mô tả, workflow đang chạy cần worker để thực hiện bước tiếp theo. Dừng toàn bộ old workers không tạo ra việc drain. (`docs/implementation/phases/phase-03-architecture.md:296`; `docs/implementation/phases/phase-03-architecture.md:122`)

**Yêu cầu:** Dừng nhận execution mới trước. Giữ old workers phục vụ tới khi không còn open workflow. Sau đó mới dừng old workers và chạy build mới. Đồng bộ M1 và risk PR3-14. (`docs/implementation/phases/phase-03-exit-criteria.md:424`; `docs/implementation/phases/phase-03-risk-register.md:23`)

### P3-PLAN2-MED-007 — Review log vẫn cho benchmark ghi vào operational `run_events`

Review log vẫn đề xuất tạo `runs` row cho benchmark replay, hoặc xin bỏ FK. R15 đã quyết định cả hai hướng này không còn là lựa chọn: benchmark/replay measurement phải dùng measurement storage hoặc eval artifacts. (`docs/implementation/phases/phase-03-review-log.md:374`; `<controller-lanes>/reconciliation-v1.md:148`)

DDL hiện giữ đúng scoped FK, nhưng log chưa đóng quyết định controller và chưa ghi lệnh cấm measurement ghi operational events. (`docs/implementation/phases/phase-03-data-model.md:283`; `docs/implementation/phases/phase-03-review-log.md:374`)

**Yêu cầu:** Đánh dấu escalation đã được R15 giải quyết. Bỏ hướng tạo operational run giả và bỏ FK. Ghi rõ storage boundary trong design và sink conformance.

## Tuân thủ reconciliation

| Điều khoản | Kết quả đối chiếu |
|---|---|
| R1 | Thiết kế đã rút independent fencing và chuyển sang invariants của Phase 2. F1/F2 kiểm lease trong transaction; S3/S6/S10 nằm sau G-P2. Chưa có implementation để xác nhận runtime. (`docs/implementation/phases/phase-03-plan.md:640`; `docs/implementation/phases/phase-03-plan.md:506`) |
| R2 | Không còn parallel result contract. F4 dùng closed, validated, DB-coherent binding của Phase 2. (`docs/implementation/phases/phase-03-plan.md:652`) |
| R3 | Semantics đã đổi đúng vị trí slot, bốn outcome, repair base và terminal hook. Tuy nhiên, verbatim TypeScript và conformance source vẫn pending. Chưa thể xác nhận tuân thủ đầy đủ. (`docs/implementation/phases/phase-03-architecture.md:556`; `docs/implementation/phases/phase-03-plan.md:801`; `docs/implementation/phases/phase-03-review-log.md:391`) |
| R4 | Unified DDL và shared sink đã được mô tả đúng phía Lane A. S0 sở hữu `0107`; O2/O3 kiểm hash conflict, append-only và tenant FK. (`docs/implementation/phases/phase-03-data-model.md:263`; `docs/implementation/phases/phase-03-exit-criteria.md:48`) |
| R5 | Có một bump `run-event` 1.2.0 dạng superset tại S0. Lane B locked fields vẫn phải được lấy ở hand-off. (`docs/implementation/phases/phase-03-plan.md:607`; `docs/implementation/phases/phase-03-data-model.md:378`) |
| R6 | TaskStatus/`tasks.status` thuộc Lane A; AttemptStatus/`attempts.status` thuộc Lane B. Không còn dự đoán sai constraint chung. (`docs/implementation/phases/phase-03-data-model.md:404`) |
| R7 | Lane A chỉ chốt ba schema mới và không hard-code cross-lane total. D-1 của Lane B không được xác minh trong snapshot này. (`docs/implementation/phases/phase-03-plan.md:603`; `<controller-lanes>/reconciliation-v1.md:86`) |
| R8 | Chưa nhất quán về thời điểm thực hiện. CR-12 yêu cầu framework sau rebase nhưng vẫn giao phần fitness cho S2 trước rebase. MED-001 phải được sửa. (`docs/implementation/phases/phase-03-plan.md:843`; `docs/implementation/phases/phase-03-plan.md:850`) |
| R9 | Phạm vi compose đã tách Temporal của Lane A khỏi Grafana mount của Lane B. (`docs/implementation/phases/phase-03-plan.md:923`) |
| R10 | Registry/export additions được mô tả append-only. `production-root.ts` thuộc Lane A; worker root sẽ import `assurance-root.ts` khi integration. (`docs/implementation/phases/phase-03-plan.md:853`; `docs/implementation/phases/phase-03-plan.md:897`; `docs/implementation/phases/phase-03-plan.md:948`; `docs/implementation/phases/phase-03-plan.md:971`) |
| R11 | ADR 0017 được dành cho Lane A; Lane B dùng 0018 trở lên. (`docs/implementation/phases/phase-03-plan.md:1019`) |
| R12 | Không thấy kế hoạch phục hồi public reachability của pre-rewrite commits. Replay corpus Phase 3 lấy từ các run S8/S10/S11, khác corpus benchmark của Lane B. Việc corpus Lane B dùng excerpt/private bundle chưa được xác minh. (`docs/implementation/phases/phase-03-architecture.md:281`; `<controller-lanes>/reconciliation-v1.md:114`) |
| R13 | Phase 3 đặt assurance trong activity phía harness, không trong agent container. Tuy nhiên, credential injection, rotation và zero-request pre-gateway stop thuộc reviewer implementation của Lane B; chưa được xác minh tại đây. (`docs/implementation/phases/phase-03-architecture.md:558`; `<controller-lanes>/reconciliation-v1.md:122`) |
| R14 | Phần Temporal đã được fold vào C9/S12/N5. Các quyết định D-5/D-6/D-7 của Lane B chưa được kiểm trong snapshot này. (`docs/implementation/phases/phase-03-exit-criteria.md:117`; `docs/implementation/phases/phase-03-plan.md:534`; `docs/implementation/phases/phase-03-exit-criteria.md:450`; `<controller-lanes>/reconciliation-v1.md:132`) |
| R15 | Thứ tự S2 trước rebase và S0 đầu tiên sau rebase đã đúng về ý định. Shared fitness còn lệch như MED-001. Scoped run FK và sink ownership đã đúng. Measurement boundary còn lệch như MED-007. Logical time cố định đã đúng trong design. (`docs/implementation/phases/phase-03-plan.md:510`; `docs/implementation/phases/phase-03-data-model.md:283`; `docs/implementation/phases/phase-03-plan.md:1123`; `docs/implementation/phases/phase-03-architecture.md:571`) |

Dải `0100–0199` hiện có **bảy migration được dùng**: `0100`, `0101`, `0102`, `0104`, `0105`, `0106`, `0107`. `0103` cố ý bỏ trống; không có migration fencing thứ hai. (`docs/implementation/phases/phase-03-data-model.md:28`)

S0 đưa `0107` vào trước; S3 bổ sung sáu migration có số thấp hơn. Migrator hiện duyệt toàn bộ danh sách đã sort và áp dụng ID chưa có, nên không tự động bỏ qua các ID thấp hơn. Registry phải giữ thứ tự tăng dần khi bổ sung S3. (`docs/implementation/phases/phase-03-plan.md:835`; `adapters/persistence/src/migrator.ts:47`; `adapters/persistence/src/migrator.ts:100`)

Acceptance A5 nên kiểm thêm đường nâng cấp thực tế `Phase 2 → S0/0107 → S3/full set`. A5 hiện nêu clean database, reapply và concurrent migrators, nhưng chưa gọi tên đường nâng cấp này. (`docs/implementation/phases/phase-03-exit-criteria.md:28`)

## Riêng S2

**Chưa đủ nhất quán để implement toàn bộ S2 mà không tự quyết business behavior.** Hai xung đột budget tác động trực tiếp reducer. Purity acceptance và vị trí fitness test cũng chưa thể đồng thời thỏa mãn như văn bản hiện tại. (`docs/implementation/phases/phase-03-plan.md:524`; `docs/implementation/phases/phase-03-architecture.md:138`; `docs/implementation/phases/phase-03-exit-criteria.md:320`; `docs/implementation/phases/phase-03-exit-criteria.md:378`; `docs/implementation/phases/phase-03-exit-criteria.md:67`)

- **Phase 2 không cần là runtime dependency của core.** Plan đã cho phép chỉ dùng type có tại base và type local. Tuy nhiên, acceptance fitness hiện kéo S2 về framework Phase 2 chưa accept. (`docs/implementation/phases/phase-03-plan.md:510`; `docs/implementation/phases/phase-03-plan.md:843`)
- **Temporal không cần là dependency của core.** Reducer và sequential interpreter đã tách đúng hướng. Duration/retry policy có thể là dữ liệu local; SDK mapping thuộc adapter. (`docs/implementation/phases/phase-03-architecture.md:122`; `docs/implementation/phases/phase-03-architecture.md:216`; `docs/implementation/phases/phase-03-architecture.md:85`)
- **Không cần chờ Lane B để viết routing thuần cho bốn outcome đã được R3 chốt.** Tuy nhiên, không được đóng băng draft request/response như shared contract. Block cuối cùng vẫn có quyền thay đổi field names. (`<controller-lanes>/reconciliation-v1.md:51`; `docs/implementation/phases/phase-03-architecture.md:553`)
- **Normalization boundary chưa đủ rõ.** Plan chỉ nêu mapping test từ generated workflow input sang type local. Cần bổ sung mapping/conformance cho slot outcome sau hand-off, gồm repair base và adjudication lineage. (`docs/implementation/phases/phase-03-plan.md:511`; `docs/implementation/phases/phase-03-plan.md:821`; `docs/implementation/phases/phase-03-plan.md:1143`)

Có thể tiếp tục phần không phụ thuộc các quyết định đang mâu thuẫn: package scaffold, arithmetic thuần và các transition đã rõ. Không nên khóa expected results cho budget exhaustion, repair-budget failure hoặc cancellation quanh assurance trước khi adjudicate các finding tương ứng. (`docs/implementation/phases/phase-03-plan.md:524`; `docs/implementation/phases/phase-03-architecture.md:131`; `docs/implementation/phases/phase-03-architecture.md:456`)

Trước khi accept S2, cần thêm các trace sau vào core acceptance:
1. Cap exhaustion đối chiếu H5/H9. (`docs/implementation/phases/phase-03-exit-criteria.md:320`; `docs/implementation/phases/phase-03-exit-criteria.md:325`)
2. `REPAIR` thiếu reservation khi approvals được bật. (`docs/implementation/phases/phase-03-architecture.md:149`; `docs/implementation/phases/phase-03-exit-criteria.md:378`)
3. `REPAIR → agent death → replacement` giữ effective base và repair context. (`docs/implementation/phases/phase-03-architecture.md:161`; `docs/implementation/phases/phase-03-architecture.md:590`)
4. Cancel trong assurance và publication approval, không chỉ trong push/PR. (`docs/implementation/phases/phase-03-architecture.md:155`; `docs/implementation/phases/phase-03-architecture.md:231`; `docs/implementation/phases/phase-03-exit-criteria.md:296`)

Đánh giá này chỉ áp dụng plan tại snapshot. Lệnh `git ls-tree HEAD packages/orchestration adapters/temporal workers/temporal-worker` không trả entry; không có mã S2 đang triển khai song song để kiểm trong snapshot này.

## Kết luận

Không xác nhận LOCK toàn phần. Các finding cũ đã tạo thay đổi thực chất, nhưng contract slot vẫn pending và các mâu thuẫn mới ảnh hưởng trực tiếp S2. Freeze gate hiện đánh dấu zero unresolved CRITICAL/HIGH trong khi CR-10 chưa hoàn tất. (`docs/implementation/phases/phase-03-review-log.md:403`; `docs/implementation/phases/phase-03-review-log.md:410`)

Báo cáo “accept cả 19” cũng cần diễn đạt chính xác: log ghi **18 ACCEPTED, một PARTIALLY_ACCEPTED, không có rejection**. Partial của MED-006 là hợp lý vì R7 thắng yêu cầu hard-code tổng schema. (`docs/implementation/phases/phase-03-review-log.md:21`; `docs/implementation/phases/phase-03-review-log.md:278`)

Ưu tiên sửa HIGH-001/HIGH-002 và MED-001/MED-002 trước khi chốt behavior hoặc acceptance của S2. Giữ G-P2/G-LB cho các slice phụ thuộc shared contract như plan đã yêu cầu. (`docs/implementation/phases/phase-03-plan.md:506`; `docs/implementation/phases/phase-03-plan.md:509`)

Đã kiểm đúng HEAD `98e92cf328cdcea4b7a44bc528ab166c2dd794ca` bằng `git rev-parse HEAD`. `git status --porcelain=v1` trả rỗng. `git diff --check 80bb76a..98e92cf -- docs/` thành công. Không sửa file và không chạy runtime suite.
