<!--
Provenance: independent, read-only Codex plan review of the Phase 3 plan.
Reviewer: Codex `gpt-5.6-sol` via the kiro-proxy gateway, run by the controller on 2026-10-29.
Reviewed HEAD: `80bb76a` (branch phase/03-durable-orchestration).
Copied verbatim from the controller's review output. One mechanical redaction: the absolute path of the
Lane B worktree is replaced by `<lane-b-worktree>/`, so no host path enters the public tree.
Adjudication of every finding: `phase-03-review-log.md`.
-->

VERDICT: REQUEST_CHANGES confidence 0.98

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P3-PLAN-CRIT-001 | CRITICAL | `docs/implementation/phases/phase-03-plan.md:489-502`; `docs/implementation/phases/phase-03-architecture.md:246-274` | `AttemptFence.claim()` chỉ tăng epoch theo attempt.<br>Claim không xác minh lease vẫn `ACTIVE` và thuộc `leaseId` hiện tại.<br>Zombie đã mất lease có thể claim epoch mới và giành lại quyền side effect. | Chốt contract fenced takeover của Phase 2 trước S3.<br>Claim phải kiểm lease owner, trạng thái và lease epoch trong cùng transaction.<br>Thêm race test chứng minh lease cũ không thể claim hoặc hoàn tất. |
| P3-PLAN-HIGH-001 | HIGH | `docs/implementation/phases/phase-03-plan.md:514-531` | CR-05 vẫn dùng `resultRef?: unknown`.<br>Thiết kế này giữ nguyên JSONB tự do đang bị HIGH-005 của Phase 2 phản đối. | Dùng typed result binding đã được Phase 2 accept.<br>Ràng buộc operation, external identity và DB foreign key trong schema.<br>Không định nghĩa contract song song tại Phase 3. |
| P3-PLAN-HIGH-002 | HIGH | `docs/implementation/phases/phase-03-architecture.md:246-257` | Protocol chỉ định takeover cho `PENDING` epoch thấp.<br>`FAILED` chỉ được mô tả khi epoch cao hơn.<br>`FAILED` epoch thấp hoặc bằng chưa có quy tắc reopen hay reconciliation.<br>Transport có thể đã thành công trước khi record thành `FAILED`. | Định nghĩa state machine đầy đủ cho `FAILED`.<br>Luôn reconcile remote bằng natural key trước reopen.<br>Thêm crash tests cho external-success trước `fail`, sau `fail`, và retry sau timeout mơ hồ. |
| P3-PLAN-HIGH-003 | HIGH | `docs/implementation/phases/phase-03-architecture.md:362-371`; `docs/implementation/phases/phase-03-data-model.md:179-183`; `docs/implementation/phases/phase-03-exit-criteria.md:220-224` | API insert decision trước rồi mới gửi Temporal Update.<br>Crash sau insert nhưng trước Update có thể làm workflow chờ mãi.<br>Retry giống hệt chỉ được yêu cầu trả receipt cũ.<br>Plan không yêu cầu retry phải phát lại Update. | Dùng transactional outbox hoặc luôn redeliver Update idempotently khi decision đã tồn tại.<br>Thêm SIGKILL API-process tại đúng boundary này.<br>Khởi động lại API và chứng minh workflow tiếp tục một lần. |
| P3-PLAN-HIGH-004 | HIGH | `docs/implementation/phases/phase-03-plan.md:700-756`; `docs/implementation/phases/phase-03-architecture.md:380-404`; `<lane-b-worktree>/docs/implementation/phases/phase-04-plan.md:525-597` | Slot Phase 3 không khớp Phase 4.<br>Hai lane khác trigger, input, context, outcome và repair base.<br>Phase 3 không có `recordAttemptOutcome` hoặc `admitWithAssurance`.<br>Hai contract không thể nối bằng adapter cơ học. | Reconcile một contract trước S1.<br>Giữ Phase 3 sở hữu composition và activity wrapper.<br>Giữ Phase 4 framework-free và không import Temporal.<br>Chốt vị trí slot, bốn outcome, repair base và terminal hooks. |
| P3-PLAN-HIGH-005 | HIGH | `docs/implementation/phases/phase-03-architecture.md:328-349`; `adapters/agent-claude/src/claude-provider.ts:93-105`; `adapters/agent-claude/src/claude-provider.ts:131-160`; `adapters/agent-claude/src/claude-provider.ts:206-211` | Plan nói provider enforce budget attempt.<br>Adapter hiện dùng `cfg.maxTurns`, không dùng `req.budget.maxTurns`.<br>Adapter không enforce `maxToolCalls` hoặc `maxCostUsd`.<br>Chỉ `maxWallClockMinutes` được enforce từ request. | Chờ adapter Phase 2 được sửa rồi dùng contract đó.<br>Enforce từng cap trước và trong agent execution.<br>Thêm test stream vượt turns, tool calls, cost và wall-clock.<br>Mọi cap không hỗ trợ phải fail closed. |
| P3-PLAN-HIGH-006 | HIGH | `adapters/command-runner/src/command-runner.ts:32-39`; `adapters/command-runner/src/command-runner.ts:96-105`; `packages/ports/src/index.ts:281-283`; `docs/implementation/phases/phase-03-exit-criteria.md:181-190` | Runner hỗ trợ `AbortSignal` qua constructor.<br>`CommandRunner.run()` không mang signal theo call.<br>Exit criteria chỉ chứng minh cancel giữa agent và publication.<br>Không có test cancel giữa verification. | Thread activity cancellation tới runner và Docker process một cách tường minh.<br>Thêm real-Temporal cancel-mid-verification test.<br>Khẳng định process group chết, container được reap, và không còn verification chạy. |
| P3-PLAN-HIGH-007 | HIGH | `docs/implementation/phases/phase-03-data-model.md:214-230`; `<lane-b-worktree>/docs/implementation/phases/phase-04-data-model.md:254-273`; `<lane-b-worktree>/docs/implementation/phases/phase-04-plan.md:612-634` | Phase 3 tạo `run_events` tại `0107`.<br>Phase 4 tạo lại bảng tại `0201` với DDL khác.<br>Hai thiết kế khác primary key, hash payload và append-only trigger. | Cho Phase 3 sở hữu `0107_run_events`.<br>Hợp nhất composite tenant key, payload hash và append-only trigger.<br>Dùng chung `RunEventSink` và conflict-by-bytes.<br>Phase 4 phải rút `0201_run_events`. |
| P3-PLAN-HIGH-008 | HIGH | `docs/implementation/phases/phase-03-plan.md:325-331`; `docs/implementation/phases/phase-03-exit-criteria.md:155-157`; `adapters/github-app/src/forge-provider.ts:282-345` | Exactly-one PR chỉ được chứng minh bằng `DurableLocalForge` tự enforce uniqueness.<br>Adapter GitHub thật dùng find-then-create không atomic.<br>Concurrent create hoặc create-success-response-lost chưa có contract proof. | Thêm concurrent upsert contract test cho adapter thật bằng HTTP double trung thực.<br>Test `422` hoặc conflict rồi reconcile bằng head branch.<br>Không tuyên bố live GitHub uniqueness khi chưa có evidence. |
| P3-PLAN-MED-001 | MEDIUM | `docs/implementation/90-day-plan.md:24-31`; `docs/implementation/phases/phase-03-plan.md:121-122`; `docs/implementation/phases/phase-03-plan.md:352-355` | Scope yêu cầu duplicate-callback chaos test.<br>Plan thay nó bằng duplicate API starts, controls và decisions.<br>Không có boundary nào được định danh là callback thật. | Định nghĩa chính xác callback được kiểm.<br>Inject cùng callback hai lần tại transport boundary đó.<br>Nếu ý nghĩa là duplicate message, đổi tên criterion để tránh claim rộng. |
| P3-PLAN-MED-002 | MEDIUM | `docs/implementation/phases/phase-03-plan.md:63`; `adapters/persistence/src/evidence-store.ts:101-153`; `adapters/persistence/src/evidence-store.ts:175-230`; `adapters/persistence/src/evidence-store.test.ts:189-212` | G8 đã stale tại HEAD.<br>Evidence store hiện adopt orphan bằng identity-gated reconciliation.<br>Test đã pin việc giữ durable bytes và timestamp ban đầu. | Bỏ G8 khỏi danh sách blocker hiện tại.<br>Giữ deterministic workflow time như hardening mới.<br>Không mô tả nó là residual wedge của HEAD. |
| P3-PLAN-MED-003 | MEDIUM | `docs/implementation/phases/phase-03-threat-model-delta.md:29-30`; `docs/implementation/phases/phase-03-threat-model-delta.md:44-48`; `docs/implementation/phases/phase-03-threat-model-delta.md:61-63`; `docs/implementation/phases/phase-03-plan.md:317-323`; `docs/implementation/phases/phase-03-data-model.md:275-282` | Threat model nói gate bind `127.0.0.1`.<br>Gate command lại dùng `--ip 0.0.0.0`.<br>Worker cũng cần kết nối frontend, không chỉ control plane.<br>Control history chứa principal và reason, không hoàn toàn refs-only.<br>Namespace auth, codec và retention chưa có acceptance test. | Test host port chỉ bind loopback.<br>Refuse plaintext non-loopback ngoài môi trường test.<br>Định nghĩa credential cho API và worker.<br>Định nghĩa redaction, retention và codec trigger cho history metadata. |
| P3-PLAN-MED-004 | MEDIUM | `docs/implementation/phases/phase-03-exit-criteria.md:47-53`; `docs/implementation/phases/phase-03-plan.md:145`; `docs/implementation/phases/phase-03-architecture.md:235-239` | Replay gate có thể xanh với corpus rỗng hoặc chỉ chứa happy path.<br>Worker deployment versioning lại bị hoãn. | Thêm manifest với scenario, source SHA, digest và minimum count.<br>Bắt buộc histories cho kill, retry, approval, pause và continue-as-new.<br>Nếu chưa có Worker Versioning, quy định deployment drain-only. |
| P3-PLAN-MED-005 | MEDIUM | `docs/implementation/phases/phase-03-plan.md:144`; `docs/implementation/phases/phase-03-research-register.md:77-92`; `docs/implementation/phases/phase-03-risk-register.md:34` | Gate dùng real Temporal nhưng persistence là SQLite.<br>Production Temporal với PostgreSQL không được exercise.<br>Plan đã thừa nhận khoảng cách này. | Giữ gate hiện tại cho Phase 3.<br>Thêm smoke gate production-shaped trước deployment.<br>Gate đó phải chạy Temporal server với PostgreSQL và restart thật.<br>Report không được tuyên bố production-ready trước gate này. |
| P3-PLAN-MED-006 | MEDIUM | `docs/implementation/phases/phase-03-plan.md:437-463`; `<lane-b-worktree>/docs/implementation/phases/phase-04-plan.md:620-636` | Phase 3 dự đoán Lane B đổi `TaskStatus`.<br>Phase 4 thực tế đổi `AttemptStatus`.<br>Phase 3 tính contract count từ 13 lên 16.<br>Hai lane cộng lại tạo 19 schema files. | Sửa reconciliation text theo hai status union độc lập.<br>Tạo migration riêng cho `tasks.status` và `attempts.status`.<br>Cập nhật compat gate và count tổng thành 19 sau merge. |
| P3-PLAN-MED-007 | MEDIUM | `docs/implementation/phases/phase-03-exit-criteria.md:286-292` | N3 cho phép unresolved CRITICAL/HIGH nếu chỉ có “recorded disposition”.<br>Điều kiện này cho phép gate xanh dù blocker chưa được sửa. | Yêu cầu zero unresolved CRITICAL/HIGH.<br>Chỉ cho phép disposition `fixed`, `not-applicable` với evidence, hoặc user-accepted risk rõ ràng. |
| P3-PLAN-MED-008 | MEDIUM | `docs/implementation/phases/phase-03-risk-register.md:38-42`; `docs/implementation/phases/phase-03-plan.md:397-404` | Phase 2 acceptance chỉ chặn merge.<br>S3 vẫn thay fencing và result persistence trước khi Phase 2 contract ổn định.<br>S5 và S9 phụ thuộc trực tiếp vào các semantics đó. | Chặn S3, S5 và S9 tới khi Phase 2 được accept.<br>Rebase rồi reconcile fence, result binding và agent runtime.<br>Không thay test handoff trước controller approval. |
| P3-PLAN-MED-009 | MEDIUM | `docs/implementation/phases/phase-03-exit-criteria.md:95-109`; `docs/implementation/phases/phase-03-exit-criteria.md:152-154` | D5 đặt `runAgent maximumAttempts: 1` và yêu cầu attempt mới.<br>D9 lại nói killed activity được reschedule.<br>F2 áp dụng wording này cho mid-agent kill. | Tách criterion cho agent và activity retryable.<br>Agent death phải tạo attempt mới.<br>Verification death có thể redeliver cùng activity nếu side effects hội tụ. |
| P3-PLAN-LOW-001 | LOW | `docs/implementation/phases/phase-03-plan.md:69`; `docs/implementation/phases/phase-03-plan.md:790-817`; `docs/implementation/phases/phase-03-research-register.md:70-79` | Claim về tag không tồn tại và digest server chưa xác minh được trong sandbox.<br>Lệnh `docker image inspect temporalio/temporal@sha256:…` trả `permission denied while trying to connect to the docker API`. | Xác minh bằng CI có mạng và Docker.<br>Ghi output pull, inspect, version và digest vào artifact.<br>Giữ trạng thái “không xác minh được” đến khi có evidence đó. |

