# Phase 4 — Codex Re-check v6: plan v6, slot block and code fixes (verbatim)

> Provenance: independent, read-only re-check of the LOCKED v6 plan, the verbatim slot block and the code fixes by
> Codex running `gpt-6.1-sol` through the kiro-proxy gateway, commissioned by the controller on 2026-10-30. Reviewed
> branch `phase/04-independent-assurance` at snapshot `d0907b9` (`d0907b9afecd4c8e3527874e8b9ddd435978a8dc`). Codex CLI
> 0.165.0, one uninterrupted run. Copied into the repository by the Lane B session from the controller's output file
> (sha256 of the source file: `bd98527c6c0f4e52d8e9b3204ea6492f5080a65f113a4882c0763fc8f112d6c3`). The body below is
> byte-identical to that file except for three edits required by repository gates or by the no-private-path rule:
> (1) the publication path-leak gate (`scripts/check-publication.sh`, `scripts/lib/publication-leak-patterns.txt`) —
> 5 absolute home-directory paths to the controller-owned reconciliation file are rewritten to the
> `~/.openclaw/lanes/reconciliation-v1.md` form; (2) 1 absolute path to the controller's Phase 3 review worktree is
> rewritten to `<Phase 3 review worktree at bed7a13>/`; (3) the format gate (`scripts/format-check.sh`) — a final
> newline is added. The review is in Vietnamese, as produced. Line numbers in it refer to the documents and code at
> `d0907b9`. Dispositions are recorded in `phase-04-review-log.md` ("Review v6").
>
> Controller checks at the same snapshot, on a clean detached worktree: `pnpm verify:all` exit 0; 625 tests, 625 pass,
> 0 fail, 0 skipped; 60 test files; 37 required suites. (The reviewer did not run the full gate; its own counts are in
> Part 3 below.)

---

VERDICT: REQUEST_CHANGES  confidence 0.98

## Phần 1 — Plan v6

Snapshot được kiểm là `d0907b9afecd4c8e3527874e8b9ddd435978a8dc`.
Lệnh `git rev-parse HEAD` xác nhận SHA này.
Lệnh `git status --porcelain` trả rỗng trước và sau kiểm tra.

### Disposition findings v5

`FOLDED` xác nhận tài liệu đã tiếp nhận finding.
Trạng thái này không chứng nhận implementation tương lai.

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P4-PLAN5-MED-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:2124`; `docs/implementation/phases/phase-04-exit-criteria.md:134`, `:166` | SR-A3, H4 và J6 đã ghi ngoại lệ store không đọc hoặc ghi được. Gap phải mang attempt idempotency key. |
| P4-PLAN5-LOW-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:506` | `excerpt-only` đã thành mô tả verification mode. Vocabulary provenance giữ đúng R22. |
| P4-SLOT5-HIGH-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1631`, `:1740`, `:2094`, `:2135` | Late grant dùng `lease-granted`. Recovery tối đa hai lookup đã được ghi rõ. |
| P4-SLOT5-MED-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1914`, `:1928`, `:1996`, `:2092`, `:2095` | Stateful fixture bắt buộc cung cấp atomicity hook. RLC-19 kiểm registration trước effect trên workflow Lane A. |

### Đối chiếu reconciliation

