# Phase 4 — Codex Re-check v5: plan v5, slot block and code fixes (verbatim)

> Provenance: independent, read-only re-check of the LOCKED v5 plan, the verbatim slot block and the code fixes by
> Codex running `gpt-6.1-sol` through the kiro-proxy gateway, commissioned by the controller on 2026-10-30. Reviewed
> branch `phase/04-independent-assurance` at snapshot `fb2e432` (`fb2e4323a61e128553043b08157f02c70a1684c9`). Codex CLI
> 0.165.0, one uninterrupted run. Copied into the repository by the Lane B session from the controller's output file
> (sha256 of the source file: `9adbd8382aea6f5d7c1cf5c20c3a8f3d5cf5a4edf460e0bfaaf6ddcce047a71d`). The body below is
> byte-identical to that file except for one edit required by the format gate (`scripts/format-check.sh`): a final
> newline is added. The review is in Vietnamese, as produced. Line numbers in it refer to the documents and code at
> `fb2e432`. Dispositions are recorded in `phase-04-review-log.md` ("Review v5").
>
> Controller checks at the same snapshot, on a clean detached worktree: `pnpm verify:all` exit 0; 620 tests, 620 pass,
> 0 fail, 0 skipped; 60 test files; 37 required suites. Shellcheck (Docker `koalaman/shellcheck:stable`) on
> `scripts/check-publication.sh`: one SC2046 warning, identical to the `00a6889` version; no new warning. (The reviewer
> did not run the full gate; its own counts are in Part 3 below.)

---

VERDICT: REQUEST_CHANGES  confidence 0.99

## Phần 1 — Plan v5

Snapshot được kiểm là `fb2e4323a61e128553043b08157f02c70a1684c9`.
Lệnh `git rev-parse HEAD` xác nhận SHA này.
Lệnh `git status --porcelain` không trả thay đổi.