## Xung đột với Phase 4 và cách giải

Review-loop slot lệch ở tám điểm.

- Phase 3 gọi slot tại `VERIFICATION_FAILED` và `READY_FOR_REVIEW` (`phase-03-plan.md:703-730`).
- Phase 4 chỉ yêu cầu slot sau evidence và trước push (`phase-04-plan.md:592-597`).
- Phase 3 dùng `ReviewLoopPort.evaluate()` (`phase-03-plan.md:742-745`).
- Phase 4 cung cấp `runAssuranceRound()` và các step functions (`phase-04-plan.md:566-581`).
- Phase 3 thiếu `model`, `declaredComplete` và `priorAdjudicationId` (`phase-03-plan.md:705-733`; `phase-04-plan.md:541-555`).
- Phase 3 context thiếu `now()` và dùng heartbeat object (`phase-03-plan.md:465-484`; `phase-04-plan.md:533-539`).
- Phase 3 outcome là `NOT_REQUIRED/APPROVED/REPAIR_REQUIRED/ESCALATE_TO_HUMAN/REJECTED` (`phase-03-plan.md:735-740`).
- Phase 4 outcome là `PROCEED/REPAIR/ESCALATE/BLOCK` (`phase-04-plan.md:557-564`).
- Phase 3 dựng repair từ task `baseSha` rồi apply diff (`phase-03-architecture.md:395-401`).
- Phase 4 yêu cầu workspace tại `repairBaseSha` và `buildRepairContextPack()` (`phase-04-plan.md:588-595`).
- Phase 3 thiếu terminal hook `recordAttemptOutcome()` (`phase-04-plan.md:583-585`).
- Phase 3 thiếu admission hook `admitWithAssurance()` (`phase-04-plan.md:587-595`).