| Quyết định | Kết quả | Bằng chứng |
|---|---|---|
| R15 | Plan giữ fixed logical time và operational-event boundary. | `docs/implementation/phases/phase-04-plan.md:55`, `:851`, `:1156` |
| R16 | Slot nằm trong application. Model candidate và giới hạn gateway đã được phản ánh. | `docs/implementation/phases/phase-04-plan.md:309`, `:835`, `:1127` |
| R17 | Seam giữ budget input, cancellation và repair lineage. Workflow Phase 3 vẫn cần chứng minh integration. | `docs/implementation/phases/phase-04-plan.md:1321`, `:1328`, `:1665`, `:1762`, `:2123` |
| R18 | Resolver, ArtifactRef, shadow BLOCK và hai default slots đã có. | `docs/implementation/phases/phase-04-plan.md:1243`, `:1363`, `:1542`, `:2031` |
| R18 staging | Plan công khai các integration lines đã land sớm. Lịch sử staging chưa hoàn toàn tuân thủ. | `docs/implementation/phases/phase-04-plan.md:2427` |
| R22 | Vocabulary và bundle-dependent verification đã đồng bộ. | `docs/implementation/phases/phase-04-plan.md:506`; `evals/review-corpus/collect.test.ts:49`, `:192` |
| R23 | Helper trả JSON, nhận caller fence và phân biệt conflicting redelivery. | `docs/implementation/phases/phase-04-plan.md:1235`, `:1708`, `:1734`, `:2090`, `:2091` |
| R26 | Workaround vẫn chưa có trong snapshot này. Owner sửa thuộc Phase 2. | `docs/implementation/phases/phase-04-review-log.md:972`; `scripts/run-canonical-tests.mjs:69`; `scripts/integration/run-integration.mjs:166` |
| R28 | Money, unions và tám nghĩa vụ pre-lease đã được ghi. | `docs/implementation/phases/phase-04-plan.md:1150`, `:1457`, `:1549`, `:1620`, `:2061` |
| R29 | Recovery có hai lookup tối đa. `attempt-state-unknown` không thành pre-lease terminal. | `docs/implementation/phases/phase-04-plan.md:1570`, `:2053`, `:2135` |
| R31 | Slot chỉ trả assurance outcome. Publication reconciliation vẫn thuộc Lane A. | `docs/implementation/phases/phase-04-plan.md:2122`; `~/.openclaw/lanes/reconciliation-v1.md:627` |
| R32 | Thiết kế đã bỏ scanner closure và thêm DF-9. Implementation ingestion còn thiếu, trình bày tại Phần 3. | `docs/implementation/phases/phase-04-plan.md:379`, `:963`, `:1001` |

Các lệnh Node của review đều dùng `--no-wasm-code-gc`.
Review không chứng nhận workaround R26 đã land trong runner.

### Finding mới và đồng bộ tài liệu

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P4-PLAN6-LOW-001 | Cần đồng bộ ở commit docs kế tiếp | `docs/implementation/phases/phase-04-plan.md:1001`; `docs/implementation/phases/phase-04-architecture.md:448`; `~/.openclaw/lanes/reconciliation-v1.md:783` | R36 chấp nhận hierarchical IDs và các unresolved cases bổ sung. Plan chưa liệt kê đầy đủ. Architecture vẫn mô tả các ID phải bằng nhau. |

R36 được viết sau snapshot.
Finding này là follow-up đã được controller yêu cầu.
Nó không tự chặn hand-off slot.

Không còn chỉ dẫn hiện hành cho scanner recheck đóng SARIF finding trong Phase 4.
DF-9 và §13 quy định human-only closure.
(`docs/implementation/phases/phase-04-plan.md:379`, `:963`)

Các câu scanner closure còn lại thuộc lịch sử phiên bản.
Ví dụ, data model ghi kết quả v4 rồi ghi v6 đã từ chối đường đó.
(`docs/implementation/phases/phase-04-data-model.md:685`, `:691`, `:702`)

`check-report/v1` giữ version phù hợp R36.
Không yêu cầu bump version trước khi persist hoặc freeze S1.
(`packages/application/src/assurance/check-report.ts:19`; `~/.openclaw/lanes/reconciliation-v1.md:786`)

## Phần 2 — Slot block

HAND-OFF: READY

Kết luận này áp dụng cho hợp đồng S0.
Kit hiện chỉ có declarations, nên review chưa chứng nhận runtime của kit.
(`docs/implementation/phases/phase-04-plan.md:1972`, `:1996`; `docs/implementation/phases/phase-04-review-log.md:1248`)

### R29/R32 và nghĩa vụ conformance

