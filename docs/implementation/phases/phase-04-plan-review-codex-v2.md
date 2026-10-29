# Phase 4 — Codex Plan Lock-Check v2 (verbatim)

> Provenance: independent, read-only lock-check of the LOCKED v2 plan by Codex running `gpt-6.1-sol` through the
> kiro-proxy gateway, commissioned by the controller on 2026-10-29. Reviewed branch `phase/04-independent-assurance`
> at snapshot `3201335` (`32013356e0845354f40ac6f63925f928637d6fb3`). Codex CLI 0.147.0 ran the review and warned that
> it had no model metadata for `gpt-6.1-sol` and used fallback metadata; the CLI is now 0.165.0. Copied into the
> repository by the Lane B session from the controller's output file (sha256 of the source file:
> `d18e29e152ddb54e09bd10df93f3e09303a60a103b289bb0f0a35e2bec3e4b5c`). The body below is byte-identical to that file
> except for two edits required by repository gates: (1) the publication path-leak gate
> (`scripts/check-publication.sh` `LEAK_PATTERNS`) — absolute home-directory paths to the controller-owned
> reconciliation file are rewritten to the `~/.openclaw/lanes/reconciliation-v1.md` form; (2) the format gate
> (`scripts/format-check.sh`) — a final newline is added. The review is in Vietnamese, as produced. Line numbers in it
> refer to the documents at `3201335`, not to the v3 documents; `../asep-review-p3-98e92cf/` is the reviewer's
> read-only checkout of Lane A's Phase 3 plan. Dispositions are recorded in `phase-04-review-log.md`.

---

VERDICT: REQUEST_CHANGES confidence 0.97

| ID lần một | trạng thái | file:line ở HEAD | ghi chú |
|---|---|---|---|
| P4-PLAN-CRIT-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:440`; `docs/implementation/phases/phase-04-exit-criteria.md:68`; `docs/implementation/phases/phase-04-plan.md:1376` | Design chuyển kiểm tra egress trước gateway. D1/D2/F2 yêu cầu đúng 0 request. S6/S12/S16 chứng minh thay đổi. |
| P4-PLAN-HIGH-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:605`; `docs/implementation/phases/phase-04-exit-criteria.md:81`; `docs/implementation/phases/phase-04-plan.md:1368` | I1–I5, CR-F1 và E2 quy định takeover thực sự. S8/S12/S16 kiểm owner mới hoàn tất và owner cũ bị fence. |
| P4-PLAN-HIGH-002 | FOLDED | `docs/implementation/phases/phase-04-plan.md:541`; `docs/implementation/phases/phase-04-exit-criteria.md:85`; `docs/implementation/phases/phase-04-plan.md:1364` | Raiser chỉ được claim `FIXED`. Closure cần authority khác. S4/S7/S8/S16 kiểm cả domain, adjudication và DB. |
| P4-PLAN-HIGH-003 | FOLDED | `docs/implementation/phases/phase-04-plan.md:291`; `docs/implementation/phases/phase-04-exit-criteria.md:135`; `docs/implementation/phases/phase-04-plan.md:1379` | Phần được chấp nhận đã đi vào design và S19–S21. Việc hoãn human relabel phù hợp quyết định người dùng. |
| P4-PLAN-HIGH-004 | FOLDED | `docs/implementation/phases/phase-04-plan.md:586`; `docs/implementation/phases/phase-04-exit-criteria.md:127`; `docs/implementation/phases/phase-04-plan.md:1377` | Numerator chuyển sang human disposition authoritative. H6 và S17 kiểm accept rồi reject. Window semantics còn thiếu, nêu tại MED-006 mới. |
| P4-PLAN-HIGH-005 | FOLDED | `docs/implementation/phases/phase-04-plan.md:175`; `docs/implementation/phases/phase-04-exit-criteria.md:48`; `docs/implementation/phases/phase-04-plan.md:1361` | Design dùng năm logical contract mới. Validator v1 được giữ. S1 có fixture, compat và digest checks. |
| P4-PLAN-HIGH-006 | FOLDED | `docs/implementation/phases/phase-04-plan.md:346`; `docs/implementation/phases/phase-04-exit-criteria.md:73`; `docs/implementation/phases/phase-04-plan.md:1380` | Có floors và positive control. Detection bằng 0 thành `INVALID_CONTROL`. Promotion và gating được hoãn đúng scope. |
| P4-PLAN-HIGH-007 | FOLDED | `docs/implementation/phases/phase-04-plan.md:123`; `docs/implementation/phases/phase-04-exit-criteria.md:191`; `docs/implementation/phases/phase-04-plan.md:1382` | S16 được gọi rõ là assurance-only. S22/N1 phụ thuộc real coder của Phase 2. Verdict có qualifier tương ứng. |
| P4-PLAN-HIGH-008 | FOLDED | `docs/implementation/phases/phase-04-architecture.md:274`; `docs/implementation/phases/phase-04-exit-criteria.md:101`; `docs/implementation/phases/phase-04-plan.md:1365` | Packet có execution manifest và raw-output references. S5/S6 kiểm các false-green seed, thay vì chỉ tin verdict. |
| P4-PLAN-MED-001 | PARTIAL | `docs/implementation/phases/phase-04-plan.md:1274`; `docs/implementation/phases/phase-04-exit-criteria.md:177`; `docs/implementation/phases/phase-04-plan.md:1383` | Proof manifest và mutation proofs là thay đổi thật. Tuy nhiên, reporter mới chỉ được giao cho canonical runner, không phủ integration runner. |
| P4-PLAN-MED-002 | FOLDED | `docs/implementation/phases/phase-04-plan.md:597`; `docs/implementation/phases/phase-04-exit-criteria.md:152`; `docs/implementation/phases/phase-04-plan.md:1378` | S18 bắt Grafana thực sự load provisioning và trả snapshot values qua API. Structural JSON check không còn đủ. |
| P4-PLAN-MED-003 | FOLDED | `docs/implementation/phases/phase-04-data-model.md:105`; `docs/implementation/phases/phase-04-data-model.md:575`; `docs/implementation/phases/phase-04-exit-criteria.md:122`; `docs/implementation/phases/phase-04-plan.md:1368` | Có DDL, named constraints, indexes, trigger bodies và rollback SQL. H1/H3 và S8 kiểm trên hai backend. |
| P4-PLAN-MED-004 | FOLDED | `docs/implementation/phases/phase-04-plan.md:464`; `docs/implementation/phases/phase-04-exit-criteria.md:61`; `docs/implementation/phases/phase-04-plan.md:1370` | Credential source được inject tại composition root. Có expiry, rotation, isolation canary và production-path test. |
| P4-PLAN-MED-005 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1372`; `docs/implementation/phases/phase-04-plan.md:1378`; `docs/implementation/phases/phase-04-review-log.md:196` | Các slice cũ đã tách thành steps, slot, drivers, composition, loop test, evaluator và dashboards. Mỗi slice có acceptance riêng. |
| P4-PLAN-LOW-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:161`; `docs/implementation/phases/phase-04-exit-criteria.md:38`; `docs/implementation/phases/phase-04-review-log.md:205` | Plan phân biệt lane-observed baseline với controller verification. Finding này không có slice riêng vì A1 là baseline gate. |