Cách giải là Lane A định nghĩa một slot trùng semantic Phase 4 trước S1. Lane A vẫn sở hữu workflow composition (`lane-contract.md:40-44`). Lane B vẫn không import Temporal (`lane-contract.md:35-42`).

`VERIFICATION_FAILED` không nên gọi assurance round. Lane A phải gọi `recordAttemptOutcome()` tại verification stop (`phase-04-plan.md:583-595`). Assurance round chỉ chạy sau evidence và trước push (`phase-04-plan.md:592-597`).

CR-01 đang dự đoán sai thay đổi của Lane B. Lane A đổi `TaskStatus` (`phase-03-plan.md:437-449`). Lane B đổi `AttemptStatus` (`phase-04-plan.md:626-636`). Hai constraint phải được migrate riêng.

CR-02 và SR-C1…SR-C4 phải dùng một contract registry sau merge. Phase 3 thêm ba schema (`phase-03-plan.md:451-457`). Phase 4 thêm ba schema mới và nâng hai schema major (`phase-04-plan.md:620-627`). Count tổng phải là 19 schema files.

CR-03 và SR-C5 cùng yêu cầu `run-event` 1.2.0 (`phase-03-plan.md:459-463`; `phase-04-plan.md:624`). Controller phải tạo một schema 1.2.0 chứa superset hai lane.