| Hạng mục | Kết quả | Bằng chứng |
|---|---|---|
| Late grant khác supersession | Đạt. Null-fence refusal dùng `ReviewLoopContractError` code `lease-granted`. | `docs/implementation/phases/phase-04-plan.md:1631`, `:1735` |
| Recovery tối đa hai lookup | Đạt. Lookup dùng nhánh non-cancellable. | `docs/implementation/phases/phase-04-plan.md:2135` |
| RLC-16 | Có scope, allowlist, redelivery, atomicity và race. Race chạy trên 20 fresh subjects. | `docs/implementation/phases/phase-04-plan.md:2092` |
| RLC-17 | Có refusal khi từng leased, sau takeover và sau release. Repair helper luôn cần fence. | `docs/implementation/phases/phase-04-plan.md:2093` |
| RLC-18 | Có late grant, write bằng fence tìm được và redelivery. | `docs/implementation/phases/phase-04-plan.md:2094` |
| Stateful atomicity | Bắt buộc hook và kết quả pass. Không được N/A vì thiếu hook. | `docs/implementation/phases/phase-04-plan.md:1914`, `:1928`, `:2092` |
| RLC-19 | Lane A chạy ordering oracle trên workflow. Kit phải tự từ chối trace effect-first. | `docs/implementation/phases/phase-04-plan.md:1991`, `:2095`, `:2132` |
| SR-A3/H4/J6 | Đã ghi ngoại lệ store không đọc hoặc ghi được. Gap phải chứa attempt idempotency key. | `docs/implementation/phases/phase-04-plan.md:2124`; `docs/implementation/phases/phase-04-exit-criteria.md:134`, `:166` |
| Temporal mapping | `lease-granted` thành typed result. `AssuranceFencedError` đi nhánh supersession riêng. | `docs/implementation/phases/phase-04-plan.md:2136` |

### Finding slot mới

| ID | severity | file:line | vấn đề | thay đổi đề nghị |
|---|---|---|---|---|
| P4-SLOT6-LOW-001 | LOW | `docs/implementation/phases/phase-04-plan.md:1939`, `:2034`, `:2072` | Danh sách stateless vẫn nhắc `not-configured`. Default này lại phải persist outcome events. | Ghi rõ `NotConfiguredAssuranceSlot` có events phải dùng stateful fixture. Chỉ implementation thực sự không persist mới được opt-out. |

Quy tắc tổng quát “persists anything” đã chặn opt-out sai.
Vì vậy LOW này không chặn hand-off.
(`docs/implementation/phases/phase-04-plan.md:1914`)

Phase 3 cũng yêu cầu atomicity pass cho default slot.
(`<Phase 3 review worktree at bed7a13>/docs/implementation/phases/phase-03-exit-criteria.md:78`)

### Helper chạy từ chính text

Lệnh thực thi dùng Node type stripping và import `data:`.
Không tạo file:

```sh
node --no-wasm-code-gc --disable-warning=ExperimentalWarning --input-type=module -e '
import fs from "node:fs";
import {stripTypeScriptTypes} from "node:module";

const md=fs.readFileSync("docs/implementation/phases/phase-04-plan.md","utf8");
const fence=String.fromCharCode(96).repeat(3);
const ts=md.slice(md.indexOf("### Review-loop slot contract (verbatim for S0)"))
  .split(fence+"typescript\n")[1].split("\n"+fence)[0];
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
 try{h.reviewLoopPayloadBytes(x);throw Error("accepted bad");}
 catch(e){
  if(e.name==="ReviewLoopContractError"&&e.code==="invalid-payload")rejected++;
  else throw e;
 }
}
for(const x of good){
 if(h.reviewLoopPayloadBytes(x)!==Buffer.byteLength(JSON.stringify(x)))throw Error("bytes");
}
console.log("HELPER",rejected+"/"+bad.length,good.length+"/"+good.length);
for(const n of [65536,65537]){
 try{
  h.assertWithinReviewLoopEnvelope("boundary","a".repeat(n-2));
  console.log(n,"ACCEPT");
 }catch(e){console.log(n,e.name,e.code);}
}
'
```

Kết quả:

```text
HELPER 27/27 9/9
65536 ACCEPT
65537 ReviewLoopContractError invalid-payload
```

Block có 892 dòng.
SHA-256 tính cả newline cuối khớp review log:

```text
023f16dc7135ec32cdddffead29ad2bfd6ac3daee2918138d8b469a37943a04d
```

Lệnh hash dùng `node --input-type=module -e` trên cùng extraction.
Giá trị đối chiếu nằm tại `docs/implementation/phases/phase-04-review-log.md:1229`.