`FOLDED` xác nhận thay đổi trong plan, không xác nhận các test tương lai đã chạy. Tài liệu gọi rõ các test names là planned names. (`docs/implementation/phases/phase-04-exit-criteria.md:32`)

Hai disposition accept một phần có lý do hợp lệ:

- HIGH-003 được thu hẹp theo quyết định descriptive self-history và comparator bắt buộc. Human relabel không cần trở lại thành Phase 4 MUST. Approval bằng commit hoặc log hash là procedural approval, không phải chữ ký mật mã. (`docs/implementation/phases/phase-04-review-log.md:104`; `docs/implementation/phases/phase-04-plan.md:252`; `docs/implementation/phases/phase-04-plan.md:1321`)
- LOW-001 phân biệt đúng lỗi sandbox với trạng thái repository. Tuy nhiên, lane-observed green vẫn không thay thế controller rerun. (`docs/implementation/phases/phase-04-review-log.md:205`; `docs/implementation/phases/phase-04-exit-criteria.md:38`)

## Finding mới

### P4-PLAN2-HIGH-001 — Nhãn pre-S0 chưa tách pure core khỏi contract binding và gate wiring

S5/S6/S7 được đánh dấu pre-S0. Tuy nhiên, contract và reviewer/source ports chỉ xuất hiện ở S1/S2 sau S0. Architecture yêu cầu dùng các contract và ports đó. (`docs/implementation/phases/phase-04-plan.md:1361`; `docs/implementation/phases/phase-04-plan.md:1365`; `docs/implementation/phases/phase-04-architecture.md:84`; `docs/implementation/phases/phase-04-architecture.md:230`)

S20 phải tái sử dụng runtime validation và grounding. DAG lại chỉ ghi `S19 → S20`, không thể hiện phụ thuộc vào S5/S7 hoặc contract binding. (`docs/implementation/phases/phase-04-architecture.md:371`; `docs/implementation/phases/phase-04-architecture.md:385`; `docs/implementation/phases/phase-04-plan.md:1396`)

