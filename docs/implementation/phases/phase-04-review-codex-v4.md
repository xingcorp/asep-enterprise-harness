# Phase 4 — Codex Re-check v4: plan v4, slot block and code fixes (verbatim)

> Provenance: independent, read-only re-check of the LOCKED v4 plan, the verbatim slot block and the code fixes by
> Codex running `gpt-6.1-sol` through the kiro-proxy gateway, commissioned by the controller on 2026-10-29. Reviewed
> branch `phase/04-independent-assurance` at snapshot `7cc20f4` (`7cc20f474ef0d53532ff386777eae7d5d07dae24`). Codex CLI
> 0.165.0, one uninterrupted run. Copied into the repository by the Lane B session from the controller's output file
> (sha256 of the source file: `43fb17d78585044fc327f6eb34383f576e175b28a957fd06edefac93cc55605a`). The body below is
> byte-identical to that file except for two edits required by repository gates: (1) the path-leak scan of
> `scripts/check-publication.sh` and the PII gate — the 9 absolute references to the controller's lane directory, which
> carry a home-directory path, are written `~/.openclaw/lanes/…` instead; (2) the format gate
> (`scripts/format-check.sh`) — a final newline is added. The review is in Vietnamese, as produced. Line numbers in it
> refer to the documents and code at `7cc20f4`. Dispositions are recorded in `phase-04-review-log.md` ("Review v4").
>
> Controller gate at the same snapshot, on a clean detached worktree: `pnpm verify:all` run twice, each exit 0; 613
> tests, 613 pass, 0 fail, 0 skipped; 60 test files; 37 required suites. (The reviewer did not run the full gate; its
> own counts are in Part 3 below.)

---

VERDICT: REQUEST_CHANGES  confidence 0.99

## Phần 1 — Plan v4

`FOLDED` xác nhận finding đã vào thiết kế.
Trạng thái này không chứng nhận implementation hoặc integration.

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P4-PLAN3-MED-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:451`, `:590`; `evals/review-corpus/collect.ts:39`, `:750` | Vocabulary R22 đã thống nhất. Plan yêu cầu đếm bundle dependence và loại item thiếu location tại freeze. |
| P4-PLAN3-MED-002 | FOLDED | `docs/implementation/phases/phase-04-plan.md:530`, `:617`, `:2093` | Recipe và staging cùng dùng `{ verdict: 'NOT_RECORDED', environment: null, checks: [] }`. Golden round-trip vẫn thuộc S20. |
| P4-PLAN3-MED-003 | FOLDED | `docs/implementation/phases/phase-04-plan.md:859`; `docs/implementation/phases/phase-04-architecture.md:425` | Hai tài liệu đã cùng dùng added-line predicate và deletion-only exception của R23. |
| P4-SLOT-MED-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1489`, `:1627`, `:1764` | Method trả `Promise<null>`. Disabled slot cũng trả `null`. |
| P4-SLOT-MED-002 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1554`, `:1591`, `:1757` | Helper kiểm plain JSON đệ quy trước khi đo. Probe độc lập xác nhận các fixture bên dưới. |
| P4-SLOT-MED-003 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1111`, `:1429`, `:1455`, `:1773` | Hai helper có caller fence. Transaction, terminal-before-release và conflicting redelivery đã được quy định. |

Đối chiếu reconciliation:

| Quyết định | Đánh giá | Bằng chứng |
|---|---|---|
| R15 | Fixed logical time và operational event boundary đã được ghi đúng. | `docs/implementation/phases/phase-04-plan.md:772`, `:918`, `:1040`, `:1767` |
| R16 | Slot nằm trong application. Primary model và giới hạn “via this gateway” đã được cập nhật. | `docs/implementation/phases/phase-04-plan.md:252`, `:762`, `:1017` |
| R17 | Seam hỗ trợ cancellation và repair lineage. Chưa có bằng chứng Phase 3 thực thi đầy đủ reservation, inspect-only và publication reconciliation. | `docs/implementation/phases/phase-04-plan.md:1096`, `:1193`, `:1355`, `:1763`; `~/.openclaw/lanes/reconciliation-v1.md:173` |
| R18 | Workspace resolver, ArtifactRef, shadow BLOCK, default slots và dependency DAG đã được phản ánh. | `docs/implementation/phases/phase-04-plan.md:971`, `:1244`, `:1366`, `:1736`, `:2127` |
| R18 staging | Ngoại lệ landing sớm vẫn được khai báo. Không thể gọi lịch sử staging là tuân thủ hoàn toàn. | `docs/implementation/phases/phase-04-plan.md:2095` |
| R22 | Vocabulary và freeze rules đã được đồng bộ. Collection chưa được coi là corpus đã freeze. | `docs/implementation/phases/phase-04-plan.md:451`, `:458`, `:590`; `evals/review-corpus/collect.ts:755` |
| R23 | Ba sửa slot đã vào block. Scanner proof và packet-byte boundary còn lệch, như hai finding dưới đây. | `docs/implementation/phases/phase-04-plan.md:648`, `:871`; `~/.openclaw/lanes/reconciliation-v1.md:365`, `:377` |