CR-04 và CR-10 phải khớp `AssuranceStepContext`. Adapter activity có thể chuyển `ActivityExecutionContext` sang context framework-free (`phase-03-plan.md:465-487`; `phase-04-plan.md:533-539`).

CR-11 xung đột trực tiếp SR-M2. Phase 3 phải sở hữu `0107_run_events` theo dải `0100–0199` (`phase-03-data-model.md:22-35`; `lane-contract.md:63-64`). Phase 4 chỉ thêm assurance tables trong `0200–0299`.

CR-12 và SR-X4 cùng sửa `scripts/forbidden-imports.test.ts` (`phase-03-plan.md:763-769`; `phase-04-plan.md:680-682`). Controller phải hợp nhất rules trong một commit reconciliation.

CR-13 và CR-14 cùng chạm canonical suite lists và integration scripts (`phase-03-plan.md:771-812`; `lane-contract.md:48-60`). Controller phải hợp nhất marker lists trước implementation.

CR-17, CR-20 và CR-21 cùng chạm composition roots và index exports (`phase-03-plan.md:834-841`; `phase-03-plan.md:854-875`). Phase 4 cũng yêu cầu shared exports (`phase-04-plan.md:680-682`). Mỗi file phải có một owner tại thời điểm merge.

CR-23 yêu cầu ADR 0017 (`phase-03-plan.md:886-889`). Phase 4 §17 không khai ADR mới (`phase-04-plan.md:601-640`). Chưa có xung đột số ADR thực tế.