Build wiring cũng chưa đủ. `evals/tsconfig.json` chỉ include `runner/**` và `schema/**`. File này chưa include hai thư mục review mới. Plan yêu cầu thêm package dependencies nhưng chưa yêu cầu thêm project references tương ứng. (`evals/tsconfig.json:7`; `evals/tsconfig.json:11`; `docs/implementation/phases/phase-04-plan.md:1289`; `scripts/project-references.test.ts:138`)

Pre-S0 chỉ được chạm đường dẫn Lane B-owned. Required-suite registries và package exports lại là shared surfaces, được lên lịch sau S0. (`docs/implementation/phases/phase-04-plan.md:1213`; `docs/implementation/phases/phase-04-plan.md:1271`; `docs/implementation/phases/phase-04-plan.md:1309`; `docs/implementation/phases/phase-04-plan.md:1354`)

**Thay đổi bắt buộc:** Tách từng slice thành pure-core work và integration work. Giao owner rõ cho schemas, local ports, exports, registries và mutation manifest. Bổ sung dependency edges trước khi gọi toàn bộ slice là accepted. (`docs/implementation/phases/phase-04-architecture.md:207`; `docs/implementation/phases/phase-04-plan.md:1354`; `docs/implementation/phases/phase-04-plan.md:1398`)

### P4-PLAN2-HIGH-002 — S19/S20 chưa có packet recipe và scoring protocol đủ cụ thể để freeze

Architecture chỉ gọi tên rule P và rule C. Corpus item chưa ghi cumulative-diff origin hoặc recipe dựng WorkOrder và execution manifest cho historical trees. (`docs/implementation/phases/phase-04-architecture.md:371`; `docs/implementation/phases/phase-04-data-model.md:738`)

Runtime packet cần `taskBaseSha`, `resultSha`, WorkOrder, execution manifest và prior findings. Corpus item hiện chủ yếu chứa reviewed SHA, post-fix SHA, locations và excerpts. Chưa có mapping đầy đủ giữa hai shape. (`docs/implementation/phases/phase-04-data-model.md:60`; `docs/implementation/phases/phase-04-data-model.md:63`; `docs/implementation/phases/phase-04-data-model.md:744`)

Matcher mới nêu path equality, tolerance ±10 và category-table version. Chưa có category table hoặc định nghĩa khác biệt giữa strict và lenient. (`docs/implementation/phases/phase-04-data-model.md:763`; `docs/implementation/phases/phase-04-exit-criteria.md:137`)

Vì vậy, S19 chưa thể freeze packet-dependent eligibility một cách duy nhất. S20 cũng chưa có một protocol duy nhất để scorer hiện thực. (`docs/implementation/phases/phase-04-data-model.md:756`; `docs/implementation/phases/phase-04-data-model.md:759`; `docs/implementation/phases/phase-04-plan.md:1379`)

**Thay đổi bắt buộc:** Khóa recipe P/C/post-fix và matcher trước corpus freeze. Ghi rõ synthetic fields, exclusion rules, matching cardinality và post-fix location mapping. Thêm golden fixtures cho cùng một historical item ở cả hai phía. (`docs/implementation/phases/phase-04-plan.md:337`; `docs/implementation/phases/phase-04-plan.md:343`; `docs/implementation/phases/phase-04-exit-criteria.md:140`)

### P4-PLAN2-MED-001 — Packet step thiếu seam lấy workspace capability

`ReviewSourceReader` yêu cầu `WorkspaceCapability`. `AssuranceSlotInput` và `BuildReviewPacketInput` không chứa workspace identity. Danh sách application-local ports cũng chưa khai báo workspace resolver. (`docs/implementation/phases/phase-04-architecture.md:182`; `docs/implementation/phases/phase-04-plan.md:762`; `docs/implementation/phases/phase-04-plan.md:818`; `docs/implementation/phases/phase-04-architecture.md:207`)

Dữ liệu có thể được tra từ lease vì bảng hiện tại chứa `workspace_id`. Nhưng plan chưa chọn lookup đó hoặc quy định kiểm scope và fence khi resolve. (`adapters/persistence/src/migrations.ts:131`; `adapters/persistence/src/migrations.ts:138`; `docs/implementation/phases/phase-04-plan.md:610`)

**Thay đổi bắt buộc:** Chọn capability trong input hoặc một resolver port framework-free. Nếu dùng resolver, khai báo dependency và test sai tenant, sai lease, sai epoch. Không lấy workspace từ activity-local memory của Lane A. (`docs/implementation/phases/phase-04-plan.md:35`; `docs/implementation/phases/phase-04-architecture.md:256`)

### P4-PLAN2-MED-002 — R15 chưa được fold vào clock contract

R15 yêu cầu một logical time cố định cho mỗi activity execution. Giá trị phải giống nhau trên mọi retry. (`~/.openclaw/lanes/reconciliation-v1.md:152`)