Các finding mới của plan:

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P4-PLAN4-HIGH-001 | Cần sửa | `docs/implementation/phases/phase-04-plan.md:874`; `docs/implementation/phases/phase-04-architecture.md:435` | Plan coi rule được **khai báo** trong SARIF là bằng chứng rule đã chạy. R23 yêu cầu rule thực sự chạy thành công. Rule bị disable vẫn đạt predicate hiện tại. Counterexample nằm ở P4-CODE4-HIGH-002. |
| P4-PLAN4-MED-001 | Cần sửa | `docs/implementation/phases/phase-04-plan.md:648`; `docs/implementation/phases/phase-04-data-model.md:71` | Plan đo packet sau khi zero hai field budget. R23 yêu cầu byte length của canonical serialized packet thực tế. Sai biên đã được tái hiện tại P4-CODE4-MED-001. |
| P4-PLAN4-MED-002 | Cần sửa | `docs/implementation/phases/phase-04-plan.md:655`; `docs/implementation/phases/phase-04-data-model.md:261` | Plan yêu cầu persist failure reason `prompt-over-budget`. DDL không cho phép giá trị này. Cần đồng bộ enum và thêm persistence regression. |

Mâu thuẫn mới khác nằm ở telemetry.
Block loại terminal trước lease khỏi helper.
SR-A3 và exit H4 vẫn yêu cầu ghi mọi terminal.
(`docs/implementation/phases/phase-04-plan.md:1427`, `:1796`; `docs/implementation/phases/phase-04-exit-criteria.md:132`)

## Phần 2 — Slot block

HAND-OFF: NOT_READY

Ba finding slot v3 đã được sửa đúng phần yêu cầu trực tiếp của R23.

- `recordAttemptOutcome` trả JSON `null`. (`docs/implementation/phases/phase-04-plan.md:1489`)
- Helper kiểm recursive plain JSON trước `JSON.stringify`. (`docs/implementation/phases/phase-04-plan.md:1595`)
- Hai helper ghi nhận caller fence trong transaction ghi. (`docs/implementation/phases/phase-04-plan.md:1111`, `:1773`)
- Terminal được ghi trước lease release. (`docs/implementation/phases/phase-04-plan.md:1424`, `:1483`)
- Redelivery giống trả stored output và không ghi thêm. Payload khác gây `conflicting-redelivery`. (`docs/implementation/phases/phase-04-plan.md:1771`)
- Caller stale bị fence trước khi so payload. (`docs/implementation/phases/phase-04-plan.md:1773`)

Đây là đánh giá contract.
Các helper và conformance runner vẫn là declaration chờ S0.
(`docs/implementation/phases/phase-04-plan.md:1009`, `:1700`)

### Probe helper từ chính block

Tôi chạy lệnh sau bằng Node `v24.6.0`.
Lệnh không tạo file.