### Type-check và giới hạn type

Lệnh kiểm là `node --no-wasm-code-gc --input-type=module -e` với TypeScript 7.0.2 API.
API đọc block qua virtual filesystem và không emit.
Dependencies lấy từ worktree Phase 4 kế bên.
Các alias `@asep/*` trỏ về source snapshot đang kiểm.

Compiler bật `strict`, `noUncheckedIndexedAccess` và `exactOptionalPropertyTypes`.
Kết quả block là **0 diagnostics**.
Mười tám negative controls tạo đúng **18 diagnostics**.

Controls bao gồm fence, pre-lease terminal, output references và mode/shadow.
Ba controls mới kiểm stateful hook, stateless hook và thiếu `attemptId`.

Các range và quan hệ dữ liệu vẫn cần semantic validation.
Ví dụ, `providerCalls: 0` vẫn hợp type `CompletedReviewerOutput`.
RLC-06 đã yêu cầu từ chối tổ hợp này.
(`docs/implementation/phases/phase-04-plan.md:1435`, `:2082`)

Helper envelope không thay thế semantic validator.
Block đã nói rõ ranh giới này.
(`docs/implementation/phases/phase-04-plan.md:1824`)

Không thấy mâu thuẫn slot với R29, R31, R33 hoặc R34.
Slot không quyết định repository identity, push CAS hoặc PR reconciliation.
Những nghĩa vụ đó nằm sau assurance outcome, phía Lane A.
(`docs/implementation/phases/phase-04-plan.md:2122`; `~/.openclaw/lanes/reconciliation-v1.md:697`, `:730`)

## Phần 3 — Code sau sửa

### Phạm vi thực thi độc lập

Tôi không chạy `verify:all`.
Tôi không xác nhận lời khai `625/625`.

| Lượt kiểm | Kết quả | Lệnh/phạm vi |
|---|---|---|
| Pure-core bằng `node:test` thật | 71 pass, 0 fail, 0 skipped | `node --no-wasm-code-gc --disable-warning=ExperimentalWarning --input-type=module -e` với loader `registerHooks` |
| Corpus provenance và labels | 2 pass | Cùng loader; `evals/review-corpus/collect.test.ts:49`, `:192` |
| SARIF/reference/closure probes | Đã chạy, kết quả bên dưới | Cùng loader; gọi trực tiếp `sarifFindings` và `adjudicate` |
| Shell branches | Đã chạy bằng Bash và grep thật | `python3 -c` điều phối Bash harness không ghi scratch |
| Shell syntax | Exit 0 | `bash -n scripts/check-publication.sh` |
| Secret scan diff | Exit 0, không phát hiện leak | `gitleaks git --no-banner --redact --log-opts='fb2e432..HEAD' .` |
| Whitespace | Exit 0 | `git diff --check fb2e432..HEAD` |

Chín suite pure-core gồm policy, domain và bảy suite application assurance.
Loader chỉ chuyển TypeScript và resolve dependencies.
Lượt 71 tests cuối dùng nguyên `node:test`.

Sandbox không cho ghi scratch.
Shell harness chuyển scratch sinks và fixture filesystem sang RAM.
Parser, grep arguments, ERE execution và status mapping vẫn chạy.
Đây không phải bằng chứng chạy full publication gate nguyên trạng.

`command -v shellcheck` không tìm thấy Shellcheck.
Review không phát hành kết luận Shellcheck mới.

### Disposition