Slot chỉ yêu cầu `now()` trả ISO timestamp và cấm step tự đọc wall clock. Contract chưa yêu cầu logical time cố định. (`docs/implementation/phases/phase-04-plan.md:715`)

Phase 3 đã ghi đúng invariant này. Vì vậy, hai lane đang dựa vào một bảo đảm chỉ có trong companion của Lane A. (`../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-architecture.md:571`; `../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-exit-criteria.md:390`)

**Thay đổi bắt buộc:** Ghi invariant R15 ngay trong block S0. Thêm crash/redelivery test kiểm record bytes và event bytes, không chỉ cached outcome. (`docs/implementation/phases/phase-04-plan.md:1132`; `~/.openclaw/lanes/reconciliation-v1.md:152`)

### P4-PLAN2-MED-003 — Proof gate chưa phủ integration và chưa giải quyết optional live skip

L3 yêu cầu named tests của mọi `unit`/`itest` row xuất hiện dưới trạng thái passed. SR-T3 chỉ thêm JUnit reporter cho canonical runner. Integration runner chưa được giao reporter hoặc proof-check tương ứng. (`docs/implementation/phases/phase-04-exit-criteria.md:177`; `docs/implementation/phases/phase-04-plan.md:1274`; `scripts/integration/run-integration.mjs:166`)

Canonical discovery chỉ nhận hậu tố `.test.ts`. Nó không cung cấp execution evidence cho các `.itest.ts` của integration runner. (`scripts/lib/canonical-tests.mjs:38`; `scripts/lib/canonical-tests.mjs:65`; `scripts/integration/run-integration.mjs:110`)

G8 cho phép live test skip khi thiếu credential. Nếu đó là test-runner skip, L3 lại bắt gate đỏ. Plan chưa chọn cách giải quyết hai yêu cầu này. (`docs/implementation/phases/phase-04-exit-criteria.md:115`; `docs/implementation/phases/phase-04-exit-criteria.md:177`)

**Thay đổi bắt buộc:** Giao proof manifest cho cả hai runner. Tách test kiểm skip policy khỏi live operation tùy chọn. Khi `ASEP_REQUIRE_LIVE_REVIEWER=1`, live operation vẫn phải fail-closed. (`docs/implementation/phases/phase-04-plan.md:473`; `docs/implementation/phases/phase-04-plan.md:1383`)

### P4-PLAN2-MED-004 — Repair helper vi phạm envelope 64 KiB của chính slot

Block S0 giới hạn mọi input/output ở 64 KiB. `RepairContextInput` lại mang toàn bộ `original: ContextPack`. Output cũng mang toàn bộ ContextPack. (`docs/implementation/phases/phase-04-plan.md:667`; `docs/implementation/phases/phase-04-plan.md:1003`)

Schema hiện tại không giới hạn chiều dài `specificationExcerpt`. Kiểm tra bằng `node -e` cho ContextPack dựa trên example đạt 65.853 byte với excerpt 65.536 ký tự. (`packages/contracts/schema/context-pack.schema.json:14`; lệnh `node -e` đã chạy trong lượt review)

**Thay đổi bắt buộc:** Dùng ArtifactRef cho original ContextPack và kết quả lớn. Hoặc khóa size policy cho toàn bộ envelope, kèm lỗi deterministic và boundary tests. (`docs/implementation/phases/phase-04-plan.md:669`; `docs/implementation/phases/phase-04-plan.md:1131`)

### P4-PLAN2-MED-005 — RLC-06 mâu thuẫn với shadow BLOCK

RLC-06 yêu cầu `shadow` khác null khi mode là `shadow`. `BlockOutcome` không có trường `shadow`. (`docs/implementation/phases/phase-04-plan.md:1136`; `docs/implementation/phases/phase-04-plan.md:944`)

DDL chỉ cho `would_be_outcome` khác null khi mode shadow và outcome PROCEED. Như vậy, type, conformance rule và persistence rule chưa đồng nhất. (`docs/implementation/phases/phase-04-data-model.md:469`)

**Thay đổi bắt buộc:** Giới hạn yêu cầu `shadow` cho `PROCEED` trong shadow mode. Thêm conformance case shadow BLOCK để đồng bộ với DDL. (`docs/implementation/phases/phase-04-plan.md:919`; `docs/implementation/phases/phase-04-data-model.md:469`)

### P4-PLAN2-MED-006 — Late disposition chưa có window semantics

Snapshot có `window_start` và `window_end`. Numerator mới đếm disposition events, còn denominator đếm review-completed events. (`docs/implementation/phases/phase-04-data-model.md:503`; `docs/implementation/phases/phase-04-data-model.md:651`)

Plan chưa quy định disposition ngày sau thuộc window của review gốc hay window của disposition. H6 chỉ yêu cầu disposition đến sau round. (`docs/implementation/phases/phase-04-exit-criteria.md:127`)