CR-24 và SR-P1…SR-P4 đều thêm ports vào cùng `index.ts` (`phase-03-plan.md:891-896`; `phase-04-plan.md:607-614`). Controller phải hợp nhất export và signature trong S1.

## Phụ thuộc vào phần sửa Phase 2

HIGH-006 của Phase 2 phải chốt trước S3. Phase 3 đang tự thay wedge test bằng epoch takeover (`phase-03-plan.md:544-548`). Contract mới phải dùng lease-bound fencing, không chỉ attempt epoch.

HIGH-005 của Phase 2 phải chốt trước CR-05. Phase 3 không được giữ `resultRef?: unknown` (`phase-03-plan.md:514-531`). Typed result binding phải được dùng nguyên trạng sau rebase.

HIGH-008 của Phase 2 phải chốt trước budget và recovery tests. Adapter hiện không enforce turns, tool calls và cost từ request (`claude-provider.ts:131-160`; `claude-provider.ts:206-211`). Phase 3 không thể dùng adapter này làm evidence budget đầy đủ.

G8 không còn là dependency chưa sửa. Orphan evidence adoption đã tồn tại và có test tại HEAD (`evidence-store.ts:101-153`; `evidence-store.test.ts:189-212`). Phase 3 chỉ cần giữ regression coverage.

