# Phase 4 — Codex Re-check v7: plan v7 and code fixes (verbatim)

> Provenance: independent, read-only re-check of the LOCKED v7 plan and the code fixes by Codex running
> `gpt-6.1-sol` through the kiro-proxy gateway, commissioned by the controller on 2026-10-30. Reviewed branch
> `phase/04-independent-assurance` at snapshot `287ed0f` (`287ed0ff791d5a17371e331afcab6f7ce7be1fdf`). Codex CLI
> 0.165.0, one uninterrupted run. Copied into the repository by the Lane B session from the controller's output file
> (sha256 of the source file: `2530689bae0040b382bd53f36fcb3eb31ce1fead10850ea93614d8b45a7b0ed6`). The body below is
> byte-identical to that file except for two edits required by repository gates: (1) the publication path-leak gate
> (`scripts/check-publication.sh`, `scripts/lib/publication-leak-patterns.txt`) — 2 absolute home-directory paths to
> the controller-owned reconciliation file are rewritten to the `~/.openclaw/lanes/reconciliation-v1.md` form; (2) the
> format gate (`scripts/format-check.sh`) — a final newline is added. The review is in Vietnamese, as produced. Line
> numbers in it refer to the documents and code at `287ed0f`. Dispositions are recorded in `phase-04-review-log.md`
> ("Review v7").
>
> Controller checks at the same snapshot, on a clean detached worktree: `pnpm verify:all` exit 0; 625 tests, 625 pass,
> 0 fail, 0 skipped; 60 test files; 37 required suites; shellcheck through Docker on `scripts/check-publication.sh`:
> exit 0, no warning. (The reviewer ran neither the full gate nor shellcheck; its own counts are in Part 2 below.)

---

VERDICT: ACCEPT_WITH_CHANGES  confidence 0.96

## Phần 1 — Plan v7

Snapshot kiểm là `287ed0ff791d5a17371e331afcab6f7ce7be1fdf`, xác nhận bằng `git rev-parse HEAD`.
`git status --porcelain` trả rỗng trước và sau review.