| ID | trạng thái | file:line | test chứng minh và kiểm bỏ fix |
|---|---|---|---|
| P4-CODE5-HIGH-001 | PARTIAL | `packages/application/src/assurance/checks.ts:488`, `:520`, `:573` | Bốn reference probes v5 đã đạt. Mutation bỏ resolver làm `checks.test.ts:448` đỏ. Message reference hợp lệ vẫn làm mất finding; xem HIGH-001 mới. |
| P4-CODE5-HIGH-002 | RESOLVED | `packages/application/src/assurance/checks.ts:529`, `:541`; `adjudication.ts:289` | FOREIGN được giữ và flag. Bỏ kiểm direct `uriBaseId` làm hai test đỏ, gồm `checks.test.ts:448`, `:702`. |
| P4-CODE5-HIGH-003 | RESOLVED | `scripts/check-publication.sh:59`, `:78`, `:84`, `:93`, `:102` | Probe table hiện trả đúng 0/1/2. Mutation đọc grep 127 thành clean trả 0. Assertion tại `collect.test.ts:398` sẽ đỏ. |
| P4-CODE5-MED-001 | RESOLVED | `scripts/check-publication.sh:71`, `:120` | Comment leak trong pattern list trả 1. Khôi phục exemption trả 0. Assertion tại `collect.test.ts:424` sẽ đỏ. |
| P4-CODE5-LOW-001 | RESOLVED | `packages/application/src/assurance/packet.ts:317`, `:320` | Test `packet.test.ts:251` pass. Đo lại candidate thay stored packet làm ba packet tests đỏ. |
| Mutation severity SARIF v5 | RESOLVED | `packages/application/src/assurance/adjudication.ts:464`; `adjudication.test.ts:901` | Khôi phục SARIF exemption làm regression đỏ. Probe mutant trả MEDIUM và PROCEED cho prior HIGH. |
| Mutant blocking-order v5 | RESOLVED | `packages/application/src/assurance/adjudication.ts:490`; `adjudication.test.ts:964` | Khôi phục joined key làm test đỏ. LF và `/` đổi thứ tự observable. |
| P4-CODE4-HIGH-002 | RESOLVED theo R32 | `packages/application/src/assurance/adjudication.ts:289`; `packages/domain/src/assurance.ts:63` | Scanner-proof feature đã bị bỏ. Test tại `adjudication.test.ts:633` giữ prior OPEN dù log khai sạch. Khôi phục closure làm test đỏ. |
| P4-CODE-HIGH-005 | RESOLVED cho lỗi v3 | `packages/application/src/assurance/adjudication.ts:289`, `:480`; `adjudication.test.ts:579` | Prior SARIF vẫn blocking khi không được báo lại. Mutation đóng SARIF làm bốn adjudication tests đỏ. |

Domain cũng chặn scanner verification trực tiếp.
Khôi phục `harnessVerifies['scanner-recheck']='sarif'` làm test tại `assurance.test.ts:242` đỏ.
Kết quả mutation là 6 pass, 1 fail.

### Chạy lại probes v5

Probe dùng `semgrep` version `1.90.0`, rule `js.eval-use`, file `src/feature.ts:2`.
Round limit được tăng để thấy `REPAIR`, thay vì escalation do hết vòng.

| Probe | Kết quả tại HEAD |
|---|---|
| `ruleId` và URI trực tiếp | Fingerprint chuẩn; không flag; prior OPEN; REPAIR. |
| `ruleIndex: 0` và URI trực tiếp | Cùng fingerprint; không flag; prior OPEN; REPAIR. |
| `rule: { index: 0 }` và URI trực tiếp | Cùng fingerprint; không flag; prior OPEN; REPAIR. |
| `ruleId` và `artifactLocation: { index: 0 }` | Cùng fingerprint; không flag; prior OPEN; REPAIR. |
| `rule: { id: ... }` và URI trực tiếp | Cùng fingerprint; không flag; prior OPEN; REPAIR. |
| `uriBaseId: FOREIGN` trỏ checkout khác | Giữ finding SARIF; file null; flag true; prior OPEN; REPAIR. |
| Empty packet, cap 2261 | Được nhận; stored bytes và `includedBytes` đều 2243. |
| Empty packet, cap 2243 | Được nhận; stored bytes và `includedBytes` đều 2243. |
| Empty packet, cap 2242 | Bị flag; stored bytes và `includedBytes` đều 2242. |

Các probes gọi code tại `checks.ts:488`, `:520`, `adjudication.ts:289` và `packet.ts:313`.
Regressions tương ứng nằm tại `checks.test.ts:448` và `packet.test.ts:225`.