Nếu lọc hai nguồn theo `occurredAt` trong cùng window, late disposition có thể không sửa snapshot gốc. Đây là khoảng trống thiết kế, chưa phải lỗi runtime được tái hiện. (`packages/contracts/schema/run-event.schema.json:33`; `docs/implementation/phases/phase-04-data-model.md:529`; `docs/implementation/phases/phase-04-data-model.md:651`)

**Thay đổi bắt buộc:** Khóa cohort/window semantics. Thêm test review ngày đầu, accept ngày sau và reject ngày tiếp theo. Kiểm lại cả snapshot lịch sử và snapshot window mới. (`docs/implementation/phases/phase-04-exit-criteria.md:127`; `docs/implementation/phases/phase-04-data-model.md:529`)

### P4-PLAN2-MED-007 — Lane A còn default binding và terminal vocabulary khác block mới

Phase 3 default slot phát attempt events và từ chối risk ngoài R0/R1. Phase 4 disabled slot không phát events và mô tả mọi round trả PROCEED. Phase 4 còn yêu cầu Lane A dùng disabled slot trước integration. (`../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-architecture.md:620`; `docs/implementation/phases/phase-04-plan.md:1075`; `docs/implementation/phases/phase-04-plan.md:1122`)

Phase 3 dùng `verification-failed` và `failed`. Block mới chỉ có `verification-stopped` và các failure terminals cụ thể. (`../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-architecture.md:603`; `docs/implementation/phases/phase-04-plan.md:955`)

**Thay đổi bắt buộc:** Handoff phải cập nhật cả default-binding prose, terminal table và exit J2 của Lane A. Chỉ chép block TypeScript chưa đủ. Hai default slot có thể cùng tồn tại nếu trách nhiệm được phân biệt rõ. (`../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-exit-criteria.md:362`; `../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-plan.md:823`)

### P4-PLAN2-MED-008 — Reconciliation hiện có thêm R16, cần áp dụng trước S3/S20

File controller hiện có R16, không chỉ R1–R15. R16 chọn primary reviewer `gpt-6.1-sol` và xác nhận gateway injection. (`~/.openclaw/lanes/reconciliation-v1.md:156`)

Policy mẫu vẫn pin `gpt-5.6-sol`. Plan, risk register và threat model vẫn gọi gateway injection là chưa xác minh. (`docs/implementation/phases/phase-04-data-model.md:692`; `docs/implementation/phases/phase-04-plan.md:495`; `docs/implementation/phases/phase-04-risk-register.md:38`; `docs/implementation/phases/phase-04-threat-model-delta.md:46`)

Đây là delta controller sau bước lock, không phải bằng chứng implementer bỏ qua R16 trước khi nó tồn tại. Nhưng S3 và preregistration không nên freeze cấu hình cũ. (`~/.openclaw/lanes/reconciliation-v1.md:156`; `docs/implementation/phases/phase-04-data-model.md:763`)

**Thay đổi bắt buộc:** Đồng bộ primary model, config hashes và mô tả injection. Giữ phân biệt labeller cũ với candidate mới. Comparator khác họ vẫn bắt buộc. (`~/.openclaw/lanes/reconciliation-v1.md:162`)

## Tuân thủ reconciliation

Bảng này đánh giá design tại snapshot, không xác nhận runtime implementation. Diff chỉ thay đổi chín tài liệu Phase 4. (Lệnh `git diff --name-only a2a7b8a..3201335`)