G10 vẫn là suspected issue. Code chỉ chứng minh SIGKILL Docker client (`claude-provider.ts:225-235`). Việc container tiếp tục sống chưa được xác minh.

Risk register hiện chỉ dùng Phase 2 acceptance để chặn merge (`phase-03-risk-register.md:38-42`). Phải chuyển nó thành implementation gate cho S3, S5 và S9.

Sau rebase, controller phải chạy lại unit và integration gate trên exact SHA. N4 cũng yêu cầu rerun trên mọi SHA mới (`phase-03-exit-criteria.md:291-292`).

## Kết luận

Scope Phase 3 phủ đủ Days 31–45. Plan có workflows, controls, heartbeat, retry, idempotency, chaos, budget và approval (`90-day-plan.md:24-31`; `phase-03-plan.md:129-136`).

Giữ fair scheduler ngoài scope là hợp lý. Exit yêu cầu recovery, không yêu cầu throughput fairness (`phase-03-plan.md:140-143`).

Single-host worker pool là đủ cho worker-kill recovery. Multi-host cần host-affinity hoặc shared workspace riêng (`phase-03-plan.md:143`).

Plan đúng khi giữ Temporal làm orchestration authority. PostgreSQL chỉ là projection và fencing truth (`phase-03-data-model.md:13-20`; `docs/architecture/adr/0001-use-temporal-for-long-lived-business-workflows.md:10-16`).

Determinism có hướng đúng. Plan tách pure core, chạy bundler thật và replay histories (`phase-03-plan.md:159-170`; `phase-03-plan.md:308-311`). Replay corpus vẫn cần non-empty manifest theo P3-PLAN-MED-004.

Chaos plan dùng process thật. F2 và F3 yêu cầu SIGKILL mid-agent và mid-verification (`phase-03-exit-criteria.md:147-157`). Temporal omission cũng được thiết kế fail-closed (`phase-03-exit-criteria.md:67-75`).

Approval authorization được thiết kế fail-closed. I2 chặn thiếu capability, agent, service, self-approval và cross-tenant (`phase-03-exit-criteria.md:216-230`). Crash gap DB-to-Update vẫn là blocker.

Budget reservation chạy trước attempt (`phase-03-exit-criteria.md:201-212`). Provider cap hiện chưa đủ để chứng minh budget không bị vượt (`claude-provider.ts:131-160`; `claude-provider.ts:206-211`).

Mỗi slice có commit boundary và acceptance checks rõ (`phase-03-plan.md:391-409`). Thứ tự S3 hiện sai vì chạy trước Phase 2 acceptance (`phase-03-risk-register.md:38-42`).

Current-state G1–G7 đã xác minh từ code tại HEAD (`worktree-manager.ts:60-71,108,142-147,289-292`; `lease-repository.ts:42-44,75-89`; `side-effect-log.ts:174-181`; `vertical-slice-workflow.ts:291-293,525-550`).

G9, G11, G12 và G13 cũng khớp HEAD (`pipeline-steps.ts:914-916`; `packages/ports/src/index.ts:79-86`; `policy-source.ts:12-15`; `pilot-main.ts:273-282`; `cli.ts:87-102`).

G8 đã stale (`evidence-store.ts:101-153,175-230`). G10 vẫn chưa xác minh được ngoài việc Docker client bị kill (`claude-provider.ts:225-235`). G14 chưa xác minh được do sandbox không có Docker socket hoặc mạng.

Các lệnh `git rev-parse HEAD`, `git rev-parse --abbrev-ref HEAD`, `git status --short` và `git diff --name-status 00a6889..HEAD` đã xác minh HEAD, branch, worktree sạch và commit docs-only.

Không chạy `pnpm verify:all` vì review này read-only. Script đó xóa và tạo lại `dist` (`scripts/verify-all.sh:55-79`). Claim baseline test count vì vậy chưa được xác minh độc lập.
