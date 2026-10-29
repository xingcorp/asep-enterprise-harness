# Phase 4 — Codex Review v3: plan, slot block and pre-S0 code (verbatim)

> Provenance: independent, read-only review of the LOCKED v3 plan, the verbatim slot block and the pre-S0 code by
> Codex running `gpt-6.1-sol` through the kiro-proxy gateway, commissioned by the controller on 2026-10-29. Reviewed
> branch `phase/04-independent-assurance` at snapshot `9e3a1c3` (`9e3a1c32e869193e981a867e8bb9fbd1abaec9c8`). Codex CLI
> 0.165.0, one uninterrupted run. Copied into the repository by the Lane B session from the controller's output file
> (sha256 of the source file: `7f94d446680129eb3507b12192618f3a8602c6586e7f423dffb85432d1762406`). The body below is
> byte-identical to that file except for two edits required by repository gates: (1) the PII gate
> (`scripts/pii-scan.sh` email pattern) — the at-sign in one corpus item file name (Part 3, "Corpus S19") is
> written URL-encoded, `P2-CYCLE6-HIGH-001%40ebaf519.json`, because the original form reads as an email address; (2) the format gate (`scripts/format-check.sh`) — a final
> newline is added. The review is in Vietnamese, as produced. Line numbers in it refer to the documents and code at
> `9e3a1c3`. Dispositions are recorded in `phase-04-review-log.md` ("Review v3").
>
> Controller gate at the same snapshot, on a clean detached worktree: `pnpm verify:all` exit 0; 598 tests, 598 pass,
> 0 fail, 0 skipped; 60 test files; 37 required suites. (The reviewer did not run the full gate; its own counts are in
> Part 3 below.)

---

VERDICT: REQUEST_CHANGES  confidence 0.99

## Phần 1 — Plan v3