```sh
node --disable-warning=ExperimentalWarning --input-type=module -e '
import {readFileSync} from "node:fs";
import {stripTypeScriptTypes} from "node:module";
const md=readFileSync("docs/implementation/phases/phase-04-plan.md","utf8");
const section=md.slice(md.indexOf("### Review-loop slot contract (verbatim for S0)"));
const ts=section.split("```typescript\n")[1].split("\n```")[0];
const js=stripTypeScriptTypes(ts,{mode:"transform"});
const h=await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));
const cycle={};cycle.x=cycle;
const bad=[undefined,{x:undefined},{x:Infinity},{x:-Infinity},{x:NaN},{x:-0},
 {x:new Date(0)},{x:new Map()},{x:new Set()},new(class X{})(),[1,,3],cycle,
 1n,()=>1,{get x(){throw Error("getter");}},Object.defineProperty({},"x",{value:1}),
 {[Symbol()]:1},Object.assign([],{extra:1})];
let rejected=0;
for(const x of bad){try{h.reviewLoopPayloadBytes(x);}catch(e){
 if(e.name==="ReviewLoopContractError"&&e.code==="invalid-payload")rejected++;else throw e;}}
const shared={x:1};
const good=[null,{},[],Object.assign(Object.create(null),{x:1}),{a:shared,b:shared},{x:[1,"é",true,null]}];
for(const x of good)if(h.reviewLoopPayloadBytes(x)!==Buffer.byteLength(JSON.stringify(x)))throw Error("bytes");
console.log("negative",rejected+"/"+bad.length,"positive",good.length+"/"+good.length);
for(const n of [65536,65537]){try{h.assertWithinReviewLoopEnvelope("boundary","a".repeat(n-2));
 console.log(n,"ACCEPT");}catch(e){console.log(n,e.name,e.code);}}
'
```

Kết quả:

```text
negative 18/18 positive 6/6
65536 ACCEPT
65537 ReviewLoopContractError invalid-payload
```

Một probe bổ sung cũng từ chối nested undefined, undefined array element và symbol value.
Các giá trị hợp lệ có byte count bằng `Buffer.byteLength(JSON.stringify(value))`.
(`docs/implementation/phases/phase-04-plan.md:1554`; lệnh Node probe helper đã chạy)

### Finding mới của slot

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P4-SLOT4-MED-001 | MEDIUM | `docs/implementation/phases/phase-04-plan.md:1209`, `:1321`, `:1417` | Seam vẫn dùng USD dạng `number`, thiếu conversion contract sang integer micro-USD của Phase 3. | Chốt đơn vị, rounding, null semantics và bounds trước S0. Khuyến nghị dùng các field `*MicroUsd` tại seam. |
| P4-SLOT4-MED-002 | MEDIUM | `docs/implementation/phases/phase-04-plan.md:1427`, `:1796`; `docs/implementation/phases/phase-04-risk-register.md:47` | Terminal trước lease bị bỏ khỏi slot, trái nghĩa vụ ghi mọi terminal. “Lane A tự audit” chưa có contract bảo đảm cùng event semantics. | Controller chốt ngoại lệ trước hand-off. Đồng bộ block, SR-A3, H4 và conformance cases. |

**Về tiền:** nên đổi block sang integer micro-USD trước freeze.

R21 yêu cầu integer arithmetic và ceiling cho usage.
R24 cấm clamp usage trước khi kiểm overrun.
(`~/.openclaw/lanes/reconciliation-v1.md:289`, `:406`)

Các field cần chốt cùng nhau gồm:

- `budgetRemaining.costUsd`. (`docs/implementation/phases/phase-04-plan.md:1209`)
- `AssuranceUsage.reviewCostUsd`. (`docs/implementation/phases/phase-04-plan.md:1321`)
- `modelCostUsd` và `computeCostUsd`. (`docs/implementation/phases/phase-04-plan.md:1417`)

`number` vẫn có thể chứa integer micro-USD.
Runtime phải kiểm non-negative safe integer và giữ `null` là unknown.

R21 không tự cấm USD phục vụ hiển thị.
Nếu giữ USD cho telemetry, block phải cấm dùng trực tiếp giá trị đó trong budget arithmetic.
Mapper phải quy định conversion chính xác.
Hiện block chưa có các quy tắc này.
(`docs/implementation/phases/phase-04-plan.md:1208`, `:1416`)

Rủi ro gồm double conversion, rounding-away overrun và redelivery conflict do hai mapper tạo số khác nhau.
Boundary `5.0000004` trên cap `5` phải vẫn là overrun.
(`~/.openclaw/lanes/reconciliation-v1.md:289`)

**Về PR4-37:** phương án controller đề xuất tốt hơn hiện trạng để gap telemetry.

Phương án chỉ an toàn khi có đủ các điều kiện sau:

1. Attempt đã được đăng ký thành công trước mọi attempt-bound effect. (`~/.openclaw/lanes/reconciliation-v1.md:304`)
2. Transaction kiểm tenant và khóa cùng attempt row dùng cho lease acquisition.
3. `fence: null` chỉ hợp lệ khi attempt **chưa từng** có lease.
4. Adapter kiểm lịch sử bền vững, không chỉ kiểm “hiện không có ACTIVE lease”.
5. Controller chốt allowlist terminal thực sự có thể xảy ra trước lease.
6. Lease acquisition từ chối attempt đã terminal trong cùng cơ chế khóa.
7. Transaction ghi terminal, idempotency record và events atomically.
8. Attempt từng có lease vẫn bắt buộc trình caller fence.
9. `buildRepairContextPack` luôn giữ fence bắt buộc.

Các điều kiện trên đóng gap mà không cho zombie bỏ fence.
Chúng mở rộng ngoại lệ của R23, nên controller phải ghi reconciliation mới.
(`~/.openclaw/lanes/reconciliation-v1.md:338`; `docs/implementation/phases/phase-04-plan.md:1047`)

Conformance cần thêm race giữa terminal-before-lease và lease acquisition.
Conformance cũng cần từ chối null fence sau release hoặc takeover.
RLC-14 hiện chỉ bao phủ caller có fence.
(`docs/implementation/phases/phase-04-plan.md:1770`)

### Mapping sang Temporal activity

| Hạng mục | Mapping cần giữ | Bằng chứng |
|---|---|---|
| Serialization | Serialize DTO và logical time. Tạo `AssuranceStepContext` tại activity worker; không serialize `AbortSignal` hoặc methods. | `docs/implementation/phases/phase-04-plan.md:1091`, `:1802` |
| Idempotency | Round dùng `${attemptId}:assurance:${round}`. Hai helper dùng attempt identity và persisted payload comparison. | `docs/implementation/phases/phase-04-plan.md:1185`, `:1483`, `:1495` |
| Fencing | Truyền caller `leaseId` và `fencingEpoch`. Không lấy epoch hiện tại làm caller identity. | `docs/implementation/phases/phase-04-plan.md:1111` |
| Heartbeat | Gọi tối đa mỗi 30 giây. Activity heartbeat timeout ít nhất 60 giây. Không đưa source hoặc secret vào detail. | `docs/implementation/phases/phase-04-plan.md:1083`, `:1104`, `:1804` |
| Non-retryable | Map mọi `ReviewLoopContractError.code` và `AssuranceFencedError` thành non-retryable failure tương ứng. Giữ riêng `conflicting-redelivery`. | `docs/implementation/phases/phase-04-plan.md:1507`, `:1519`, `:1804` |
| Cancellation | Nối activity cancellation vào `ctx.signal`. Không biến task đã cancel thành retry nghiệp vụ mới. | `docs/implementation/phases/phase-04-plan.md:1097`, `:1537`; `~/.openclaw/lanes/reconciliation-v1.md:190` |
| Publication | Phase 3 phải giữ effect certainty độc lập với retryability. Fencing error không chứng minh remote effect bằng `none`. | `~/.openclaw/lanes/reconciliation-v1.md:398` |

Một số type vẫn cho phép tổ hợp sai nghiệp vụ.

`RunReviewerOutput` cho phép `COMPLETED_VALID` đi cùng `reviewRecordRef: null`.
Comment cấm tổ hợp đó, nhưng type chưa cấm.
(`docs/implementation/phases/phase-04-plan.md:1293`)

Outcome types cũng cho phép mode và shadow không nhất quán.
RLC-06 đã yêu cầu runtime validation cho phần này.
(`docs/implementation/phases/phase-04-plan.md:1331`, `:1762`)

Nên dùng discriminated unions và thêm negative fixtures cho reviewer output.
Envelope validation chỉ kiểm JSON, không thay thế semantic validation.
(`docs/implementation/phases/phase-04-plan.md:1554`, `:1773`)

## Phần 3 — Code sau sửa

Tôi không xác nhận số `613/613`.

Tôi chạy chín file pure-core bằng Node loader trong RAM.
Kết quả là **61 pass, 0 fail, 0 skipped**.
Nguồn `@asep/*` được resolve về snapshot này.

Loader chỉ lấy npm dependency từ worktree Phase 4 kế bên.
Lệnh dùng `node --disable-warning=ExperimentalWarning --input-type=module -e`.
Các file gồm `review.test.ts`, `assurance.test.ts` và bảy suite trong application assurance.