| Mục | Kết quả |
|---|---|
| R1 | Phù hợp. Design dùng Phase 2 primitive theo invariant và CR-F1, không tự tạo fencing scheme thứ hai. (`docs/implementation/phases/phase-04-plan.md:605`) |
| R2 | Phù hợp. Reviewer-call result là yêu cầu mở rộng closed shape của primitive, không phải `unknown` result song song. (`docs/implementation/phases/phase-04-plan.md:622`) |
| R3 | Chưa đủ để handoff nguyên trạng. Outcomes, admission và repair semantics đúng. Slot còn các khoảng trống MED-001, MED-004, MED-005 và drift MED-007. (`docs/implementation/phases/phase-04-plan.md:1021`; `docs/implementation/phases/phase-04-plan.md:1144`) |
| R4 | Phù hợp về owner và migration. `0201_run_events` được rút; sink chung nằm trong S0. (`docs/implementation/phases/phase-04-plan.md:1221`; `docs/implementation/phases/phase-04-plan.md:1253`) |
| R5 | Phù hợp. Lane B giao additions cho một superset bump `run-event` 1.2.0 trong S0. (`docs/implementation/phases/phase-04-plan.md:1182`) |
| R6 | Phù hợp. Lane B chỉ sở hữu `attempts.status`; Lane A sở hữu `tasks.status`. (`docs/implementation/phases/phase-04-plan.md:1255`; `docs/implementation/phases/phase-04-data-model.md:551`) |
| R7 | Phù hợp. Có logical contracts mới, rút SR-C3 và không hard-code cross-lane schema total. (`docs/implementation/phases/phase-04-plan.md:1239`; `docs/implementation/phases/phase-04-data-model.md:10`) |
| R8 | Phù hợp về định hướng. Fitness rules phải dùng AST framework của accepted Phase 2. Chúng không phải phần pure diff checks của S6. (`docs/implementation/phases/phase-04-plan.md:1311`; `docs/implementation/phases/phase-04-plan.md:1366`) |
| R9 | Phù hợp. Lane B chỉ giao Grafana provisioning mount cho phần Grafana của compose. (`docs/implementation/phases/phase-04-plan.md:1312`) |
| R10 | Phù hợp về ownership. `production-root.ts` không đổi; `assurance-root.ts` là sibling. Pre-S0 wiring cần tách theo HIGH-001 mới. (`docs/implementation/phases/phase-04-plan.md:1266`; `docs/implementation/phases/phase-04-plan.md:1271`) |
| R11 | Không có ADR mới được yêu cầu trong v2. Review log giữ dải 0018+ nếu cần. (`docs/implementation/phases/phase-04-review-log.md:53`) |
| R12 | Phù hợp. Không tạo pre-rewrite refs; corpus dùng content-addressed excerpts và nêu private bundle dependency. (`docs/implementation/phases/phase-04-plan.md:359`) |
| R13 | Phù hợp. Adapter ở harness, credential được inject, có bounded lifetime, rotation và zero-request tests. (`docs/implementation/phases/phase-04-plan.md:440`; `docs/implementation/phases/phase-04-plan.md:464`) |
| R14 | D-5/D-6/D-7 được ghi đúng. Temporal PostgreSQL smoke vẫn thuộc Lane A, không phải pre-S0 dependency của Lane B. (`docs/implementation/phases/phase-04-plan.md:179`; `../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-exit-criteria.md:117`) |
| R15 | Chưa fold đầy đủ. Fixed logical clock thiếu trong block S0. V2 cũng chưa ghi rõ measurement/replay không được ghi operational events. (`docs/implementation/phases/phase-04-plan.md:715`; `docs/implementation/phases/phase-04-architecture.md:366`; `~/.openclaw/lanes/reconciliation-v1.md:148`) |

Không thấy v2 chủ động yêu cầu bỏ FK hoặc tạo sink thứ hai. Tuy nhiên, phần S0 summary nên ghi rõ FK và sink ownership của R15. (`docs/implementation/phases/phase-04-plan.md:1178`; `~/.openclaw/lanes/reconciliation-v1.md:148`)

Lane A snapshot đã giữ composite FK từ `run_events` sang `runs`. Không cần tạo migration Lane B để sửa lại bảng này. (`../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-data-model.md:283`; `docs/implementation/phases/phase-04-plan.md:1180`)

Ba quyết định người dùng được ghi đúng. D-2 vẫn là policy được chấp nhận nhưng chưa kích hoạt. Production chỉ shadow, còn corpus chỉ descriptive rediscovery với comparator bắt buộc. (`docs/implementation/phases/phase-04-plan.md:176`; `docs/implementation/phases/phase-04-plan.md:182`)

## Slot contract

**Vị trí `packages/application/src/review-loop/` là đúng.** `AdmissionResult` thuộc application. Application đã phụ thuộc ports, còn ports chỉ phụ thuộc contracts. Đặt slot trả `AdmissionResult` trong ports sẽ đảo hướng phụ thuộc. (`packages/application/src/risk-admission.ts:30`; `packages/application/package.json:13`; `packages/ports/package.json:12`)

R16 hiện xác nhận chính vị trí này. Lane A vẫn là owner landing trong S0. (`~/.openclaw/lanes/reconciliation-v1.md:158`)

Block đã có composite method, step methods, admission, telemetry, repair helper và fencing identity. Tuy nhiên, block chưa tự nhất quán theo MED-001, MED-002, MED-004 và MED-005 mới. (`docs/implementation/phases/phase-04-plan.md:732`; `docs/implementation/phases/phase-04-plan.md:1021`)

Đối chiếu với Phase 3 v2:

| Điểm | Đánh giá |
|---|---|
| Activity wrapper | Khớp. Lane A bọc composite round thành một activity. Block Phase 4 cho phép chính cách đó. (`../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-plan.md:810`; `docs/implementation/phases/phase-04-plan.md:1024`) |
| Context adapter | Signal và heartbeat khớp. Fixed logical time mới được ghi đầy đủ phía Lane A. (`../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-plan.md:813`; `docs/implementation/phases/phase-04-plan.md:715`) |
| `recordAttemptOutcome()` | Vị trí gọi khớp, bao gồm verification stop. Terminal strings và default telemetry còn lệch theo MED-007 mới. (`docs/implementation/phases/phase-04-plan.md:1148`; `../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-architecture.md:600`) |
| Hook `admit` | Khớp. Hook mặc định là `admitRisk`; integration bind `admitWithAssurance`. (`docs/implementation/phases/phase-04-plan.md:1308`; `../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-plan.md:818`) |
| Workspace repair | Khớp. Workspace mới bắt đầu tại `repairBaseSha`, không apply diff lên task base. (`docs/implementation/phases/phase-04-plan.md:1147`; `../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-architecture.md:590`) |
| Repair identity | Khớp về `nextRound`, prior adjudication và cumulative task base. (`docs/implementation/phases/phase-04-plan.md:931`; `../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-architecture.md:594`) |
| Handoff text | Lane A vẫn có placeholder, chưa có block đã chép. Việc chép phải đi cùng cập nhật companion prose và exit criteria. (`../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-plan.md:799`; `../asep-review-p3-98e92cf/docs/implementation/phases/phase-03-exit-criteria.md:362`) |

## Các slice pre-S0

**Không nên dừng toàn bộ pre-S0. Nhưng chưa đủ cơ sở gọi mọi slice được đánh dấu pre-S0 là sẵn sàng hoàn tất.** Plan cho phép pure work trước S0 nhưng cấm shared-surface work trước rebase. (`docs/implementation/phases/phase-04-plan.md:29`; `docs/implementation/phases/phase-04-plan.md:1213`)

| Slice | Có thể làm ngay | Phần chưa được coi là hoàn tất |
|---|---|---|
| S3 | Loader, family resolution, shadow-only validation và D-2 pure rule đủ rõ. Package policy đã có contracts và YAML dependencies. (`docs/implementation/phases/phase-04-plan.md:1363`; `packages/policy/package.json:13`) | Đồng bộ primary model theo R16 trước config freeze. Export và required-suite wiring phải có lịch riêng. (`~/.openclaw/lanes/reconciliation-v1.md:165`; `docs/implementation/phases/phase-04-plan.md:1271`; `docs/implementation/phases/phase-04-plan.md:1309`) |
| S4, phần domain | Lifecycle và closure authority đủ rõ để viết pure transitions và local tests. (`docs/implementation/phases/phase-04-plan.md:541`; `docs/implementation/phases/phase-04-data-model.md:623`) | Không sửa `operational.ts` trước S0. `AttemptStatus` mới thuộc S1; DB enforcement thuộc S8. (`docs/implementation/phases/phase-04-plan.md:1244`; `docs/implementation/phases/phase-04-plan.md:1364`; `docs/implementation/phases/phase-04-plan.md:1368`) |
| S5 | Có thể làm renderer, canary tests và canonicalization trên frozen local DTOs. (`docs/implementation/phases/phase-04-architecture.md:266`; `docs/implementation/phases/phase-04-plan.md:1365`) | Chưa khóa DTO ownership, artifact dereference và workspace lookup. Canonical contract/port binding cần S1/S2 hoặc một staged seam được ghi rõ. (`docs/implementation/phases/phase-04-data-model.md:63`; `docs/implementation/phases/phase-04-architecture.md:182`; `docs/implementation/phases/phase-04-plan.md:1361`) |
| S6 | Pure scanners, parsers, egress decision và seeded checks có thể làm trước S0. (`docs/implementation/phases/phase-04-plan.md:559`; `docs/implementation/phases/phase-04-architecture.md:299`) | Cần packet shape và policy đã khóa. SR-X4 phải chờ accepted Phase 2 AST framework. Zero-request composition proof thuộc S12/S16. (`docs/implementation/phases/phase-04-plan.md:1311`; `docs/implementation/phases/phase-04-plan.md:1372`; `docs/implementation/phases/phase-04-plan.md:1376`) |
| S7 | Rule table và closure algorithm đủ để bắt đầu pure tests. (`docs/implementation/phases/phase-04-plan.md:507`; `docs/implementation/phases/phase-04-architecture.md:353`) | Cần staged dependencies vào S3/S4/S5/S6 và contract binding. Domain closure, DB constraints và loop proof chưa thể cùng hoàn tất pre-S0. (`docs/implementation/phases/phase-04-plan.md:1363`; `docs/implementation/phases/phase-04-plan.md:1368`; `docs/implementation/phases/phase-04-exit-criteria.md:85`) |
| S19 | Có thể thu thập provenance, reachable excerpts và hash verification. Không cần persistence hoặc Temporal. (`docs/implementation/phases/phase-04-plan.md:359`; `docs/implementation/phases/phase-04-plan.md:1379`) | Chưa freeze packet-dependent exclusions trước khi giải quyết HIGH-002 mới. Bundle mode vẫn chờ controller cung cấp path. (`docs/implementation/phases/phase-04-data-model.md:756`; `docs/implementation/phases/phase-04-plan.md:369`) |
| S20 | Có thể làm Wilson calculations, floor evaluation và synthetic fixtures độc lập. (`docs/implementation/phases/phase-04-data-model.md:774`; `docs/implementation/phases/phase-04-plan.md:1380`) | Chưa sẵn sàng hoàn tất scorer dùng production path hoặc controller-approved preregistration. Thiếu recipe, matcher definition và build wiring. (`docs/implementation/phases/phase-04-architecture.md:385`; `docs/implementation/phases/phase-04-data-model.md:763`; `evals/tsconfig.json:7`) |