### Finding mới

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P4-CODE6-HIGH-001 | HIGH | `packages/application/src/assurance/checks.ts:573`, `:632`; `adjudication.ts:275` | SARIF hợp lệ dùng `message.id` bị đổi thành một finding deterministic. Một result như vậy còn xóa các SARIF findings đã parse trước đó. Vòng sạch sau đóng diagnostic bằng deterministic recheck. | Resolve message reference hoặc giữ từng result dưới source SARIF. Reference chưa resolve phải được flag. Không thay toàn bộ results bằng diagnostic có thể tự đóng. |
| P4-CODE6-HIGH-002 | HIGH | `packages/application/src/assurance/checks.ts:575`, `:619` | Khi result không ghi `level`, parser luôn chọn warning. Nó bỏ severity kế thừa từ rule configuration. Probe rule mặc định error trả MEDIUM và PROCEED. | Tính effective level theo SARIF trước fallback. Thêm fixture omitted-level/error và kiểm outcome. Không âm thầm chuyển severity chưa xác định thành non-blocking. |
| P4-CODE6-MED-001 | MEDIUM | `packages/domain/src/assurance.ts:226`; `docs/implementation/phases/phase-04-data-model.md:475` | Machine vẫn refute được SARIF aggregate có `grounded:false`. Human-only closure chưa được chặn cho mọi non-blocking transition. | Chặn machine refutation của source SARIF tại domain. Đồng bộ DDL dự kiến và thêm negative test. |
| P4-CODE6-MED-002 | MEDIUM | `packages/application/src/assurance/checks.ts:493`; `checks.test.ts:495` | `rule:null` bị coi như không có rule object. Finding không flag và có thể hưởng waiver của prior. R36 đã yêu cầu flag non-object rule. | Phân biệt absent với null. Flag null và thêm các R36 fixtures còn thiếu. |

#### HIGH-001 — Message reference làm mất source và closure authority

Fixture hợp lệ dùng message string đã khai báo:

```json
{
  "version": "2.1.0",
  "runs": [{
    "tool": {
      "driver": {
        "name": "semgrep",
        "rules": [{
          "id": "js.eval-use",
          "messageStrings": {
            "M": { "text": "eval() on user input" }
          }
        }]
      }
    },
    "results": [{
      "ruleId": "js.eval-use",
      "level": "error",
      "message": { "id": "M" }
    }]
  }]
}
```

Probe Node gọi `sarifFindings` trả:

```text
source: deterministic
ruleId: sarif-malformed
severity: HIGH
unresolvedReference: false
```

Parser đòi `message.text`, rồi catch ở cấp toàn log.
(`packages/application/src/assurance/checks.ts:573`, `:632`)

Probe mixed log có hai results cũng chỉ trả một diagnostic.
Không result nào còn source SARIF.

Probe vòng sau đưa diagnostic này thành OPEN prior.
Checks sạch sau đó trả:

```text
effectiveState: VERIFIED
rule: deterministic-recheck
outcome: PROCEED
```

Đây là đường đổi nguồn finding trước khi áp dụng human-only guard.
Nó không phải đường `scanner-recheck` cũ.
(`packages/application/src/assurance/adjudication.ts:275`)

#### HIGH-002 — Severity kế thừa bị hạ

Probe dùng rule sau và bỏ `result.level`:

```json
{
  "id": "js.eval-use",
  "defaultConfiguration": { "level": "error" }
}
```

Probe Node trả:

```text
severity: MEDIUM
source: sarif
unresolvedReference: false
outcome: PROCEED
blocking: []
```

Parser chưa tính effective level theo SARIF §3.27.10.
Nó fallback trực tiếp sang warning.
(`packages/application/src/assurance/checks.ts:575`)

Fix bảo toàn severity giữa các vòng không cứu finding được ingest lần đầu.
(`packages/application/src/assurance/adjudication.ts:454`, `:464`)

#### MED-001 — Domain guard chưa bao phủ mọi closure

Probe tạo aggregate hợp type:

```text
source=sarif
raisedBy=sarif:semgrep
grounded=false
state=OPEN
```

`citation-unresolvable` với `REJECTED_WITH_EVIDENCE` trả `REFUTED`.
`isLifecycleBlocking` trả false.
(`packages/domain/src/assurance.ts:226`, `:284`)