Hai test corpus đọc provenance và labels cũng đạt **2 pass, 0 fail**.
(`evals/review-corpus/collect.test.ts:45`, `:188`)

Test scanner failure đạt **1 pass** với filesystem và Git được stub trong RAM.
Tôi không chạy phần tạo temporary repository hoặc scanner shell thật.
(`evals/review-corpus/collect.test.ts:273`; `evals/review-corpus/collect.ts:653`)

`verify:all` không được chạy.
Script đó xóa build outputs.
(`scripts/verify-all.sh:72`)

### Disposition v3

| ID | trạng thái | file:line | test và bằng chứng |
|---|---|---|---|
| P4-CODE-HIGH-001 | RESOLVED | `packages/policy/src/review.ts:525`, `:549` | `egress.test.ts:150` chặn LF trước gateway. Restore policy trước `a18ef50` trong RAM làm test đỏ. `review.test.ts:283` cũng đỏ. |
| P4-CODE-HIGH-002 | RESOLVED | `packages/application/src/assurance/egress.ts:100`; `diff.ts:117` | `egress.test.ts:210` kiểm rename, copy, delete và delta-only paths. Restore egress trước `2f814b5` làm test đỏ với `CLEAR` thay vì `STOP_CLASSIFIED`. |
| P4-CODE-HIGH-003 | PARTIAL | `packages/application/src/assurance/adjudication.ts:424`, `:429` | `adjudication.test.ts:226` bắt permutation và grounding-before-merge. Bỏ conservative selection làm test đỏ. Identity encoding vẫn collision tại P4-CODE4-HIGH-003. |
| P4-CODE-HIGH-004 | RESOLVED | `packages/application/src/assurance/grounding.ts:107`, `:125` | `grounding.test.ts:141` và `adjudication.test.ts:455` kiểm context sát added line. Restore hunk-range predicate làm test đỏ. |
| P4-CODE-HIGH-005 | PARTIAL | `packages/application/src/assurance/adjudication.ts:244`, `:314`, `:510` | Không recheck thì prior tiếp tục block. Bỏ SARIF prior khỏi blocking làm `adjudication.test.ts:561` đỏ. Proof mới vẫn sai khi rule bị disable. |
| P4-CODE-HIGH-006 | RESOLVED | `evals/review-corpus/collect.ts:683` | `collect.test.ts:273` bắt crash, ENOENT, status 2 và findings không có excerpt. Bỏ refusal branches trong RAM làm test đỏ. Scanner shell thực chưa được chạy trong audit này. |
| P4-CODE-MED-001 | PARTIAL | `packages/application/src/assurance/adjudication.ts:483`, `:499` | Waiver probe đã đúng. Bỏ waiver shielding làm `adjudication.test.ts:647` đỏ. Reconciliation mới lại cho LOW che prior HIGH. |
| P4-CODE-MED-002 | PARTIAL | `packages/application/src/assurance/packet.ts:297`; `prompt.ts:263` | Objective 450000 đã bị chặn. Bỏ canonical-packet contribution làm `packet.test.ts:141`, `:195` đỏ. Final serialized-byte boundary vẫn thiếu. |
| P4-CODE-MED-003 | RESOLVED | `packages/application/src/assurance/checks.ts:277`, `:307` | `checks.test.ts:327` bắt cả hai probe. Restore logic cũ làm test đỏ ở “every test skipped”. |
| P4-CODE-LOW-001 | RESOLVED | `packages/application/src/assurance/adjudication.ts:607` | `git diff --check a2a7b8a..HEAD` trả exit 0. |
| Mutation status/output v3 | RESOLVED | `packages/application/src/assurance/adjudication.ts:201`; `adjudication.test.ts:332` | Thay guard bằng `false` trong RAM cho **13 pass, 1 fail**. Test báo thiếu exception cho `COMPLETED_VALID + null`. |

Các mutation “bỏ fix” nêu trên chỉ chạy trong loader.
Không mutation nào được ghi xuống file.

### Kết quả chạy lại probe v3