| ID | trạng thái | file:line | ghi chú |
|---|---|---|---|
| P4-PLAN6-LOW-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:405`; `docs/implementation/phases/phase-04-architecture.md:443` | R36 đã chuyển thành entry criteria của DF-10. Architecture không còn yêu cầu Phase 4 resolve các reference. |
| P4-SLOT6-LOW-001 | FOLDED | `docs/implementation/phases/phase-04-plan.md:1974`, `:2070`, `:2110` | `NotConfiguredAssuranceSlot` phải dùng stateful fixture vì persist outcome events. |

DF-10 ghi đủ entry criteria của R37 tại `docs/implementation/phases/phase-04-plan.md:405`:

- DF-10 kế thừa toàn bộ criteria của DF-9 tại dòng 404.
- DF-10 yêu cầu effective level theo §3.27.10.
- DF-10 yêu cầu message references theo §3.11, gồm `message.id` và `messageStrings`.
- DF-10 yêu cầu failure isolation cho từng result.
- DF-10 giữ hierarchical IDs và các malformed-reference cases của R36.
- DF-10 yêu cầu mọi SARIF probe từ review v4–v6 thành test.

Các chỉ dẫn hiện hành đều hoãn parsing và scanner closure.
Bằng chứng nằm tại `phase-04-plan.md:996`, `:1032`, `phase-04-architecture.md:443` và `phase-04-data-model.md:121`.

Những câu còn mô tả parser hoặc scanner closure nằm trong lịch sử phiên bản.
Ví dụ là các bảng v4–v6 tại `phase-04-plan.md:150`, `:168`, `:182`.
Chúng không phải hành vi v7.

Không phát hiện mâu thuẫn tài liệu mới cần ID `P4-PLAN7`.
Plan, architecture, data model và exit F3 thống nhất về `sarif-unparsed`.
Bằng chứng: `phase-04-plan.md:1034`, `phase-04-architecture.md:448`, `phase-04-data-model.md:58`, `phase-04-exit-criteria.md:107`.

R39 đã release G-LB, nên không kiểm lại slot block.
Bằng chứng ràng buộc là `~/.openclaw/lanes/reconciliation-v1.md:840`.

## Phần 2 — Code sau sửa

### Disposition

| ID | trạng thái | file:line | test chứng minh |
|---|---|---|---|
| P4-CODE6-HIGH-001 | RESOLVED | `packages/application/src/assurance/checks.ts:450`; `adjudication.ts:289` | `checks.test.ts:372` và `adjudication.test.ts:586` pass. Probe `message.id` trả một SARIF HIGH; vòng thiếu log vẫn OPEN. |
| P4-CODE6-HIGH-002 | RESOLVED | `packages/application/src/assurance/checks.ts:438`; `adjudication.ts:348` | `adjudication.test.ts:657` pass. Probe omitted `level` vẫn HIGH và REPAIR dưới policy chỉ chặn CRITICAL. |
| P4-CODE6-MED-001 | RESOLVED | `packages/domain/src/assurance.ts:214`; `docs/implementation/phases/phase-04-data-model.md:480` | `assurance.test.ts:242` pass. Probe refute SARIF `grounded:false` bị từ chối. Mutation bỏ guard làm một test đỏ. |
| P4-CODE6-MED-002 | MOOT | `packages/application/src/assurance/checks.ts:450`; `docs/implementation/phases/phase-04-plan.md:405` | Resolver đã bị xóa theo R37. Probes `rule:null`, `rule:7` và `rule:[]` đều trả một SARIF HIGH. |
| Mutation non-object `rule` của v6 | MOOT | `packages/application/src/assurance/checks.ts:450`; `docs/implementation/phases/phase-04-plan.md:405` | Không còn nhánh resolver để mutate. Các reference cases đã được giữ trong DF-10. |

### Bằng chứng thực thi độc lập

Các lượt Node dùng `node --no-wasm-code-gc --disable-warning=ExperimentalWarning --input-type=module -e`.
Loader RAM dùng `registerHooks` và `stripTypeScriptTypes`.
Runner vẫn là `node:test` thật.

| Lượt kiểm | Kết quả |
|---|---|
| Chín suite policy, domain và application assurance | 69 pass, 0 fail, 0 skipped. |
| Hai test corpus tại `evals/review-corpus/collect.test.ts:49`, `:192` | 2 pass. |
| Mutation bỏ domain SARIF guard | 6 pass, 1 fail trong domain suite. |
| Mutation SARIF HIGH → MEDIUM | 25 pass, 4 fail trong checks và adjudication suites. |
| `bash -n scripts/check-publication.sh` | Exit 0. |
| `git diff --check d0907b9..HEAD` | Exit 0. |
| `gitleaks git --no-banner --redact --log-opts='d0907b9..HEAD' .` | Exit 0; không phát hiện leak trong bốn commit. |

Không chạy `verify:all`.
Không xác nhận lại số `625/625`.
`command -v shellcheck` không tìm thấy executable, nên không phát hành kết luận Shellcheck mới.

### SARIF và check-report

`sarifFindings` không decode bytes; nó chỉ tính digest và tạo finding.
Bằng chứng: `packages/application/src/assurance/checks.ts:432`, `:450`.

Finding mang source `sarif`, rule `sarif-unparsed`, severity HIGH và evidence nhận diện log.
Adjudication đặt `grounded:true` và chặn SARIF độc lập severity policy.
Bằng chứng: `checks.ts:435`, `:443`; `adjudication.ts:348`, `:367`.

| Probe | Kết quả | Bằng chứng |
|---|---|---|
| `message.id`, omitted `level` | Mỗi log tạo một finding HIGH và REPAIR. | Probe Node; `checks.test.ts:395`; `adjudication.test.ts:660`. |
| Log rỗng, không phải JSON, không phải UTF-8 | Không mất finding. | Probe Node; `checks.test.ts:397`. |
| Hai check khác tên, bytes giống nhau | Giữ hai findings. | Probe Node; `checks.test.ts:417`. |
| Cùng tên check, bytes khác nhau | Giữ hai findings. | Probe Node; fingerprint tại `checks.ts:445`. |
| Cùng check và cùng bytes được liệt kê hai lần | Dedupe thành một finding của cùng identity. | `checks.test.ts:560`; `findings.ts:203`. |
| Vòng sau thiếu log hoặc có log khai sạch | Prior vẫn OPEN và blocking. | `adjudication.test.ts:608`, `:637`; `adjudication.ts:289`. |
| Waiver của log cũ gặp log mới | Log mới vẫn blocking. | Probe `WAIVER_LOG_IDENTITY`; `checks.ts:445`; `adjudication.ts:455`. |

Việc dedupe entry giống hệt là chủ đích được test ghi rõ.
Identity hiện là `(checkId, sha256)`, không phải occurrence hoặc `artifactId`.
Bằng chứng: `checks.test.ts:560`; `phase-04-plan.md:954`.

Không tìm thấy đường HEAD tự đóng SARIF qua model, scanner hoặc deterministic recheck.
Bằng chứng: `adjudication.ts:275`, `:289`; `packages/domain/src/assurance.ts:214`.

Parser từ chối 11/11 biến thể report giả mạo trong probe độc lập.
Các biến thể gồm mất finding, sai severity, sai evidence, sai digest log và finding bị nhân đôi.
Mỗi probe tính lại SHA của report trước khi parse.
Bằng chứng code: `check-report.ts:235`, `:242`; regression: `checks.test.ts:625`.

Parser vẫn cần `expectedSha256` từ nguồn tin cậy.
Nó không tự chứng thực nguồn gốc một report tự nhất quán.
Bằng chứng: `check-report.ts:206`; persistence của raw artifacts còn thuộc S12 tại `phase-04-data-model.md:125`.

### Domain và các đường dựng aggregate

Guard hiện áp dụng cho mọi state đi qua `applyFindingDisposition`.
Nó không phụ thuộc `grounded`.
Bằng chứng: `packages/domain/src/assurance.ts:214`, `:268`.

Probes trên OPEN, ACKNOWLEDGED và FIXED đều từ chối machine verify, refute, waive và claim.
Các transition không hợp lệ bị từ chối sớm hơn.
Bằng chứng: probe Node; `assurance.ts:265`.

`closeVerifiedFinding` và `markRefutationAdjudicated` đều từ chối aggregate OPEN.
Hai helper chỉ nhận state đã non-blocking.
Bằng chứng: `assurance.ts:309`, `:315`; probe `OPEN_HELPER`.

Aggregate dựng trực tiếp vẫn có thể khai sẵn state CLOSED hoặc WAIVED.
Core không xác minh provenance của state được hydrate.
Bằng chứng: `assurance.ts:47`; `adjudication.ts:202`, `:246`.

Đây là ranh giới cần giữ khi triển khai persistence và replay.
Review này chưa chứng nhận các đường đó.
S8 và S12 vẫn chưa nằm trong pure core được kiểm.
Bằng chứng: `phase-04-plan.md:2429`, `:2433`.

Mutant `disposition !== 'REOPENED'` equivalent về transition được phép và mã lỗi.
Reviewer branch vẫn từ chối reviewer REOPENED tại `assurance.ts:220`.
Probe so sánh 672 trường hợp không thấy khác state hoặc error code.
Có sáu diagnostic messages khác nhau, nên mutant không byte-equivalent về message.

### Publication scanner

History scan hiện phân biệt đúng grep 0, 1 và các status lỗi.
Bằng chứng: `scripts/check-publication.sh:206`, `:224`.

Shell probes dùng `node --input-type=module -e` để gọi Bash và grep thật.
Scratch storage được thay bằng biến RAM.
Không chạy nguyên full gate hoặc các test tạo scratch tại `collect.test.ts:443`.

| Trường hợp | Scan-only | `check_history_secrets` |
|---|---:|---:|
| Không có commit, không có hit, hoặc chỉ có exemption | 0 | 0 |
| Có hit ngoài exemption | 1 | 1 |
| `git rev-list` trả 128 | 2 | 1 |
| `git grep` trả 2 hoặc 127 | 2 | 1 |
| Exemption filter trả 2 hoặc 127 | 2 | 1 |

Các kết quả trên khớp nhánh tại `check-publication.sh:192`, `:207`, `:226`, `:252`.
History thật cũng trả clean trong harness chỉ thay storage bằng RAM.

History output chỉ chứa commit, path và count nhờ `git grep -c`.
Không in matched content.
Bằng chứng: `check-publication.sh:206`, `:229`, `:256`.

Exemption hiện anchored đúng toàn dòng.
Probe pathname chứa `:scripts/check-publication.sh:` vẫn giữ hit.
Bằng chứng: `check-publication.sh:178`; probe `EXEMPT-MUTANT`.

`--scan-paths -- LICENSE` trả 0 trong harness RAM.
Thiếu file sau sentinel trả 2; file có private-path hit trả 1.
Bằng chứng: nhánh CLI tại `check-publication.sh:290` và probe `sentinel-clean`, `private-path-file`.

Không thấy full gate yếu đi so với `00a6889`.
Diff giữ license, history scan, dependency licenses, delegated scanners và self-test.
Lệnh đối chiếu là `git diff 00a6889..HEAD -- scripts/check-publication.sh`.
Các bước full gate còn tại `check-publication.sh:310`, `:329`, `:332`, `:335`, `:344`, `:353`, `:362`.

### Finding mới

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P4-CODE7-MED-001 | MEDIUM | `packages/application/src/assurance/check-report.ts:81`; `adjudication.ts:348`; `checks.test.ts:575` | Summary vẫn đếm blocking chỉ theo severity. Policy `[CRITICAL]` hợp lệ trả `{total:1, blocking:0}` cho SARIF, trong khi adjudication trả REPAIR. | Đếm source SARIF là blocking độc lập severity policy. Thêm regression summary với policy không chứa HIGH. |
| P4-CODE7-LOW-001 | LOW | `packages/application/src/assurance/check-report.ts:65`; `checks.test.ts:551` | Sort chỉ dùng `checkId`. Đảo hai log cùng tên nhưng khác bytes làm đổi report SHA dù findings giống nhau. | Sort theo total key gồm checkId và digest. Thêm permutation test cho log cùng tên. |
| P4-CODE7-LOW-002 | LOW | `packages/domain/src/assurance.test.ts:273`, `:281`; `assurance.ts:214` | Negative matrix SARIF chỉ chạy từ OPEN. Mutation giới hạn guard vào OPEN vẫn cho 69/69 tests pass. | Thêm cases ACKNOWLEDGED và FIXED cho các machine dispositions hợp lệ từ những state đó. |
| P4-CODE7-LOW-003 | LOW | `evals/review-corpus/collect.test.ts:484`; `scripts/check-publication.sh:178` | Mutant unanchored dưới `-c` không equivalent. Tên file vẫn có thể chứa chuỗi exemption và bị filter bỏ. | Thêm fixture pathname chứa `:scripts/check-publication.sh:`. Sửa kết luận equivalent của lane. |

MED-001 là lệch hành vi mới sau khi R37 thêm ngoại lệ blocking cho SARIF.
Helper summary chưa tiếp nhận ngoại lệ đó.
Bằng chứng: `adjudication.ts:348` so với `check-report.ts:81`.

Probe LOW-001 tạo hai SHA `2577185c…` và `95fc1622…` từ cùng hai log.
Chỉ thứ tự `sarifInputs` khác nhau.
Bằng chứng: probe `SAME_NAME_REPORT_ORDER`; `check-report.ts:67`.

### Mutation không bị bắt

Mutation sau chạy hoàn toàn trong RAM:

```diff
-  if (finding.source === 'sarif' && !(actor.kind === 'harness-rule' && disposition === 'REOPENED')) {
+  if (finding.source === 'sarif' && finding.state === 'OPEN' && !(actor.kind === 'harness-rule' && disposition === 'REOPENED')) {
```

Control và mutant đều đạt 69/69 tests.
Locus là `packages/domain/src/assurance.ts:214`.

Counterexample dùng chuỗi transition hợp lệ:

```text
SARIF grounded:false, OPEN
→ human ACCEPTED
→ ACKNOWLEDGED
→ machine REJECTED_WITH_EVIDENCE / citation-unresolvable
→ REFUTED
→ isLifecycleBlocking=false
```

HEAD từ chối bước machine bằng `actor-not-permitted`.
Mutant chấp nhận bước đó.
Bằng chứng: probe `OPEN_ONLY_MUTANT_SEQUENCE`; test thiếu state matrix tại `assurance.test.ts:281`.

Mutation bỏ comparator của `sarifInputs` cũng giữ 69/69 tests xanh.
Bằng chứng: lượt loader RAM sửa `check-report.ts:67`.

Kết luận equivalent của mutant unanchored cũng sai.
Dòng count hợp lệ sau là counterexample:

```text
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:docs/:scripts/check-publication.sh:note:1
```

Filter hiện tại giữ dòng này.
Filter unanchored cũ bỏ dòng này.
Bằng chứng: probe `EXEMPT-MUTANT`; regex hiện tại tại `check-publication.sh:178`.

Test hiện chỉ đặt chuỗi exemption trong nội dung `notes.txt`.
`-c` đã loại nội dung khỏi output, nên case đó không kiểm được pathname smuggling.
Bằng chứng: `collect.test.ts:484`, `:490`.

### Ranh giới thay đổi

Hai lệnh sau đều không trả file:

```sh
git diff --name-only d0907b9..HEAD -- \
  packages/ports packages/contracts adapters apps workers migrations \
  packages/domain/src/operational.ts scripts/forbidden-imports.test.ts

git diff --name-only 00a6889..HEAD -- \
  packages/ports packages/contracts adapters apps workers migrations \
  packages/domain/src/operational.ts scripts/forbidden-imports.test.ts
```

Danh sách diff ngoài docs cũng không có migration hoặc composition root.
Bằng chứng: `git diff --name-only 00a6889..HEAD`.

Lệnh sau không tìm thấy implementation Temporal, environment access hoặc network trong phạm vi TypeScript được kiểm:

```sh
rg -n '@temporalio|fetch\s*\(|process\.env|node:(http|https|net|tls)|https?\.request' \
  --glob '*.ts' \
  packages/policy/src/review.ts \
  packages/domain/src/assurance.ts \
  packages/application/src/assurance \
  evals/review-corpus
```

`check-publication.sh` và pattern file thuộc ngoại lệ R28.
Bằng chứng: `~/.openclaw/lanes/reconciliation-v1.md:540`.

## Kết luận

Các blocker SARIF v6 đã được xử lý theo R37.
Bằng chứng là disposition table, 69 tests và các probes closure nêu trên.

Pure core đủ để chấp nhận có điều kiện.
Cần sửa summary blocking và đóng ba finding LOW trước khi xác nhận chấp nhận hoàn tất.

Không cần mở lại review slot hoặc triển khai parser SARIF để đóng các finding này.
Bằng chứng: R39 tại `reconciliation-v1.md:840`; DF-10 tại `phase-04-plan.md:405`.

Controller cần kiểm head sau sửa bằng gate của lane.
Review này không thay thế `verify:all` hoặc chứng nhận Shellcheck.

Chấp nhận pure core không đồng nghĩa chấp nhận toàn bộ slices.
Integration, persistence, replay và runtime conformance vẫn cần bằng chứng riêng.
Bằng chứng: `docs/implementation/phases/phase-04-plan.md:2453`.