`FOLDED` xác nhận finding đã đi vào thiết kế. Trạng thái này không xác nhận code hoặc integration đã đạt acceptance.

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P4-PLAN2-HIGH-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1823`, `:1849`, `:1874` | Plan đã tách pure core và integration. Plan đã giao owner và thêm dependency edges. Các append landing sớm được khai báo riêng. |
| P4-PLAN2-HIGH-002 | FOLDED | `docs/implementation/phases/phase-04-plan.md:448`, `:478`, `:505`, `:511`, `:553` | Plan đã khóa recipe, synthetic fields, matcher, cardinality và golden fixtures. R22 còn cần đồng bộ trước freeze. |
| P4-PLAN2-MED-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:998`, `:1011`, `:1531` | Resolver kiểm tenant, lease ACTIVE, holder và epoch. Refusal phải dừng trước repository read. |
| P4-PLAN2-MED-002 | FOLDED | `docs/implementation/phases/phase-04-plan.md:914`, `:970`, `:1522` | Invariant logical time đã nằm trong block. RLC-11 yêu cầu so sánh persisted record bytes và event bytes. |
| P4-PLAN2-MED-003 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1701`; `docs/implementation/phases/phase-04-exit-criteria.md:186` | Proof manifest đã phủ cả hai runner. Optional live được biểu diễn bằng policy test. |
| P4-PLAN2-MED-004 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1213`, `:1219`, `:1230`, `:1303` | ContextPack và kết quả lớn đã chuyển sang ArtifactRef. Envelope còn lỗi mới tại Phần 2. |
| P4-PLAN2-MED-005 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1208`, `:1233`, `:1517`, `:1523` | Shadow verdict chỉ thuộc PROCEED. Shadow BLOCK đã có conformance case và khớp DDL. |
| P4-PLAN2-MED-006 | FOLDED | `docs/implementation/phases/phase-04-plan.md:810`; `docs/implementation/phases/phase-04-exit-criteria.md:133` | Late disposition cập nhật cohort gốc bằng snapshot version mới. Plan đã yêu cầu giữ lịch sử và báo latency. |
| P4-PLAN2-MED-007 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1406`, `:1491`, `:1501` | Hai default slot có vai trò riêng. Terminal vocabulary đã thống nhất trong hợp đồng Phase 4. |
| P4-PLAN2-MED-008 | FOLDED | `docs/implementation/phases/phase-04-plan.md:221`, `:683`; `policies/review-policy.yaml:49`, `:60` | Primary đã đổi thành gpt-6.1-sol. Plan đã ghi gateway alteration và comparator khác họ. |
| P4-PLAN-MED-001, v1 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1701`, `:1820`; `docs/implementation/phases/phase-04-exit-criteria.md:186` | Proof gate đã giao reporter và kiểm named-test results cho cả canonical runner lẫn integration runner. |

Các quyết định người dùng được ghi đúng. D-2 tồn tại nhưng không kích hoạt trong Phase 4. Production chỉ chạy shadow. Corpus chỉ mang ý nghĩa descriptive self-history với comparator khác họ bắt buộc. (`docs/implementation/phases/phase-04-plan.md:213`, `:215`, `:219`, `:220`)

R15 và R16 đã được phản ánh trong clock contract, slot location, model và gateway qualification. (`docs/implementation/phases/phase-04-plan.md:902`, `:914`, `:683`; `~/.openclaw/lanes/reconciliation-v1.md:152`, `:158`)

Các seam liên quan R17 có cancellation context và repair lineage. Orchestrator chỉ gọi assurance sau evidence persistence, trước push. R17 vẫn cần được chứng minh tại Phase 3 integration. (`docs/implementation/phases/phase-04-plan.md:970`, `:1060`, `:1073`, `:1541`; `~/.openclaw/lanes/reconciliation-v1.md:173`, `:190`, `:197`)

R18 staging có ngoại lệ được công khai. Exports, policy-source và chín suite registrations đã landing sớm rồi được giữ lại. Đây không phải bằng chứng tuân thủ đầy đủ thứ tự staging. (`docs/implementation/phases/phase-04-plan.md:1842`; `~/.openclaw/lanes/reconciliation-v1.md:228`)

### P4-PLAN3-MED-001 — R22 chưa được đồng bộ vào protocol và provenance vocabulary

Snapshot dùng `tree-unavailable`, `object-store-only` và `derived-from-fix`. R22 yêu cầu `reviewed-tree-unknown`, `private-bundle-only` và `inferred-parent-of-fix`. (`evals/review-corpus/collect.ts:37`; `docs/implementation/phases/phase-04-data-model.md:829`; `~/.openclaw/lanes/reconciliation-v1.md:315`)

Plan chưa ghi đầy đủ yêu cầu đếm item phụ thuộc private bundle. Plan cũng chưa ghi riêng quy tắc loại Phase 1 thiếu location tại freeze. (`docs/implementation/phases/phase-04-plan.md:539`; `~/.openclaw/lanes/reconciliation-v1.md:318`, `:323`)

**Thay đổi bắt buộc:** Đồng bộ plan, data model, collector vocabulary và freeze assertions theo R22. Báo riêng số item phụ thuộc bundle và số Phase 1 thiếu location.

R22 được ban hành sau snapshot theo thông tin controller cung cấp. Finding này là delta cần tiếp nhận, không phải kết luận lane đã bỏ qua chỉ thị có trước.

### P4-PLAN3-MED-002 — Hai shape corpus execution đang mâu thuẫn

Recipe quy định `execution: { verdict: 'NOT_RECORDED', environment: null, checks: [] }`. S20 staging lại mô tả `execution: null`. Data model dùng shape thứ nhất. (`docs/implementation/phases/phase-04-plan.md:486`, `:1840`; `docs/implementation/phases/phase-04-data-model.md:64`)

**Thay đổi bắt buộc:** Chọn một shape duy nhất trước S1/S20. Golden fixture phải round-trip qua validator và renderer tương ứng.

### P4-PLAN3-MED-003 — Predicate closure chưa thống nhất giữa plan và architecture

Plan yêu cầu resolution citation nằm trong repair delta. Architecture chỉ kiểm cited file thuộc danh sách file của delta. (`docs/implementation/phases/phase-04-plan.md:761`; `docs/implementation/phases/phase-04-architecture.md:397`)

Hai điều kiện này khác nhau khi citation trỏ vào context không đổi. Code hiện cũng nhầm context của hunk thành changed region. (`packages/application/src/assurance/grounding.ts:104`)

**Thay đổi bắt buộc:** Định nghĩa rõ changed-line predicate trong cả hai tài liệu. Golden test phải chứa context không đổi cạnh dòng sửa.

## Phần 2 — Slot block

**Block chưa sẵn sàng hand-off nguyên văn cho S0.** Các sửa R18 chính đã có, nhưng hợp đồng vẫn còn ba lỗi dưới đây.

| Hạng mục R18 | Kết quả | Bằng chứng |
|---|---|---|
| Workspace resolver kiểm tenant, ACTIVE lease, holder và epoch. | Đã ghi đủ nghĩa vụ và refusal mapping. | `docs/implementation/phases/phase-04-plan.md:998`, `:1011`, `:1531` |
| Fixed logical time nằm ngay trong block. | Đã có invariant và nghĩa vụ byte-identical redelivery. | `docs/implementation/phases/phase-04-plan.md:914`, `:973` |
| ContextPack và kết quả lớn đi bằng ArtifactRef. | Các shape chính đã đổi sang reference. | `docs/implementation/phases/phase-04-plan.md:1111`, `:1213`, `:1303` |
| Shadow chỉ bắt buộc tại PROCEED trong shadow mode. | Đã khớp outcome contract và DDL. | `docs/implementation/phases/phase-04-plan.md:1208`, `:1233`; `docs/implementation/phases/phase-04-data-model.md:485` |
| Hai default slot cùng tồn tại. | Block phân biệt default fail-closed và explicit opt-out. | `docs/implementation/phases/phase-04-plan.md:1406`, `:1491` |
| Terminal vocabulary thống nhất. | Block đã khai báo đầy đủ từ vựng được chọn. | `docs/implementation/phases/phase-04-plan.md:1248`, `:1501` |

### P4-SLOT-MED-001 — `Promise<void>` không thể thỏa universal JSON-output contract

`recordAttemptOutcome` trả `Promise<void>`. Header yêu cầu mọi output là plain JSON và cấm undefined. Helper lại từ chối undefined root. (`docs/implementation/phases/phase-04-plan.md:908`, `:1338`, `:1384`)

RLC-01 yêu cầu mọi method output JSON-round-trip deep-equal. Một implementation trả đúng `void` sẽ không đạt quy tắc này. (`docs/implementation/phases/phase-04-plan.md:1512`)

Probe trích helper từ block đã trả `ReviewLoopContractError` cho undefined root. Probe chạy bằng `node --disable-warning=ExperimentalWarning --input-type=module -e`.

**Thay đổi bắt buộc:** Trả `null` hoặc JSON acknowledgement. Nếu giữ void, phải định nghĩa ngoại lệ và mapping activity rõ ràng.

### P4-SLOT-MED-002 — Envelope helper chấp nhận payload làm mất dữ liệu khi serialize

`reviewLoopPayloadBytes` chỉ gọi `JSON.stringify`. Helper không kiểm plain JSON như header đã hứa. (`docs/implementation/phases/phase-04-plan.md:908`, `:1377`)

Probe thực thi helper nguyên bản cho các kết quả sau:

| Payload | Kết quả helper | JSON sau serialize |
|---|---|---|
| `{ x: undefined }` | Helper chấp nhận. | `{}` |
| `{ x: Infinity }` | Helper chấp nhận. | `{"x":null}` |
| `{ x: Date }` | Helper chấp nhận. | Giá trị chuyển thành chuỗi timestamp. |
| `{ x: Map }` | Helper chấp nhận. | `{"x":{}}` |

Probe chạy bằng `node --disable-warning=ExperimentalWarning --input-type=module -e`. Hành vi xuất phát trực tiếp từ `JSON.stringify` tại `docs/implementation/phases/phase-04-plan.md:1380`.

**Thay đổi bắt buộc:** Kiểm recursive plain JSON trước khi đo bytes. Từ chối undefined keys, non-finite numbers và class instances. Bổ sung negative fixtures vào RLC-01.

### P4-SLOT-MED-003 — Hai helper ghi dữ liệu thiếu caller fencing identity

`AssuranceSlotInput` có fence. `AttemptOutcomeInput` và `RepairContextInput` không có fence. Context cũng không mang caller identity thay thế. (`docs/implementation/phases/phase-04-plan.md:1074`, `:1259`, `:1303`, `:970`)

Trong khi đó, block yêu cầu mọi claim, completion và decision write kiểm caller lease trong cùng transaction. Repair helper còn phải persist ContextPack trước khi trả. (`docs/implementation/phases/phase-04-plan.md:984`, `:1315`)

Review log nói fence có trong mọi slot input. Khẳng định đó không đúng với hai helper này. (`docs/implementation/phases/phase-04-review-log.md:223`)

**Thay đổi bắt buộc:** Chốt authority cho từng helper ghi dữ liệu. Truyền fence hoặc capability có thể kiểm chứng. Quy định terminal recording trước hay sau lease release. Quy định xử lý redelivery có cùng attempt nhưng payload xung đột.

Không được lấy epoch hiện tại từ database rồi coi đó là danh tính caller.

Về Temporal, round input đã có idempotency key và fencing identity. Adapter có thể giữ `AssuranceStepContext` cục bộ rồi serialize DTO cùng logical time. Heartbeat contract yêu cầu chu kỳ tối đa 30 giây. (`docs/implementation/phases/phase-04-plan.md:965`, `:978`, `:1052`, `:1074`, `:1549`)

Ba finding trên cần được chốt trước khi hai lane đóng băng activity mapping. Temporal hỗ trợ transport không tự giải quyết các mâu thuẫn nghiệp vụ này.

## Phần 3 — Audit code

Tôi không xác nhận số 592 hoặc 598. Tôi đã chạy chín file test pure core bằng Node loader trong RAM. Kết quả độc lập là **47 pass, 0 fail, 0 skipped**.

Nguồn `@asep/*` được resolve về snapshot này. Loader chỉ lấy npm dependencies từ worktree Phase 4 kế bên. Lệnh chạy dùng `node --disable-warning=ExperimentalWarning --input-type=module -e`.

Hai test corpus đọc provenance và labels cũng chạy độc lập. Kết quả là **2 pass, 0 fail, 0 skipped**. Test publication gate tạo temporary repository không được chạy trong phạm vi read-only. (`evals/review-corpus/collect.test.ts:39`, `:161`, `:230`; `evals/review-corpus/collect.ts:565`)

`pnpm verify:all` không được chạy. Script xóa build cache rồi thực hiện `tsc -b`, nên vượt phạm vi read-only. (`scripts/verify-all.sh:55`, `:72`, `:79`)

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P4-CODE-HIGH-001 | HIGH | `packages/policy/src/review.ts:515`, `:523`, `:538`, `:562`; `policies/review-policy.yaml:112` | Path chứa LF được coi là normalized. Regex `**` dùng dot không khớp LF. Path `src/line\nbreak/secrets/customer.txt` né `**/secrets/**`. Probe nhận push guard PASS, egress CLEAR và một lần gọi fake sender. | Từ chối control/line-separator paths hoặc sửa glob semantics phủ đầy đủ codepoints. Thêm zero-request test với Git C-quoted paths và LF/CR/U+2028/U+2029. |
| P4-CODE-HIGH-002 | HIGH | `packages/application/src/assurance/egress.ts:37`, `:100`, `:109` | Egress scan repair-delta text nhưng chỉ trích old paths từ cumulative diff. Rename `secrets/customer.txt` sang `src/customer.txt` trong repair delta được CLEAR khi cumulative diff chỉ thêm path đích. Probe đã gọi fake sender một lần. | Parse và classify cả hai phía của cả hai diff. Bao phủ rename, delete và file chỉ xuất hiện trong repair delta. |
| P4-CODE-HIGH-003 | HIGH | `packages/application/src/assurance/adjudication.ts:339`; `packages/application/src/assurance/findings.ts:82` | Dedupe giữ finding đầu tiên trước grounding. Fingerprint bỏ severity, finding key và requirement ID. `[LOW, CRITICAL]` trả PROCEED; đảo thứ tự trả REPAIR. Finding không grounded cũng có thể che finding grounded phía sau. | Giữ identity riêng hoặc merge bảo thủ theo grounding và severity cao nhất. Thêm permutation tests và collision giữa requirements. |
| P4-CODE-HIGH-004 | HIGH | `packages/application/src/assurance/grounding.ts:104`; `packages/application/src/assurance/adjudication.ts:268` | `lineInRepairDelta` kiểm toàn bộ new hunk range. Range này chứa context không đổi. Probe chỉ thêm comment ở dòng 3 nhưng citation dòng 2 vẫn đóng HIGH thành VERIFIED và trả PROCEED. | Tính changed post-image lines từ nội dung diff. Định nghĩa riêng deletion-only semantics. Citation vào context không đổi phải không đủ quyền closure. |
| P4-CODE-HIGH-005 | HIGH | `packages/application/src/assurance/adjudication.ts:261`, `:391`; `packages/domain/src/assurance.ts:207`, `:224` | SARIF prior HIGH vẫn OPEN nhưng bị loại khỏi blocking vì source khác model. Probe không có scanner recheck vẫn trả PROCEED. Domain cũng không cho model hoặc deterministic-recheck đóng SARIF finding. | Giữ blocking đến authorized closure. Nếu hỗ trợ scanner recheck, phải chứng minh cùng scanner/rule đã chạy thành công và sạch. |
| P4-CODE-HIGH-006 | HIGH | `evals/review-corpus/collect.ts:575`, `:697`, `:715` | Collector bỏ qua scanner status, error và signal. Collector chỉ loại excerpt khi output chứa blob path. Probe giả lập cả năm scanner lỗi status 2 nhưng không excerpt nào bị loại. | Abort collection khi scanner không hoàn tất hợp lệ. Phân biệt tool failure với content finding. Thêm test scanner crash, missing executable và output lỗi không chứa blob path. |
| P4-CODE-MED-001 | MEDIUM | `packages/application/src/assurance/adjudication.ts:351`, `:363`, `:394` | Finding được reviewer nhắc lại luôn tạo OPEN entry mới. Probe cùng raiser và fingerprint với waiver còn hạn tạo hai entry. Entry OPEN làm outcome REPAIR dù prior vẫn WAIVED. | Reconcile current finding với persisted identity và authoritative disposition trước khi tính blocking. Quy định rõ điều kiện phát hiện regression mới. |
| P4-CODE-MED-002 | MEDIUM | `packages/application/src/assurance/packet.ts:246`, `:267`; `packages/application/src/assurance/prompt.ts:230` | Budget chỉ cộng diffs, post-images và excerpts. Objective dài 450000 ký tự vẫn có includedBytes 850 với cap 400000. Packet đạt 452993 bytes; rendered prompt đạt 459199 bytes nhưng vẫn được chấp nhận. | Định nghĩa chính xác budget boundary. Tính mọi content-bearing field và kiểm serialized bytes tương ứng. Over-budget phải được flag trước rendering/sending. |
| P4-CODE-MED-003 | MEDIUM | `packages/application/src/assurance/checks.ts:210`, `:237`; `packages/application/src/assurance/execution-manifest.ts:17` | False-green check chỉ bắt `tests === 0`. Probe `tests=3, pass=0, skipped=3` không tạo finding. Probe `tests=1, fail=1, exitCode=0, recorded PASS` cũng không tạo finding. | Kiểm số test thực sự chạy và summary failure mismatch. Giữ unknown formats là null. Mở rộng rule trong plan cùng regression tests. |
| P4-CODE-LOW-001 | LOW | `packages/application/src/assurance/adjudication.ts:494` | `git diff --check a2a7b8a..HEAD` trả exit 2 vì thêm dòng trống cuối file. | Xóa dòng trống dư ở EOF. |

Các đường gửi đã tái hiện ở HIGH-001 và HIGH-002 chỉ gọi fake sender. Không có request mạng thật trong audit.

### Kiểm chứng nghiệp vụ và bảo mật

Policy loader từ chối committed `gating` mode. Family resolution dùng longest-prefix và từ chối family không biết. Egress mặc định yêu cầu project opt-in. (`packages/policy/src/review.ts:317`, `:426`, `:464`, `:511`; `policies/review-policy.yaml:102`)

Domain chặn raiser tự verify. Domain cũng chặn reviewer waive/refute và chặn model verify finding từ nguồn khác model. Các guard này có test chạy xanh. (`packages/domain/src/assurance.ts:191`, `:205`; `packages/domain/src/assurance.test.ts:179`)

Quyền domain đúng chưa đủ bảo vệ adjudication. HIGH-004 và HIGH-005 cho thấy finding có thể mất hiệu lực bên ngoài transition guard. (`packages/application/src/assurance/adjudication.ts:268`, `:397`)

Canary trong coder self-report không vào packet hoặc rendered prompt ở test đã chạy. Test có positive control cho nội dung thực sự thuộc diff. (`packages/application/src/assurance/packet.test.ts:24`, `:60`, `:67`)

Renderer kiểm artifact digest và UTF-8. Renderer chỉ nhúng post-image có reference. Nonce lấy từ packet hash và nội dung được datamark. (`packages/application/src/assurance/prompt.ts:225`, `:232`, `:238`; `packages/application/src/assurance/prompt.test.ts:37`, `:50`, `:97`)

Các fixture hiện có chặn secret, missing content, substituted content và sensitive binary. Những fixture đó không phủ hai bypass classification đã tái hiện. (`packages/application/src/assurance/egress.test.ts:145`, `:174`, `:193`)

Normalization hiện xử lý `..`, backslash và case theo deny-list tests. Nó không loại line separators như HIGH-001. (`packages/policy/src/review.ts:516`; `packages/policy/src/review.test.ts:263`, `:276`)

Chưa thể chứng nhận chống symlink trên đường đọc repository thật. `ReviewSourceReader` adapter được lên lịch ở S9 sau S0. (`docs/implementation/phases/phase-04-plan.md:1806`)

### Determinism

Packet và prompt đã qua test đảo thứ tự changed files, post-images, requirements và Map insertion. Bytes và hash vẫn giống nhau. (`packages/application/src/assurance/packet.test.ts:272`; `packages/application/src/assurance/prompt.test.ts:88`)

Canonical JSON sắp object keys. Packet builder sắp file paths và prior finding IDs. Nonce không dùng random. (`packages/application/src/assurance/canonical-json.ts:21`; `packages/application/src/assurance/packet.ts:136`, `:251`; `packages/application/src/assurance/prompt.ts:232`)

HIGH-003 là phụ thuộc thứ tự có hậu quả nghiệp vụ. Cùng tập finding nhưng đổi thứ tự severity làm đổi outcome. (`packages/application/src/assurance/adjudication.ts:339`)

Lệnh `rg` đã quét các nguồn assurance, policy review, domain assurance và corpus TypeScript. Không có match cho `@temporalio`, `fetch`, `WebSocket`, `process.env`, wall-clock/random APIs hoặc HTTP/network imports. Corpus có subprocess cho Git và publication scripts. (`evals/review-corpus/collect.ts:21`, `:573`, `:577`)

### Corpus S19

Inventory độc lập đọc JSON và tính SHA-256 bằng Node cho kết quả sau:

| Hạng mục | Kết quả kiểm đếm |
|---|---:|
| Tổng item | 153 |
| Included ở provenance stage | 65 |
| `plan-defect` | 69 |
| `tree-unavailable` | 19 |
| Blob | 122 |
| Blob sai content address | 0 |
| Phase 1 included nhưng không có location | 15 |
| Phase 2 v5 `object-store-only` | 9 |

Inventory chạy bằng `node --input-type=module -e` với `readFileSync` và `createHash`. Kết quả khớp số liệu tại `docs/implementation/phases/phase-04-review-log.md:479`.

Test provenance đã kiểm blob bytes với Git khi tree hiện diện. Test cũng kiểm reviewed SHA evidence, parent derivation và fix ancestry. (`evals/review-corpus/collect.test.ts:74`, `:121`, `:142`)

Không thấy collector đoán tree cho Phase 2 v4. Collector trả unknown khi commit thêm review document cũng thêm document của cycle sau. (`evals/review-corpus/collect.ts:538`)

Self-found item dùng parent của named fix commit. Evidence trỏ về Phase 2 report, dòng 58. (`evals/review-corpus/collect.ts:526`; `evals/review-corpus/self-history/items/P2-CYCLE6-HIGH-001%40ebaf519.json:10`, `:23`)

Các tree `object-store-only` chưa có provenance label theo R22. Clean public clone không thể đối chiếu historical bytes của chúng nếu thiếu private objects. (`evals/review-corpus/collect.test.ts:101`; `~/.openclaw/lanes/reconciliation-v1.md:318`)

Con số 65 chưa phải denominator đã freeze. Packet eligibility còn chờ các bước sau. Mười lăm Phase 1 thiếu location phải được loại và báo đếm theo R22. (`docs/implementation/phases/phase-04-plan.md:550`; `~/.openclaw/lanes/reconciliation-v1.md:323`)

Content address đúng không chứng minh publication scan đã chạy thành công. HIGH-006 làm đường thu thập fail-open khi scanner lỗi. (`evals/review-corpus/collect.ts:577`, `:580`)

Probe HIGH-006 trích nguyên hàm và giả lập filesystem cùng subprocess trong RAM. Probe không tạo temporary repository.

### Ranh giới thay đổi

Lệnh sau không trả file nào:

```sh
git diff --name-only a2a7b8a..HEAD -- \
  packages/ports packages/contracts \
  adapters/persistence/src/migrations.ts \
  apps/control-plane-api/src/production-root.ts \
  apps/control-plane-api/src/assurance-root.ts \
  packages/domain/src/operational.ts \
  scripts/forbidden-imports.test.ts workers
```

Các shared append surfaces landing sớm đã được khai báo trong staging v3. Không nên mô tả chúng là chưa từng được chạm. (`docs/implementation/phases/phase-04-plan.md:1842`)

`git rev-parse HEAD` trả `9e3a1c32e869193e981a867e8bb9fbd1abaec9c8`. `git status --porcelain` trước và sau audit đều rỗng. Audit không sửa file.

### Mutation không bị bắt

Mutation đã thực thi trong RAM vô hiệu hóa guard tại `packages/application/src/assurance/adjudication.ts:185`:

```ts
if ((review.status === 'COMPLETED_VALID') !== (review.output !== null)) {
```

Mutation thay condition bằng `false`. Loader kiểm source match đúng một lần trước khi thay.

**Cả 47 test hiện có vẫn pass.** Counterexample `status: 'COMPLETED_VALID', output: null` sau mutation trả **PROCEED**.

Lệnh mutation dùng `node --disable-warning=ExperimentalWarning --input-type=module -e` và import lại chín file test snapshot. Không có mutation nào được ghi xuống file.

Test `"rule table is total and deterministic"` chỉ kiểm reviewer-list mismatch và packet-hash mismatch tại phần invalid input. Nó chưa kiểm status/output consistency. (`packages/application/src/assurance/adjudication.test.ts:163`)

Test `"reviewer failure escalates in gating mode"` chỉ tạo các cặp status/output nhất quán. Nó không thể giết mutation này. (`packages/application/src/assurance/adjudication.test.ts:251`)

**Thay đổi bắt buộc:** Thêm cả hai negative cases. `COMPLETED_VALID + null` phải bị từ chối. Failed/invalid status kèm output cũng phải bị từ chối.

Một số oracle hiện tại bám theo implementation quá sát:

- Budget test lấy chính `includedBytes` làm ngưỡng. Test không so với independent serialized-byte count. (`packages/application/src/assurance/packet.test.ts:127`)
- Grounding test đặt citation ngoài hunk để kiểm dòng không đổi. Test thiếu citation vào context nằm trong hunk. (`packages/application/src/assurance/grounding.test.ts:93`, `:125`)
- Closure test kiểm human-settled prior khi current findings rỗng. Test thiếu reviewer nhắc lại cùng finding. (`packages/application/src/assurance/adjudication.test.ts:432`)
- Publication test kiểm content violations. Test thiếu scanner execution failure. (`evals/review-corpus/collect.test.ts:230`)

## Kết luận

**Chưa hand-off slot block cho Phase 3.** Sửa ba finding P4-SLOT trước khi chép nguyên văn vào S0.

**Chưa chấp nhận các slice code đã audit.** Sáu HIGH đã có counterexample hoặc control-flow reproduction cụ thể.

Giữ nguyên D-2 inactive, shadow-only và descriptive self-history. Đồng bộ R22 trước corpus freeze. (`docs/implementation/phases/phase-04-plan.md:213`, `:219`, `:220`; `~/.openclaw/lanes/reconciliation-v1.md:315`)

Sau sửa, chạy regression và mutation proofs rồi kiểm lại full gate trên đúng HEAD. Kết quả 47 test xanh hiện tại không đủ đóng các finding này.