| Probe | Kết quả tại HEAD | Bằng chứng |
|---|---|---|
| Path chứa LF | Push guard `BLOCK`, egress `STOP_CLASSIFIED`, fake sender bằng 0. | `packages/application/src/assurance/egress.test.ts:150` |
| Rename từ sensitive path trong repair delta | Egress từ chối và fake sender bằng 0. | `packages/application/src/assurance/egress.test.ts:217` |
| `[LOW, CRITICAL]`, cả hai thứ tự | Cả hai trả `REPAIR`. Finding giữ severity `CRITICAL`. | Probe Node trên `adjudicate`; `packages/application/src/assurance/adjudication.test.ts:226` |
| Citation vào context sát dòng thêm | Citation grounded nhưng `changedLine: false`. Finding tiếp tục block. | Probe Node trên `groundResolution`; `packages/application/src/assurance/adjudication.test.ts:455` |
| SARIF prior không recheck | Prior giữ `OPEN` và blocking. | `packages/application/src/assurance/adjudication.test.ts:597` |
| Scanner status 2 | Collection throw trước khi trả corpus. | Probe RAM từ `evals/review-corpus/collect.ts:645`; `collect.test.ts:308`, `:318` |
| Waiver còn hạn | Re-raise cùng identity không block. | Probe Node; `packages/application/src/assurance/adjudication.test.ts:679` |
| Objective 450000 ký tự | Packet 452995 bytes; includedBytes 453690; cap 400000; `overBudget: true`. Renderer throw `PromptRenderError`. | Probe Node trên `fixtureWorld` và `buildReviewPacket`; `packages/application/src/assurance/packet.ts:303` |
| `tests=3, skipped=3` | Sinh `zero-tests-executed`. | Probe Node; `packages/application/src/assurance/checks.test.ts:338` |
| `fail=1, exitCode=0, recorded PASS` | Sinh `failed-tests-recorded-pass`. | Probe Node; `packages/application/src/assurance/checks.test.ts:339` |
| `COMPLETED_VALID + null` | Throw `AdjudicationInputError`. Các invalid/failed status có output cũng bị từ chối. | Probe Node; `packages/application/src/assurance/adjudication.test.ts:332` |

### Finding mới

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P4-CODE4-HIGH-001 | HIGH | `packages/application/src/assurance/adjudication.ts:487`, `:499`, `:510` | Re-raise LOW liên kết prior HIGH rồi loại prior khỏi blocking. Prior vẫn `OPEN`, nhưng outcome thành `PROCEED`. | Giữ blocking authority của prior chưa đóng. Merge severity bảo thủ giữa current và prior. Thêm HIGH→LOW và CRITICAL→LOW regression. |
| P4-CODE4-HIGH-002 | HIGH | `packages/application/src/assurance/checks.ts:488`; `adjudication.ts:253` | Scanner proof chỉ kiểm rule được khai báo. Rule bị disable vẫn tạo proof và đóng SARIF HIGH thành `VERIFIED`. | Chứng minh effective rule execution và scan coverage trên repaired tree. Không coi `driver.rules` là bằng chứng đủ. |
| P4-CODE4-HIGH-003 | HIGH | `packages/application/src/assurance/adjudication.ts:424` | Ghép tuple bằng LF làm hai requirement/key khác nhau có cùng identity hash. Waived finding có thể nuốt HIGH chưa waived. | Hash tuple qua canonical JSON hoặc encoding không nhập nhằng. Giữ phân biệt `null` với chuỗi rỗng. Thêm collision fixtures. |
| P4-CODE4-MED-001 | MEDIUM | `packages/application/src/assurance/packet.ts:295`, `:303`; `packet.test.ts:121` | Budget đo packet zeroed, không đo final serialized bytes. Oracle cũng zero cùng hai field nên bỏ sót sai biên. | Kiểm actual final packet bytes. Thêm assertion độc lập rằng packet được chấp nhận không vượt cap. |
| P4-CODE4-MED-002 | MEDIUM | `evals/review-corpus/collect.ts:625`, `:678`; `collect.test.ts:324` | Pattern parser không phát hiện cập nhật hợp lệ ngoài assignment đầu tiên. Collector có thể chạy bộ pattern cũ mà không báo lỗi. | Dùng nguồn pattern dùng chung hoặc scanner mode có interface ổn định. Thêm executable parity và drift fixtures. |

**P4-CODE4-HIGH-001 — severity downgrade bypass.**

Probe dùng round 2 và `maxRounds: 3`.
Prior là grounded HIGH, trạng thái `OPEN`.

| Re-raise | Gating outcome | Shadow verdict | Prior sau adjudication |
|---|---|---|---|
| HIGH | `REPAIR` | `wouldBe: REPAIR` | `OPEN` |
| LOW | `PROCEED` | `wouldBe: PROCEED` | `OPEN` |