Ingestion hiện đánh dấu check findings là grounded.
Vì vậy probe này chứng minh lỗ hở domain, không chứng minh đường production đang gọi nó.
(`packages/application/src/assurance/adjudication.ts:364`)

Guard `RESOLUTION_VERIFIED` đã đúng.
Guard machine refutation vẫn thiếu điều kiện source.
(`packages/domain/src/assurance.ts:226`, `:230`)

#### MED-002 — Null rule được link sai

Probe `rule:null` cùng `ruleId` trực tiếp trả:

```text
unresolvedReference: false
sameFingerprintAsResolvedFinding: true
```

Khi prior đang WAIVED, adjudication trả:

```text
outcome: PROCEED
current.priorFindingId: prior-waived
current.lifecycleState: WAIVED
current.blocking: false
```

Đây là malformed-reference case, không phải SARIF hợp lệ.
R36 yêu cầu giữ và flag nhóm non-object rule.
(`~/.openclaw/lanes/reconciliation-v1.md:783`)

### Closure và ingestion

Với finding đã được lưu đúng source SARIF, model không verify được.
Scanner output và deterministic recheck cũng không verify được.
(`packages/domain/src/assurance.ts:214`, `:230`; `packages/application/src/assurance/adjudication.ts:289`)

Hai ngoại lệ còn lại đã được tái hiện.
Message reference bị đổi source trước adjudication.
Ungrounded SARIF aggregate vẫn được machine refute.

Bốn reference forms v5 không còn đổi fingerprint âm thầm.
FOREIGN không còn được coi là repaired-tree location.
(`packages/application/src/assurance/checks.test.ts:473`, `:507`)

Ingestion chưa đạt yêu cầu “không mất finding”.
HIGH-001 là counterexample trên SARIF hợp lệ.
MED-002 là counterexample đối với unresolved handling của R36.

### Publication scanner

Các probes dưới đây dùng Bash `3.2.57`.
Grep thực thi ERE thật.
Fixture reads và scratch sinks được thay trong RAM.

| Fixture/nhánh | Exit |
|---|---:|
| File sạch | 0 |
| File có private-path hit | 1 |
| Path không tồn tại | 2 |
| Không truyền file | 2 |
| Directory | 2 |
| File không đọc được | 2 |
| Filename `-v` có hit | 1 |
| Filename literal `--` có hit | 1 |
| Filename chứa khoảng trắng có hit | 1 |
| Filename chứa newline có hit | 1 |
| Grep file-scan trả 2 | 2 |
| Grep file-scan trả 127 | 2 |
| Pattern chỉ có `[` | 2 |
| List hiện tại cộng thêm `[` | 2 |
| List chỉ có comments | 2 |
| Pattern có leading whitespace | 2 |
| Pattern có trailing whitespace | 2 |
| Pattern CRLF | 2 |
| Pattern file không đọc được | 2 |
| Không tạo được scratch | 2 |
| Tracked tree sạch, gồm pattern file | 0 |
| Private path trong comment pattern file | 1 |
| Tracked filenames chứa khoảng trắng/newline | 1 |
| `git ls-files -z` thất bại | 2 |
| Tracked file bị thiếu trong worktree | 2 |
| Self-test bắt canary | 0 |
| Self-test không bắt canary | 1 |
| Self-test gặp grep file-scan error | 1 |
| Invalid pattern trước self-test | 2 |

Các nhánh tương ứng nằm tại `scripts/check-publication.sh:37`, `:73`, `:114`, `:144`, `:207`.

Script truyền `--` cho grep đúng vị trí.
(`scripts/check-publication.sh:61`, `:93`)

CLI không khai báo optional sentinel sau `--scan-paths`.
Lệnh dạng `--scan-paths -- clean.txt` coi `--` là filename.
Probe này trả 2 khi file literal `--` không tồn tại.
(`scripts/check-publication.sh:213`)

Pattern file không còn được miễn.
Mutation khôi phục exemption làm probe comment leak trả 0.
(`scripts/check-publication.sh:71`; `evals/review-corpus/collect.test.ts:424`)

Không thấy full gate yếu đi so với `00a6889`.
Diff giữ LICENSE, history scan, dependency-license, delegated scanners và self-test.
Path scanner đã mạnh hơn về lỗi và filename discovery.