Các file chung cần giao owner trước khi tiếp tục binding gồm local `ports.ts`, schema files, package exports và suite registries. Mutation entries cũng cùng sửa một manifest. Directory ownership cấp lane chưa giải quyết ownership giữa các slice. (`docs/implementation/phases/phase-04-architecture.md:207`; `docs/implementation/phases/phase-04-data-model.md:99`; `docs/implementation/phases/phase-04-plan.md:1271`; `docs/implementation/phases/phase-04-plan.md:1309`; `docs/implementation/phases/phase-04-plan.md:1398`)

DAG cần thể hiện ít nhất các phụ thuộc policy→packet/checks, packet/checks→adjudication và runtime grounding→scorer. Có thể dùng frozen DTOs để tách pure work, nhưng plan phải ghi cách nối lại sau S0. (`docs/implementation/phases/phase-04-architecture.md:61`; `docs/implementation/phases/phase-04-architecture.md:343`; `docs/implementation/phases/phase-04-architecture.md:385`; `docs/implementation/phases/phase-04-plan.md:1394`)

Không có lý do bắt các pure-core slice phụ thuộc Temporal. Dependency Phase 2 thực sự nằm ở fencing, accepted shared contracts và AST fitness framework. (`docs/implementation/phases/phase-04-plan.md:35`; `docs/implementation/phases/phase-04-plan.md:605`; `docs/implementation/phases/phase-04-plan.md:1311`)

Migration numbering hiện nhất quán: ba migration là `0200_assurance_reviews`, `0201_metric_snapshots` và `0202_attempt_review_states`. Tất cả nằm trong dải 0200–0299. ID `0201_run_events` đã được rút trước implementation. (`docs/implementation/phases/phase-04-plan.md:1248`; `docs/implementation/phases/phase-04-data-model.md:493`; `docs/implementation/phases/phase-04-data-model.md:533`)

Các mâu thuẫn cross-document mới tập trung ở clock, shadow BLOCK, payload envelope, proof gate và window semantics. Chúng tương ứng MED-002 đến MED-006, không phải lỗi số migration. (`docs/implementation/phases/phase-04-plan.md:715`; `docs/implementation/phases/phase-04-plan.md:1136`; `docs/implementation/phases/phase-04-exit-criteria.md:177`; `docs/implementation/phases/phase-04-data-model.md:503`)

## Kết luận

14 finding lần một đã được fold vào design và proof plan. MED-001 mới chỉ fold một phần vì execution-manifest coverage chưa phủ integration runner. Không finding nào chỉ được đổi tên trong review log. Bảng disposition dựa trên `git diff a2a7b8a..3201335 -- docs/` và các locus đã dẫn.

Chưa xác nhận lock vì pre-S0 staging và corpus protocol vẫn chưa đủ rõ. Block S0 cũng cần sửa trước handoff để tránh đóng băng các mâu thuẫn giao diện. (`docs/implementation/phases/phase-04-plan.md:1354`; `docs/implementation/phases/phase-04-plan.md:1379`; `docs/implementation/phases/phase-04-plan.md:671`)

Cho phép tiếp tục pure work của S3, phần domain S4 và các phần độc lập đã phân loại. Không coi contract binding, scorer freeze hoặc full-slice acceptance là hoàn tất trước khi sửa plan. (`docs/implementation/phases/phase-04-plan.md:1363`; `docs/implementation/phases/phase-04-plan.md:1364`; `docs/implementation/phases/phase-04-architecture.md:385`)

Không sửa file nào. HEAD vẫn là `32013356e0845354f40ac6f63925f928637d6fb3`; working tree sạch; diff whitespace check không báo lỗi. Không xác nhận runtime test results trong review này. (Lệnh `git rev-parse HEAD`, `git status --porcelain`, `git diff --check a2a7b8a..3201335 -- docs/`)