Không có closure claim trong probe.
Lỗi đến từ việc đánh dấu prior là linked rồi chỉ dùng severity hiện tại.
(`packages/application/src/assurance/adjudication.ts:487`, `:499`, `:510`; probe Node đã chạy)

**P4-CODE4-HIGH-002 — declared rule không đồng nghĩa executed rule.**

Probe SARIF khai báo đúng scanner, version và rule.
Probe đặt `defaultConfiguration.enabled: false`.
Invocation cũng có `ruleConfigurationOverrides` tắt rule.
Invocation vẫn báo `executionSuccessful: true`.

Parser trả:

```json
{
  "tool": "semgrep",
  "toolVersion": "1.90.0",
  "rules": ["js.eval-use"],
  "executionSuccessful": true
}
```

Adjudication đóng prior thành `VERIFIED`, rule `scanner-recheck`, outcome `PROCEED`.
(`packages/application/src/assurance/checks.ts:488`; `adjudication.ts:244`; probe Node đã chạy)

R23 yêu cầu cùng rule đã chạy.
Rule metadata và process completion chưa chứng minh điều đó.
(`~/.openclaw/lanes/reconciliation-v1.md:365`)

**P4-CODE4-HIGH-003 — collision identity gây false green.**

Hai tuple sau khác nhau:

```text
(requirementId = "REQ\nf1", key = "x")
(requirementId = "REQ",    key = "f1\nx")
```

Cả hai tạo cùng chuỗi hash tại dòng 424.
WorkOrder và reviewer-output schema đều cho phép các chuỗi này.
(`packages/contracts/schema/work-order.schema.json:13`; `packages/application/src/assurance/prompt.ts:142`, `:160`)

Probe round 2 cho kết quả:

```text
Chỉ HIGH thuộc "REQ\nf1": REPAIR.
Thêm HIGH thuộc "REQ" đã được waiver: PROCEED.
Current finding còn lại: requirementId "REQ", state WAIVED.
```

Finding chưa waived đã biến mất qua merge.
(`packages/application/src/assurance/adjudication.ts:424`, `:429`; probe Node đã chạy)

**P4-CODE4-MED-001 — boundary vẫn sai.**

Probe packet với diff rỗng và file list rỗng cho:

```text
cap           = 2261
includedBytes = 2261
actual bytes  = 2264
overBudget    = false
```

Renderer còn kiểm prompt nên probe này chưa chứng minh request vượt cap được gửi.
Lỗi nằm ở packet contract và byte-count oracle.
(`packages/application/src/assurance/packet.ts:303`; `prompt.ts:263`; `packet.test.ts:121`; probe Node đã chạy)

### HIGH-006 và thay đổi publication gate

Collector hiện chạy bốn script và một `grep -lE`.
Collector không chạy `check-publication.sh`.
(`evals/review-corpus/collect.ts:672`)

Với assignment hiện tại, collector đọc đúng bốn path-leak patterns.
Nó kiểm lỗi subprocess chặt hơn cách chỉ tìm tên blob trong output.
(`scripts/check-publication.sh:26`; `evals/review-corpus/collect.ts:683`)

Parser có từ chối format không hiểu trong block đầu tiên.
Nó từ chối double-purpose line, command substitution và danh sách rỗng.
(`evals/review-corpus/collect.ts:626`; `collect.test.ts:329`)

Nhưng parser **không fail closed với mọi format change**.

Tôi thêm trong RAM, ngay sau assignment đầu tiên:

```sh
LEAK_PATTERNS+=('/private-new/[A-Za-z]+')
```

`leakPatterns()` vẫn thành công.
Nó trả bốn pattern cũ và bỏ pattern mới.
(`evals/review-corpus/collect.ts:625`; probe Node đã chạy)

Vì vậy, thay đổi này làm yếu bảo đảm tương đương với script thật.
Collector cũng không chạy path-scanner self-test của script.
(`scripts/check-publication.sh:181`; `evals/review-corpus/collect.ts:678`)

LICENSE, history scan và dependency-license scan thuộc publication gate đầy đủ.
Không nên ép các kiểm tra repository đó vào từng excerpt.
Nhưng collector không được thay thế publication gate đầy đủ trước public push.
(`scripts/check-publication.sh:129`, `:148`, `:151`)