`FOLDED` xác nhận thiết kế đã tiếp nhận finding.
Trạng thái này không chứng nhận implementation hoặc integration.

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P4-PLAN4-HIGH-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:919`; `docs/implementation/phases/phase-04-architecture.md:441` | Predicate đã yêu cầu effective execution và coverage. Implementation vẫn có false green mới, trình bày tại Phần 3. |
| P4-PLAN4-MED-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:679`; `docs/implementation/phases/phase-04-data-model.md:78` | Packet không còn chứa measured size. Oracle kiểm final bytes của packet được chấp nhận. |
| P4-PLAN4-MED-002 | FOLDED | `docs/implementation/phases/phase-04-data-model.md:280`; `docs/implementation/phases/phase-04-exit-criteria.md:132` | DDL đã nhận `prompt-over-budget`. Persistence regression được giao S8, chưa được audit này thực thi. |
| P4-SLOT4-MED-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1101`, `:1279`, `:1426`, `:1546`, `:1744` | Money dùng integer micro-USD. Helper thực sự từ chối fractional, negative và unsafe values. |
| P4-SLOT4-MED-002 | PARTIAL | `docs/implementation/phases/phase-04-plan.md:1566`, `:1857`, `:1983`, `:2012` | Union và tám nghĩa vụ đã có. Proof atomicity vẫn được phép N/A. Mapping chưa nhận ngoại lệ R29. |

Đối chiếu reconciliation:

| Quyết định | Đánh giá | Bằng chứng |
|---|---|---|
| R15 | Fixed logical time và operational-event boundary đã được phản ánh. | `docs/implementation/phases/phase-04-plan.md:811`, `:976`, `:1107`, `:2048` |
| R16 | Slot nằm trong application. Model candidate và giới hạn gateway đã được cập nhật. | `docs/implementation/phases/phase-04-plan.md:38`, `:801`, `:1078` |
| R17 | Seam giữ cancellation, budget input và repair lineage. Audit này không chứng nhận workflow Phase 3. | `docs/implementation/phases/phase-04-plan.md:1164`, `:1273`, `:1279`, `:2011`; reconciliation R17 tại dòng 173 |
| R18 | Resolver, ArtifactRef, shadow BLOCK và hai default slots đã có. | `docs/implementation/phases/phase-04-plan.md:1207`, `:1314`, `:1490`, `:1929` |
| R18 staging | Ngoại lệ landing sớm vẫn được khai báo. Không thể gọi lịch sử staging là hoàn toàn tuân thủ. | `docs/implementation/phases/phase-04-plan.md:2306`, `:2307` |
| R22 | Collector dùng vocabulary đúng. Plan còn một câu dùng vocabulary cũ. | `docs/implementation/phases/phase-04-plan.md:477`, `:479`; `evals/review-corpus/collect.test.ts:70` |
| R23 | JSON outputs, helper fencing, redelivery conflict và changed-line predicate đã được phản ánh. | `docs/implementation/phases/phase-04-plan.md:909`, `:1641`, `:1986` |
| R26 | Lane ghi đúng owner Phase 2. Snapshot chưa có workaround trong hai runner. | `docs/implementation/phases/phase-04-review-log.md:970`; `scripts/run-canonical-tests.mjs:69`; `scripts/integration/run-integration.mjs:166` |
| R28 | Money và unions đạt yêu cầu trực tiếp. Proof pre-lease còn thiếu tính bắt buộc. | `docs/implementation/phases/phase-04-plan.md:1405`, `:1464`, `:1585`, `:1857` |
| R29 | SR-A3 và H4 vẫn tuyên bố tuyệt đối “every terminal”. Mapping null-fence refusal còn sai. | `docs/implementation/phases/phase-04-plan.md:2012`, `:2023`; `docs/implementation/phases/phase-04-exit-criteria.md:133` |
| R31 | Slot không tự quyết publication reconciliation. Không cần đưa remote observation vào assurance outcome. | `docs/implementation/phases/phase-04-plan.md:1089`, `:1268`, `:2010`; reconciliation R31 tại dòng 627 |

R31 vẫn ràng buộc Lane A sau outcome cho phép publication.
`PROCEED` không tự chứng minh remote publication đã reconciled.
Reconciliation R31 yêu cầu repository, SHA, base, state và uniqueness tại dòng 627.

Các finding mới:

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P4-PLAN5-MED-001 | Cần sửa | `docs/implementation/phases/phase-04-plan.md:1638`, `:1943`, `:2012`; `docs/implementation/phases/phase-04-exit-criteria.md:133`, `:165` | R29 cho phép thiếu terminal khi lookup hết retry. Plan và H4 chưa ghi ngoại lệ. J6 chưa yêu cầu báo gap bằng attempt idempotency key. Đồng bộ với reconciliation dòng 559 và 636. |
| P4-PLAN5-LOW-001 | Cần sửa | `docs/implementation/phases/phase-04-plan.md:477`, `:482` | Câu `provenance: excerpt-only` còn tồn tại cạnh vocabulary `private-bundle-only`. Đổi câu đầu thành mô tả verification mode, tránh tạo thêm provenance value. |

## Phần 2 — Slot block

HAND-OFF: NOT_READY

Block đạt phần lớn yêu cầu trực tiếp của R28.
Hai điểm còn chặn hand-off nằm ở mapping R29 và nghĩa vụ chứng minh.

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P4-SLOT5-HIGH-001 | HIGH | `docs/implementation/phases/phase-04-plan.md:1644`, `:1989`, `:2012`, `:2023` | `fence: null` bị từ chối khi một late grant vừa commit. Đây chưa chứng minh attempt đã superseded. Activity policy lại xử lý mọi `AssuranceFencedError` như supersession. | Ghi rõ nhánh R29. Khi null-fence write gặp late grant, workflow lookup lại rồi ghi bằng fence tìm được. Giữ giới hạn hai lookups. Lookup hết retry phải audit `attempt-state-unknown` và báo gap. |
| P4-SLOT5-MED-001 | MEDIUM | `docs/implementation/phases/phase-04-plan.md:1857`, `:1954`, `:1983`; `docs/implementation/phases/phase-04-exit-criteria.md:96` | Stateful implementation được phép bỏ proof atomicity khi `failNextCommit` là null. Test unregistered terminal cũng chưa chứng minh registration trước mọi attempt-bound effect. | Bắt buộc atomicity case đạt `passed` cho stateful slots. Chỉ cho N/A với explicit stateless opt-out. Thêm composition ordering oracle cho registration trước mọi attempt-bound effect. |

R29 quy định lookup lại tại reconciliation dòng 553.
Ngoại lệ store-unreadable nằm tại dòng 559.
Không thêm `attempt-state-unknown` vào pre-lease terminal allowlist.

### Kiểm R28

| Nghĩa vụ | Kết quả | Bằng chứng |
|---|---|---|
| Money dùng `*MicroUsd` | Đạt. Mọi money field trong block đã đổi tên. | `docs/implementation/phases/phase-04-plan.md:1279`, `:1426`, `:1546` |
| Money validation | Đạt. Helper kiểm non-negative safe integer hoặc null. | `docs/implementation/phases/phase-04-plan.md:1704`, `:1744` |
| 1. Registration trước effect | Đã viết. Proof hiện mới kiểm helper từ chối unregistered attempt. | `docs/implementation/phases/phase-04-plan.md:1569`, `:1954` |
| 2. Tenant và cùng attempt-row lock | Đã viết. Fixture phải dùng acquisition thật của composition. | `docs/implementation/phases/phase-04-plan.md:1570`, `:2020` |
| 3. Durable never-leased history | Đạt ở contract và cases sau release/takeover. | `docs/implementation/phases/phase-04-plan.md:1572`, `:1984` |
| 4. Pre-lease allowlist | Đạt. Chỉ có `cancelled`, `infrastructure-failed`. | `docs/implementation/phases/phase-04-plan.md:1518`, `:1580` |
| 5. Acquisition từ chối terminal attempt | Đạt ở contract và race assertion. | `docs/implementation/phases/phase-04-plan.md:1575`, `:1983` |
| 6. Atomic terminal/idempotency/events | Đã viết. Proof vẫn có thể N/A trên stateful implementation. | `docs/implementation/phases/phase-04-plan.md:1576`, `:1857` |
| 7. Ever-leased cần caller fence | Đạt. Union và RLC-17 cùng ràng buộc. | `docs/implementation/phases/phase-04-plan.md:1561`, `:1984` |
| 8. Repair helper luôn cần fence | Đạt. Type và runtime negative fixture cùng có. | `docs/implementation/phases/phase-04-plan.md:1610`, `:1984` |
| RLC-16 | Có terminal, redelivery, scope, allowlist, atomicity và race. Atomicity còn tùy chọn. | `docs/implementation/phases/phase-04-plan.md:1983` |
| RLC-17 | Có null-fence refusal khi leased, released, taken over và repair helper. | `docs/implementation/phases/phase-04-plan.md:1984` |
| Reviewer-output union | Đạt các tổ hợp status/reference được R28 yêu cầu. | `docs/implementation/phases/phase-04-plan.md:1383`, `:1405` |
| Outcome union | Đạt mode/shadow và gating-only REPAIR/ESCALATE. | `docs/implementation/phases/phase-04-plan.md:1452`, `:1467`, `:1478` |

### Helper chạy từ chính block

Lệnh sau không tạo file:

```sh
node --no-wasm-code-gc --disable-warning=ExperimentalWarning --input-type=module -e '
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";