Bằng chứng đối chiếu là:

```sh
git diff 00a6889..HEAD -- scripts/check-publication.sh
bash -n scripts/check-publication.sh
```

Full gate vẫn có status handling cũ trong history-secret scan.
Phần này không được commit sửa thay đổi.
Review không chứng nhận full gate hoàn toàn fail-closed.
(`scripts/check-publication.sh:182`)

### Mutation không bị bắt

Mutation RAM sau vẫn cho **71/71 tests pass**:

```diff
-  if (!isRecord(rule)) return fail('result.rule is not an object');
+  if (!isRecord(rule)) return null;
```

Locus là `packages/application/src/assurance/checks.ts:494`.

Mutation bỏ flag cho non-object rule.
Nó không đổi type signature.
Bộ tests hiện không phát hiện mất flag này.

Lệnh chạy dùng `REVIEW_MUTATION=nonobject-rule` với loader RAM.
Lượt xác nhận cuối dùng `node:test` thật.
Node trả exit 0, pass 71, fail 0.

Test cần thêm fixture `rule:7`, `rule:[]` và `rule:null`.
Các fixture phải kiểm source, flag, fingerprint và refusal link prior.
(`packages/application/src/assurance/checks.test.ts:495`)

Các mutation v5 severity và blocking-order đã bị bắt.
Mutation mới trên chứng minh coverage R36 vẫn thiếu.

### Regression và ranh giới

Hai HIGH mới là lỗi tồn dư, không phải regression được commit v6 tạo ra.
Baseline v5 đã đòi `message.text` và fallback warning.

Lệnh đối chiếu:

```sh
git show fb2e432:packages/application/src/assurance/checks.ts
git show fb2e432:packages/domain/src/assurance.ts
```

Các locus baseline là `checks.ts:629`, `:631` và `assurance.ts:232`.
R32 làm các đường này không còn đáp ứng hợp đồng đã khóa.

Không thấy thay đổi ở các vùng cấm.
Hai lệnh sau đều không trả file:

```sh
git diff --name-only fb2e432..HEAD -- \
  packages/ports packages/contracts adapters apps workers \
  packages/domain/src/operational.ts scripts/forbidden-imports.test.ts

git diff --name-only 00a6889..HEAD -- \
  packages/ports packages/contracts adapters apps workers \
  packages/domain/src/operational.ts scripts/forbidden-imports.test.ts
```

`check-publication.sh` và pattern file nằm trong ngoại lệ R28.

Lệnh `rg` trên source TypeScript được review không thấy network implementation.
Không có `@temporalio`, `fetch(...)`, `process.env` hoặc imports mạng trong phạm vi đó.

```sh
rg -n '@temporalio|fetch\s*\(|process\.env|node:(http|https|net|tls)|https?\.request' \
  --glob '*.ts' \
  packages/policy/src/review.ts \
  packages/domain/src/assurance.ts \
  packages/application/src/assurance \
  evals/review-corpus
```

Corpus blobs có code lịch sử chứa network và environment access.
Chúng là dữ liệu excerpt, không phải implementation mới.

CodeGraph và Semantic Context không khả dụng trong worktree.
Lệnh kiểm `.codegraph` và `.graphify-out` không tìm thấy hai thư mục.

## Kết luận

**Slot contract đủ sẵn sàng hand-off sang S0.**
Các blocker slot v5 đã được folded.
Runtime conformance vẫn phải được Lane A thực thi.
(`docs/implementation/phases/phase-04-plan.md:2092`, `:2095`, `:2132`)

**Chưa chấp nhận toàn bộ pure-core pre-S0.**
HIGH-001 làm mất SARIF finding và đổi closure authority.
HIGH-002 tạo `PROCEED` từ severity bị hạ khi ingestion.

Sửa hai HIGH và bổ sung regression trước khi chấp nhận.
Đồng thời khóa domain refutation và unresolved-null handling.

Không tuyên bố các slice hoàn chỉnh đã được chấp nhận.
Plan yêu cầu cả pure core và integration cùng đạt.
(`docs/implementation/phases/phase-04-plan.md:2414`)