### Diễn giải MED-001

Diễn giải của lane là đúng đối với harness refutation.

Harness chỉ được refute finding ungrounded.
Một citation grounded về sau không được thừa hưởng refutation cho citation thất bại trước đó.
(`packages/domain/src/assurance.ts:232`; `packages/application/src/assurance/adjudication.ts:273`)

Test “harness refutation” đã kiểm nhánh này.
(`packages/application/src/assurance/adjudication.test.ts:699`)

Kết luận đó không biện minh cho việc current LOW làm mất blocking authority của prior HIGH.
Đó là lỗi riêng P4-CODE4-HIGH-001.
(`packages/application/src/assurance/adjudication.ts:499`, `:510`)

### Mutation không bị bắt

Tôi chạy mutation sau trong RAM, chỉ tại nhánh reconcile current với prior:

```diff
-      blocking: blockingSeverity.has(f.severity),
+      blocking: blockingSeverity.has(f.severity) && f.severity !== 'CRITICAL',
```

Locus là `packages/application/src/assurance/adjudication.ts:499`.

**Cả 61 test pure-core vẫn pass.**
Control không mutation cũng đạt 61 pass.
Lệnh dùng cùng Node loader và cùng chín file test.

Counterexample round 2, `maxRounds: 3`:

```text
Grounded OPEN CRITICAL prior được nhắc lại ở CRITICAL.

Control:  REPAIR,  blocking = 1.
Mutation: PROCEED, blocking = 0.
```

Test lẽ ra phải bắt mutation là:
`“a re-raised finding is reconciled with its prior before it blocks”`.
Case set hiện chỉ dùng default HIGH tại nhánh này.
(`packages/application/src/assurance/adjudication.test.ts:647`, `:655`, `:715`)

Cần thêm cả CRITICAL re-raise và severity downgrade.
Cần assert outcome, blocking severity và prior lifecycle đồng thời.

Oracle budget cũng còn thiếu kiểm actual serialized bytes.
Expected value hiện tái sử dụng quy tắc zeroed budget.
(`packages/application/src/assurance/packet.test.ts:120`)

### Ranh giới và giới hạn kiểm chứng

Các lệnh sau không trả file thay đổi:

```sh
git diff --name-only 9e3a1c3..HEAD -- \
  packages/ports packages/contracts adapters/persistence apps workers \
  packages/domain/src/operational.ts scripts/forbidden-imports.test.ts

git diff --name-only 9e3a1c3..HEAD -- \
  '*root*' '*composition*' '*migrat*'
```

Không có thay đổi tại ports, contracts, migrations, composition roots hoặc hai file được chỉ định.

Lệnh sau không trả match trong source TypeScript thuộc phạm vi audit:

```sh
rg -n '@temporalio|\bfetch\s*\(|process\.env|node:https|node:http|node:net' \
  packages/policy/src/review* packages/domain/src/assurance* \
  packages/application/src/assurance evals/review-corpus --glob '*.ts'
```

Corpus blobs chứa historical source có network và environment references.
Chúng là dữ liệu excerpt, không phải runtime import trong collector.
(`evals/review-corpus/collect.ts:63`, `:767`)

Audit không gửi request mạng.
Các egress test chỉ gọi fake sender.
(`packages/application/src/assurance/egress.test.ts:176`, `:200`)

`git rev-parse HEAD` trả `7cc20f474ef0d53532ff386777eae7d5d07dae24`.
`git status --porcelain` trước và sau audit đều rỗng.
Không file nào được sửa.

## Kết luận

Chưa hand-off block vào S0.
Cần chốt money mapping và terminal-before-lease exception trước freeze.
(`docs/implementation/phases/phase-04-plan.md:1209`, `:1427`)

Chưa chấp nhận code sau sửa.
Ba HIGH mới đã có counterexample thực thi.
Chúng gây false green dù các regression hiện tại xanh.
(`packages/application/src/assurance/adjudication.ts:253`, `:424`, `:499`)

Giữ production shadow-only, D-2 inactive và descriptive self-history.
Các giới hạn này vẫn được ghi đúng trong plan.
(`docs/implementation/phases/phase-04-plan.md:243`, `:249`, `:250`)

Controller rerun full gate vẫn cần thiết.
Kết quả đó không thay thế regression cho ba HIGH và mutation còn sống.