const md=readFileSync("docs/implementation/phases/phase-04-plan.md","utf8");
const section=md.slice(md.indexOf("### Review-loop slot contract (verbatim for S0)"));
const ts=section.split("```typescript\n")[1].split("\n```")[0];
const js=stripTypeScriptTypes(ts,{mode:"transform"});
const h=await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));

const cycle={};cycle.x=cycle;
const bad=[
 undefined,{x:undefined},{x:Infinity},{x:-Infinity},{x:NaN},{x:-0},
 {x:new Date(0)},{x:new Map()},{x:new Set()},new(class X{})(),
 [1,,3],cycle,1n,()=>1,{get x(){throw Error("getter")}},
 Object.defineProperty({},"x",{value:1}),{[Symbol()]:1},
 Object.assign([],{extra:1}),{x:[undefined]},{x:Symbol()},
 {budgetRemaining:{costMicroUsd:5000000.4}},
 {usage:{reviewCostMicroUsd:-1}},
 {cost:{modelCostMicroUsd:2**53}},
 {cost:{computeCostMicroUsd:"1"}},
 {cost:{computeCostMicroUsd:true}},
 {cost:{computeCostMicroUsd:{}}},
 {x:[{costMicroUsd:0.5}]}
];
const shared={x:1};
const good=[
 null,{},[],Object.assign(Object.create(null),{x:1}),
 {a:shared,b:shared},{x:[1,"é",true,null]},
 ...[null,0,Number.MAX_SAFE_INTEGER].map(v=>({costMicroUsd:v}))
];

let rejected=0;
for(const x of bad){
 try{h.reviewLoopPayloadBytes(x);throw Error("accepted bad")}
 catch(e){
  if(e.name==="ReviewLoopContractError"&&e.code==="invalid-payload")rejected++;
  else throw e;
 }
}
for(const x of good){
 if(h.reviewLoopPayloadBytes(x)!==Buffer.byteLength(JSON.stringify(x)))throw Error("bytes");
}
console.log("negative",rejected+"/"+bad.length,"positive",good.length+"/"+good.length);
for(const n of [65536,65537]){
 try{
  h.assertWithinReviewLoopEnvelope("boundary","a".repeat(n-2));
  console.log(n,"ACCEPT");
 }catch(e){console.log(n,e.name,e.code)}
}
'
```

Kết quả probe đã chạy:

```text
negative 27/27 positive 9/9
65536 ACCEPT
65537 ReviewLoopContractError invalid-payload
```

Block được trích có SHA-256 sau:

```text
a772194f34bc6efb84a2bc48b68b452a1958cf8c20ba9812d3062272c7340df3
```

Type-check độc lập cũng đạt.
Lệnh dùng `node --no-wasm-code-gc --input-type=module -e` với TypeScript 7.0.2 API và virtual filesystem.
API được nạp từ `typescript/dist/api/sync/api.js` của dependency worktree kế bên.
Các alias `@asep/*` trỏ vào source của snapshot đang review.

Compiler bật `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` và `noEmit`.
Block trả **0 diagnostics**.
Mười lăm negative controls trả đúng **15 diagnostics**.
Các mã gồm TS2741, TS2322, TS2554, TS2345 và TS2353.

Controls bao gồm missing/null fence, `Promise<void>`, invalid error code và pre-lease terminal ngoài allowlist.
Controls cũng kiểm status/reference, mode/shadow và tên money field cũ.
Các type tương ứng nằm tại `phase-04-plan.md:1383`, `:1452`, `:1561`, `:1598`, `:1664`.

Một số invariant vẫn cần semantic validation.
Ví dụ, `CompletedReviewerOutput.providerCalls` vẫn có type `number`, nên type cho phép giá trị 0.
RLC-06 đã yêu cầu runtime kiểm `providerCalls ≥ 1`.
(`docs/implementation/phases/phase-04-plan.md:1386`, `:1973`)

### Mapping Temporal activity

| Hạng mục | Đánh giá | Bằng chứng |
|---|---|---|
| Serialization | DTO và logical time đi qua activity input. Worker tự dựng context chứa signal và methods. | `docs/implementation/phases/phase-04-plan.md:1093`, `:1158`, `:2018` |
| Idempotency | Round có key rõ. Hai writing helpers dùng attempt identity và persisted-input comparison. | `docs/implementation/phases/phase-04-plan.md:1252`, `:1641`, `:1653` |
| Fencing | Caller truyền `leaseId`, `fencingEpoch`. Implementation không thay bằng epoch đọc từ store. | `docs/implementation/phases/phase-04-plan.md:1177` |
| Heartbeat | Khoảng gọi không quá 30 giây. Timeout activity ít nhất 60 giây. Detail không chứa source hoặc secret. | `docs/implementation/phases/phase-04-plan.md:1150`, `:1171`, `:2023` |
| Non-retryable | Các contract codes và fencing error đã có mapping. Null-fence late-grant cần nhánh R29 riêng. | `docs/implementation/phases/phase-04-plan.md:1664`, `:2023` |
| Cancellation | Signal thuộc context. Không được coi acquisition bị abort là bằng chứng lease chưa commit. | `docs/implementation/phases/phase-04-plan.md:1164`; reconciliation R29 tại dòng 553 |
| Publication | Activity retryability không thay thế remote identity reconciliation của R31. | reconciliation tại dòng 627; `docs/implementation/phases/phase-04-plan.md:2010` |

## Phần 3 — Code sau sửa

Tôi không chạy `verify:all`.
Tôi không xác nhận lời khai `620/620`.

Các lượt kiểm độc lập:

| Lượt kiểm | Kết quả | Lệnh/phạm vi |
|---|---|---|
| Pure core | 67 pass, 0 fail, 0 skipped | `node --no-wasm-code-gc --disable-warning=ExperimentalWarning --input-type=module -e` với loader RAM |
| Corpus provenance và labels | 2 pass | `evals/review-corpus/collect.test.ts:49`, `:192` |
| Corpus subprocess-failure cases | 1 pass | `collect.test.ts:356`; filesystem và Git scratch được thay bằng RAM |
| Pattern parity | 1 pass | `collect.test.ts:277`; scratch I/O được thay bằng RAM, Bash và grep vẫn chạy |
| Shell syntax | Exit 0 | `bash -n scripts/check-publication.sh` |
| Secret scan của sáu commit | Exit 0, không phát hiện leak | `gitleaks git --no-banner --redact --log-opts='7cc20f4..HEAD' .` |
| Whitespace | Exit 0 | `git diff --check 7cc20f4..HEAD` |

Pure-core loader resolve source `@asep/*` về snapshot này.
Chỉ npm dependencies được lấy từ worktree Phase 4 kế bên.
Chín file gồm policy, domain và bảy suite application assurance.

Shell probes giữ parser, grep arguments và status mapping của script.
Scratch sinks được chuyển sang RAM hoặc `/dev/null`.
Đây không phải bằng chứng chạy full publication gate nguyên trạng.
Shellcheck không có trong `command -v shellcheck`.

### Disposition

| ID | trạng thái | file:line | test và bằng chứng |
|---|---|---|---|
| P4-CODE4-HIGH-001 | RESOLVED | `packages/application/src/assurance/adjudication.ts:499` | Test tại `adjudication.test.ts:844` pass. Bỏ severity maximum làm test đỏ, còn 66/67 pass. |
| P4-CODE4-HIGH-002 | PARTIAL | `packages/application/src/assurance/checks.ts:538`, `:548`, `:583`, `:633`; `adjudication.ts:245` | Disabled-default và disabled-override đã bị chặn. Bỏ effective-rule filtering làm hai test đỏ. Alias và location handling vẫn tạo false green mới. |
| P4-CODE4-HIGH-003 | RESOLVED | `packages/application/src/assurance/adjudication.ts:426`; `findings.ts:101`; `canonical-json.ts:43` | Collision test tại `adjudication.test.ts:899` pass. Khôi phục joined identity làm test đỏ với `PROCEED` thay vì `REPAIR`. |
| P4-CODE4-MED-001 | RESOLVED | `packages/application/src/assurance/packet.ts:301`, `:309` | Final-byte tests tại `packet.test.ts:195`, `:224` pass. Mutation đo thiếu ba bytes làm ba test đỏ. Sai lệch metadata của rejected packet được ghi riêng bên dưới. |
| P4-CODE4-MED-002 | RESOLVED | `evals/review-corpus/collect.ts:626`, `:659`; `scripts/check-publication.sh:31` | Parity test tại `collect.test.ts:277` pass trong harness RAM. Giữ collector ở bốn pattern làm test đỏ sau append. Append riêng vào assignment shell cũng làm parity test đỏ. |
| P4-CODE-HIGH-003 của v3 | RESOLVED | `packages/application/src/assurance/adjudication.ts:426`, `:432` | Ground-before-merge và permutation test tại `adjudication.test.ts:226` pass. LF collision regression tại dòng 899 cũng pass. |
| P4-CODE-HIGH-005 của v3 | PARTIAL | `packages/application/src/assurance/adjudication.ts:245`; `checks.ts:633`, `:645` | Test no-recheck tại `adjudication.test.ts:561` pass. Các probe alias/location vẫn đóng prior sai. |
| P4-CODE-MED-001 của v3 | RESOLVED | `packages/application/src/assurance/adjudication.ts:489`, `:499` | Waiver, refutation và re-raise tests tại `adjudication.test.ts:717`, `:844` pass. Bỏ severity maximum làm regression đỏ. |
| P4-CODE-MED-002 của v3 | RESOLVED | `packages/application/src/assurance/packet.ts:309`; `prompt.ts:263` | Objective lớn và final-byte boundary được kiểm tại `packet.test.ts:195`, `:224`. Prompt guard cũng pass. |
| Mutation CRITICAL sống sót của v4 | RESOLVED | `packages/application/src/assurance/adjudication.ts:505`; `adjudication.test.ts:870` | Mutation loại CRITICAL khỏi blocking hiện cho 66 pass, 1 fail. Test thất bại ngay tại CRITICAL→LOW. |

### Chạy lại các probe v4

| Probe | Kết quả tại HEAD | Bằng chứng |
|---|---|---|
| HIGH→LOW re-raise | `REPAIR`; blocking severity HIGH; prior OPEN. | Probe Node RAM; `adjudication.test.ts:869` |
| CRITICAL→LOW | `REPAIR`; blocking severity CRITICAL; prior OPEN. | Probe Node RAM; `adjudication.test.ts:870` |
| CRITICAL→CRITICAL | `REPAIR`; blocking severity CRITICAL; prior OPEN. | Probe Node RAM; `adjudication.test.ts:872` |
| SARIF default disabled | `effectiveRules: []`; prior OPEN; `REPAIR`. | Probe Node RAM; `adjudication.test.ts:701` |
| SARIF override disabled | `effectiveRules: []`; prior OPEN; `REPAIR`. | Probe Node RAM; `adjudication.test.ts:703` |
| LF tuple collision và waiver | Cả hai thứ tự đều `REPAIR`. Finding chưa waived vẫn OPEN và blocking. | Probe Node RAM; `adjudication.test.ts:916` |
| Empty packet, cap 2261 | `includedBytes=2243`; actual bytes 2243; được chấp nhận. | Probe Node RAM; `packet.test.ts:226` |
| Final-byte boundary | Cap 2243 được chấp nhận. Cap 2242 bị flag. | Probe Node RAM; `packet.test.ts:224` |
| Append pattern sau assignment shell đầu | Script thấy pattern mới. Parity test đỏ vì collector không có pattern đó. | Mutation RAM của `check-publication.sh:32`; `collect.test.ts:323` |
| Append pattern vào shared list | Shell và collector cùng phát hiện fixture mới. | Probe Bash/grep RAM; `collect.test.ts:326` |

### Finding mới

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P4-CODE5-HIGH-001 | HIGH | `packages/application/src/assurance/checks.ts:633`, `:645`; `adjudication.ts:255` | Parser bỏ qua `result.ruleIndex`, `result.rule` và `artifactLocation.index`. Finding còn tồn tại có fingerprint khác. Recheck sau đó đóng prior HIGH thành VERIFIED và trả PROCEED. | Resolve các dạng reference về cùng canonical rule/location. Reference chưa resolve phải vô hiệu hóa closure proof. Thêm cross-representation regressions. |
| P4-CODE5-HIGH-002 | HIGH | `packages/application/src/assurance/checks.ts:583`; `adjudication.ts:255` | Coverage bỏ qua `uriBaseId` và `originalUriBaseIds`. Artifact thuộc checkout khác vẫn được tính là file của repaired tree. | Resolve artifact URI với base identity. Chỉ nhận coverage đã bind vào repaired repository tree. Unknown hoặc foreign base không được chứng minh closure. |
| P4-CODE5-HIGH-003 | HIGH | `scripts/check-publication.sh:62`, `:68`, `:157` | Script coi grep error như clean. Invalid ERE và grep không chạy đều cho mode mới exit 0. `set -e` không cứu nhánh này. | Phân biệt grep 0/1/error. Propagate error thành exit 2. Thêm `--` trước filename. Từ chối input không đọc được và kiểm ERE bằng execution. |
| P4-CODE5-MED-001 | MEDIUM | `scripts/check-publication.sh:55`, `:56`, `:171`; `scripts/lib/publication-leak-patterns.txt:6` | Full gate miễn toàn bộ pattern file. Comment chứa concrete private path được phép qua exemption này. | Bỏ whole-file exemption hoặc chỉ miễn các pattern lines được kiểm chặt. Scan comments và nội dung còn lại. Thêm regression cho private path trong comment. |
| P4-CODE5-LOW-001 | LOW | `packages/application/src/assurance/packet.ts:309`, `:313`; `docs/implementation/phases/phase-04-plan.md:1319` | `includedBytes` đo candidate mang `overBudget:false`. Rejected packet được lưu mang `true`, nên nhỏ hơn một byte. Slot description lại gọi đó là final bytes. | Chốt rõ candidate-size semantics cho rejected packets. Đồng bộ slot, data model và telemetry. Giữ nguyên invariant an toàn của accepted packets. |

#### P4-CODE5-HIGH-001 — Reference hợp lệ làm mất finding

Probe dùng prior HIGH, category CORRECTNESS, rule `js.eval-use`.
File là `src/feature.ts`, dòng 2.
Scanner là `semgrep` version `1.90.0`.

Run khai báo rule enabled, invocation successful và artifact coverage đúng.
Result vẫn báo cùng finding với level `warning`.

| Cách biểu diễn result | Parser | Prior | Outcome |
|---|---|---|---|
| `ruleId: "js.eval-use"` và URI trực tiếp | Giữ đúng fingerprint. | OPEN | REPAIR |
| `ruleIndex: 0` và URI trực tiếp | `ruleId: null`; fingerprint khác. | VERIFIED | PROCEED |
| `rule: { index: 0 }` và URI trực tiếp | `ruleId: null`; fingerprint khác. | VERIFIED | PROCEED |
| `ruleId` trực tiếp và `artifactLocation: { index: 0 }` | File không được resolve; fingerprint khác. | VERIFIED | PROCEED |

Các kết quả trên đến từ probe Node RAM trên `readSarif` rồi `adjudicate`.
Locus parser là `checks.ts:633`, `:645`.
Closure predicate nằm tại `adjudication.ts:255`.

Đây là false green hiện tại.
Nó không thuộc nhóm cố ý từ chối proof thiếu dữ liệu.

#### P4-CODE5-HIGH-002 — Coverage thuộc root khác vẫn được nhận

Probe dùng artifact sau:

```json
{
  "location": {
    "uri": "src/feature.ts",
    "uriBaseId": "FOREIGN"
  },
  "roles": ["analysisTarget"]
}
```

Run khai báo:

```json
{
  "originalUriBaseIds": {
    "FOREIGN": {
      "uri": "file:///other-checkout/"
    }
  }
}
```

Parser vẫn trả `scannedFiles: ["src/feature.ts"]`.
Adjudicator đóng prior thành VERIFIED và trả PROCEED.
Probe Node RAM xác nhận đường đi `checks.ts:583` → `adjudication.ts:255`.

#### Đánh giá hạn chế SARIF do lane nêu

Giữ fail-closed cho proof thiếu là quyết định đúng.
Không nên quay lại coi rule declaration là bằng chứng execution.
(`docs/implementation/phases/phase-04-plan.md:919`)

Các nhánh override/notification hiện từ chối mọi reference chứa `toolComponent`.
Log thiếu artifacts cũng không có coverage.
(`packages/application/src/assurance/checks.ts:516`, `:563`, `:575`)

Tuy nhiên, phát biểu “mọi reference có toolComponent đều fail-closed” chưa đúng.
`result.rule.toolComponent` đang bị bỏ qua.
Probe của tôi vẫn đóng prior khi result dùng dạng đó.
(`packages/application/src/assurance/checks.ts:633`; probe Node RAM)

Trước scanner thật, bắt buộc resolve reportingDescriptorReference đúng SARIF 2.1.0.
Resolver phải xử lý component identity cùng `tool.extensions`.
Unknown, ambiguous hoặc inconsistent references phải chặn closure proof.
Không chỉ sửa nhánh override tại `checks.ts:551`.

Ảnh hưởng production hiện giới hạn ở shadow verdict theo plan.
Điều này không làm kết quả VERIFIED sai trở thành hợp lệ.
(`docs/implementation/phases/phase-04-plan.md:931`)

#### Kiểm script publication

Quoting của `"$@"`, `"$file"` và `"$pat"` giữ nguyên argument boundaries.
Khoảng trắng, glob và shell metacharacters không bị shell đánh giá lại.
(`scripts/check-publication.sh:61`, `:68`, `:151`)

Filename bắt đầu bằng `-` vẫn có thể bị grep đọc như option.
Lệnh grep thiếu `--`.
(`scripts/check-publication.sh:68`)

Các shell probes cho kết quả:

| Fixture | Exit thực tế |
|---|---:|
| File sạch | 0 |
| File có path hit | 1 |
| Path không tồn tại | 2 |
| Không truyền file | 0 |
| Pattern `[` | 0 |
| Grep trả 127 | 0 |
| Pattern hiện tại cộng thêm `[` trên file sạch | 0 |
| List chỉ có comments | 2 |
| Pattern có leading/trailing whitespace | 2 |
| Pattern có CRLF | 2 |

Probe chạy bằng Bash `3.2.57`, qua `node --input-type=module -e`.
Scratch I/O được thay trong RAM.
Parser và conditional return paths được giữ nguyên.

`grep` nằm trong điều kiện `if`.
Lỗi của nó không kích hoạt `errexit`.
Mode mới tiếp tục ánh xạ kết quả đó thành clean.
(`scripts/check-publication.sh:68`, `:157`)

Full gate vẫn giữ LICENSE, history, dependency-license, delegated scanners và self-test.
Không có bước nào trong số đó bị xóa.
(`scripts/check-publication.sh:165`, `:184`, `:187`, `:190`, `:199`, `:208`, `:217`)

Tuy nhiên, whole-file exemption mới mở thêm vùng không được path-scan.
Probe xác nhận pattern file hiện không match chính bốn pattern của nó.
Grep trả exit 1 khi scan chính file đó.
Exemption toàn file hiện không cần thiết cho nội dung đang có.
(`scripts/check-publication.sh:56`; probe grep đã chạy)

Full-tree discovery còn dùng `git ls-files` dạng dòng.
Git-quoted filenames có thể bị bỏ qua vì không trỏ tới file thực.
Đây là lỗ hổng kế thừa, không phải thay đổi của sáu commit.
(`scripts/check-publication.sh:170`, `:173`, `:62`)

### Mutation không bị bắt

Mutation sau vẫn cho **67/67 pure-core tests pass**:

```diff
-    const severity = [f.severity, ...open.map((m) => m.prior.record.severity)].sort(bySeverityDescending)[0]!;
+    const severity = f.source === 'sarif' ? f.severity : [f.severity, ...open.map((m) => m.prior.record.severity)].sort(bySeverityDescending)[0]!;
```

Locus là `packages/application/src/assurance/adjudication.ts:499`.

Mutation bỏ bảo toàn severity riêng cho SARIF re-raise.
Probe prior HIGH và current MEDIUM cùng identity khi đó trả PROCEED.
Prior vẫn OPEN.
Không mutation nào được ghi xuống file.

Test tại `adjudication.test.ts:844` lẽ ra phải bắt.
Các downgrade fixtures hiện chỉ tạo model findings.
SARIF test tại dòng 628 chỉ tạo current HIGH.
Cần thêm SARIF HIGH→MEDIUM và CRITICAL→LOW.

Đánh giá bốn mutant được khai equivalent tại `dec419b`:

| Mutant | Kết luận | Bằng chứng |
|---|---|---|
| Dedupe key | Equivalent trong domain hợp lệ. | Fingerprint là fixed-length hex digest. Suffix này giữ tuple boundary không nhập nhằng. `findings.ts:206`; `check-report.ts:199` |
| Merge key | Equivalent trong domain hợp lệ. | Bucket là số không chứa LF. Delimiter cuối vẫn xác định boundary. Group iteration theo hits đã sort. `findings.ts:170` |
| Blocking-order key | **Không equivalent.** | JSON escaping thay lexical order với reviewer IDs chứa LF. `adjudication.ts:525`; `review.ts:131`, `:276` |
| `persistedIdentity` | Equivalent. | Canonical JSON của array chỉ chứa strings/null bằng `JSON.stringify` của array đó. `adjudication.ts:267`; `canonical-json.ts:18` |

Counterexample cho blocking-order mutant:

```text
raisedBy values: ["a\nz", "a/z"]

HEAD order:      ["a/z", "a\nz"]
Old joined key:  ["a\nz", "a/z"]
```

Probe Node RAM trên hai OPEN priors xác nhận khác biệt này.
Khôi phục joined blocking-order key vẫn cho 67/67 tests pass.
Test cần so thứ tự blocking records trên escaped reviewer IDs.
Không được khai mutant này equivalent chỉ vì outcome không đổi.
(`packages/application/src/assurance/adjudication.ts:523`; `adjudication.test.ts:899`)

### Ranh giới thay đổi

Lệnh sau không trả file nào:

```sh
git diff --name-only 7cc20f4..HEAD -- \
  packages/ports packages/contracts migrations adapters apps \
  packages/domain/src/operational.ts scripts/forbidden-imports.test.ts
```

Kiểm từ base `00a6889` tới HEAD cũng không thấy thay đổi các vùng cấm tương ứng.
`check-publication.sh` và shared pattern file là ngoại lệ R28 đã cho phép.

Lệnh `rg` trên policy review, domain assurance, application assurance và collector không thấy network implementation.
Không có `@temporalio`, `fetch(...)`, `process.env` hoặc imports `node:http`, `node:https`, `node:net`, `node:tls`.
URL xuất hiện trong pricing fixture tại `packages/policy/src/review.test.ts:417`.

## Kết luận

Chưa chấp nhận hand-off snapshot này.
P4-SLOT5-HIGH-001 còn mâu thuẫn trực tiếp với R29.

Code có ba HIGH cần sửa.
Hai HIGH tạo SARIF closure sai.
HIGH còn lại làm path scanner báo sạch khi không quét được.

Các fix severity, LF identity và accepted-packet budget đã có regression hiệu quả.
Shared pattern source cũng bắt được drift v4.
Các bằng chứng tương ứng nằm trong bảng disposition.

Sửa các finding chặn rồi chạy lại probes tập trung.
Controller cần kiểm lại slot mapping và proof bắt buộc trước hand-off.
`verify:all` xanh không thay thế các counterexample đã tái hiện.
