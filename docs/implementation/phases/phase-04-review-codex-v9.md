# Phase 4 — Codex Re-check v9: S19 provenance-stage freeze and S20 pure core (verbatim)

> Provenance: independent, read-only re-check of the v8 fixes to the S19 provenance-stage freeze and the S20 pure
> core by Codex running `gpt-6.1-sol` through the kiro-proxy gateway, commissioned by the controller on 2026-10-30.
> Reviewed branch `phase/04-independent-assurance` at snapshot `fbaf6ac`
> (`fbaf6ac10dcd526071914433f940aa2c118098f0`). Codex CLI 0.165.0, one uninterrupted run. Copied into the repository
> by the Lane B session from the controller's output file (sha256 of the source file:
> `8b892843fb6b0a0b12e103b366ae7325cf4c083aeb800ae8ff24ebe20093c188`). The body below is byte-identical to that file
> except for two edits required by repository gates: (1) the provenance-stage check (`evals/review-corpus/freeze.test.ts`
> › "the committed manifest is a provenance-stage freeze that nothing binds to"), which lets no tracked file but the
> manifest name the manifest's corpusSha256 — the one full digest in the body is shortened to `6314c046…`; (2) the
> format gate (`scripts/format-check.sh`) — a final newline is added. The review is in Vietnamese, as produced. Line
> numbers in it refer to the documents and code at `fbaf6ac`; its links point into the reviewer's own checkout of that
> snapshot, which is not part of the repository. The probes it names (`READ_ONLY_FREEZE_REPLAY`,
> `STAGE_DYNAMIC_BINDING`, `NO_FIX_RULE`, `PENDING_TEXT_PROVENANCE`, `GOLDEN_ORACLE_READ_ONLY_REPLAY`,
> `NULL_LINE_END_PROBE`, `TEMPLATE_DIGEST`, `BOUNDARY_PROOF` and others) were run by the reviewer and are not in the
> repository. Dispositions are recorded in `phase-04-review-log.md` ("Review v9").
>
> Controller checks at the same snapshot, on a clean detached worktree: `pnpm verify:all` twice, exit 0 each; 659
> tests, 659 pass, 0 fail, 0 skipped each; the slot block byte-identical; `collect.ts --write` and `freeze.ts --write`
> change no file (corpusSha256 `6314c046…`). (The reviewer ran neither the full gate nor the writing collector; its own
> counts are in the body below.)

---

VERDICT: REQUEST_CHANGES  confidence 0.97

| ID | verdict | file:line bằng chứng | ghi chú |
|---|---|---|---|
| P4-S19-HIGH-001, phần làm ngay | RESOLVED | `evals/review-corpus/freeze.ts:51`; `evals/review-corpus/README.md:4` | Manifest ghi rõ provenance-stage. Final freeze đã chuyển sang integration theo R44. Stage hiện là nhãn, chưa phải guard. |
| P4-S20-HIGH-001, phần làm ngay | RESOLVED | `packages/application/src/assurance/corpus-packet.test.ts:275`; `evals/review-benchmark/golden.test.ts:44` | Hai side có digest cố định. Application kiểm validator và grounding. Matcher đọc outcome đã ghi. Rubric mutant bị bắt. |
| P4-S20-MED-001 | RESOLVED | `evals/review-benchmark/matcher.ts:78`; `evals/review-benchmark/matcher.ts:125`; `evals/review-benchmark/matcher.test.ts:131` | Khóa đúng thứ tự distance → gold ID → fingerprint → chunk. `FINGERPRINT_TIE_RECALL` đạt 2/2. |
| P4-S20-MED-002 | RESOLVED | `evals/review-benchmark/floors.ts:61`; `evals/review-benchmark/statistics.test.ts:79` | Degradation giữ dấu. Test xác nhận `10/20 − 15/20 = −0.25`. |
| P4-S20-MED-003 | PARTIAL | `evals/review-corpus/freeze.ts:239`; `evals/review-corpus/freeze.ts:522` | Round, repair base và prior candidates đã có. `evidence` và `requiredFix` vẫn bị hoãn dù chỉ cần provenance. |
| P4-S20-LOW-001 | RESOLVED | `docs/implementation/phases/phase-04-review-log.md:1692`; `evals/tsconfig.json:13` | Amendment đã ghi theo R44. Evals vẫn chỉ reference contracts và policy. |
| P4-S20-LOW-002 | RESOLVED | `docs/implementation/phases/phase-04-review-log.md:1702` | Log ghi đủ hash cũ, hash mới và căn cứ R42. Probe `TEMPLATE_DIGEST` tái xác nhận cả hai. |
| Mutation lenient-distance v8 | RESOLVED | `evals/review-benchmark/matcher.test.ts:155` | Mutant `return variant === 'lenient' ? 0 : gap;` làm test nearest-first thất bại. |
| Mutation rubric SECURITY v8 | RESOLVED | `packages/application/src/assurance/corpus-packet.test.ts:284` | Thêm `Do not report SECURITY findings.` làm assertion prompt digest thất bại. |

## Stage freeze

`READ_ONLY_FREEZE_REPLAY` gọi `freezeCorpus` hai lần và đối chiếu byte với manifest committed.

Hash tái lập là:

```text
6314c046…
```

Probe xác nhận 153 item, 46 included, 122 blob và 19 mapping diff.

Exclusion gồm 69 `plan-defect`, 19 `reviewed-tree-unknown`, 16 `no-location` và 3 `leakage-filtered`.

Đây là số của snapshot provenance, chưa phải denominator cuối (`evals/review-corpus/freeze.ts:629`).

Replay dùng lại quyết định sạch cho mapping bytes đã lưu. Tôi không chạy publication wrapper tạo repository tạm (`evals/review-corpus/collect.ts:669`).

**Stage hiện chỉ là nhãn.** `FrozenCorpus` vẫn xuất `corpusSha256` bình thường (`evals/review-corpus/freeze.ts:391`; `:645`).

Không có guard từ chối dùng hash provenance tại API bind hiện hành. Tìm kiếm `corpusSha256` chỉ thấy generator và kiểm thử trong phạm vi rà soát.

Test hiện chỉ tìm literal hash trong tracked files (`evals/review-corpus/freeze.test.ts:73`).

Probe `STAGE_DYNAMIC_BINDING` đọc hash từ manifest rồi gán vào descriptor trong bộ nhớ. Phép gán thành công.

Cùng probe vẫn vượt assertion literal-grep. Vì vậy, test này không chứng minh việc cấm bind động.

Hiện chưa thấy consumer thực tế bind hash đó qua `rg -n 'corpusSha256|manifestVersion|stage' evals`.

Consumer integration phải từ chối provenance-stage trước preregistration hoặc scoring, theo ranh giới R44.

**Rule cho `fixCommits: []` phù hợp protocol.** §7.5 ghi provenance fix commit, không yêu cầu mọi residual phải có fix commit.

Rule C chấm trạng thái residual tại cycle tiếp theo (`docs/implementation/phases/phase-04-plan.md:670`).

Negative cần confirmation `RESOLVED` và mapped location (`docs/implementation/phases/phase-04-plan.md:680`).

Probe `NO_FIX_RULE` xác nhận cả 15 item đều `PARTIAL`, chỉ có use `residual-status`, không có confirmation `RESOLVED`.

Test pin rule và chứng minh xóa fix-commit reference không đổi use (`evals/review-corpus/freeze.test.ts:78`).

Việc thiếu fix commit không được dùng để suy ra item đã fixed (`evals/review-corpus/README.md:34`).

**`pendingPacketFields` chưa phân loại đúng dependency.** Attempt identity, chunk filter, fingerprint và packet sources có lý do hoãn integration.

Danh sách cũng hoãn `priorFindings[].evidence` và `requiredFix` (`evals/review-corpus/freeze.ts:235`).

Hai field này lấy từ label, không cần packet builder (`docs/implementation/phases/phase-04-plan.md:675`).

Collector đã cung cấp label text qua `cycleLabels` (`evals/review-corpus/collect.ts:368`).

Masker cũng đã nằm trong corpus pure core (`evals/review-corpus/synthetic.ts:57`).

Probe `PENDING_TEXT_PROVENANCE` tìm được text cho toàn bộ 26 prior item riêng biệt trong 260 reference.

Không reference nào lưu `evidence` hoặc `requiredFix` trong prior candidate.

Đây là phần còn thiếu của P4-S20-MED-003, độc lập với quyết định controller về chín residual.

## Golden

**Oracle độc lập về phép dựng và tính digest, chưa độc lập về toàn bộ nội dung đầu vào.**

Python tự dựng canonical packet, nonce và datamarked prompt (`evals/review-benchmark/golden/P2-FINAL-HIGH-003/golden-oracle.py:175`; `:205`).

Python không import hoặc chạy TypeScript của builder và renderer.

Tuy nhiên, Python đọc instruction text trực tiếp từ `prompt.ts` (`golden-oracle.py:153`).

Python lấy synthetic record và attempt identity từ fixture hiện có (`golden-oracle.py:152`; `:174`).

Output schema được viết riêng trong Python (`golden-oracle.py:92`).

Schema đó là bản biểu diễn thứ hai, không phải bằng chứng độc lập rằng contract đã đúng nghiệp vụ.

Grounding outcomes được ghi tay; fingerprint được Python tính riêng (`golden-oracle.py:35`; `:143`).

Tôi chạy `GOLDEN_ORACLE_READ_ONLY_REPLAY` bằng Python. Mọi thao tác ghi được chặn và giữ trong bộ nhớ.

Cả 18 output tái lập byte-identical với file committed.

| Side | Packet SHA256 | Prompt SHA256 |
|---|---|---|
| reviewed | `2d83b58af6db8c5fe1aece09ce4a47bedd966bb30aea7275967b9ee699cb76dd` | `3119bc6fd609789270b86d153c8f2a9ea9df591a60e7654670e6f0030c209032` |
| post-fix | `5ea3a155142241799ba8d5f6e6cd924bcfe1cbdeb2080cc64e97d49b85b8b153` | `3920f286900892aee767dc0832dfc6502e100fbfd059e59d321d1534584f30bb` |

Digest bảo vệ toàn bộ canonical payload của hai fixture.

Prompt payload gồm version, instructions, input và output schema (`packages/application/src/assurance/prompt.ts:257`).

Packet chứa digest của content parts. Prompt chứa chính content đã datamark (`packages/application/src/assurance/prompt.ts:246`).

Thay đổi instruction mà giữ golden committed sẽ bị bắt. Rubric mutant đã thất bại tại `reviewed: prompt digest`.

Nếu tái sinh golden cùng instruction đã đổi, oracle sẽ nhận instruction mới từ code. Việc tái sinh vẫn cần review nội dung.

Golden chưa chứng minh mọi nhánh packet. Hai side đều dùng fresh review và chunk chọn tay (`golden-oracle.py:225`).

Full-cycle chunking và chain validation → grounding → matcher vẫn thuộc integration theo R44.

**`outside-file` kiểm được việc đọc grounding outcome.**

Output trỏ line 900 của file nằm trong chunk (`outputs/reviewed/outside-file.json:8`).

Outcome committed ghi `grounded: false`, reason `lines-outside-file` (`expected-grounding.json:44`).

Application tính grounding thật và đối chiếu outcome đó (`packages/application/src/assurance/corpus-packet.test.ts:297`).

Evals đọc boolean từ outcome (`evals/review-benchmark/golden.test.ts:48`).

Mutant thay phép đọc bằng `grounded: true` làm test thất bại tại `reviewed outside-file strict`.

**Vẫn có expectation lấy từ code trong kiểm thử parity.**

`corpusSources()` lấy work order từ runtime builder (`packages/application/src/assurance/corpus-packet.test.ts:33`).

Assertion sau đó so corpus packet với runtime packet (`packages/application/src/assurance/corpus-packet.test.ts:58`).

Đây là bằng chứng parity giữa hai đường dựng. Nó không thay thế oracle recipe độc lập.

Ngoài ra, golden chưa pin `templateSha256` metadata trả về (`packages/application/src/assurance/prompt.ts:266`).

Mutation metadata thành 64 ký tự `0` vẫn giữ 73/73 test đã chạy xanh.

## Regression check

Đã chạy source bằng `node --disable-warning=ExperimentalWarning --input-type=module -e …`.

Loader dùng `registerHooks` và `stripTypeScriptTypes` trong bộ nhớ. YAML dependency được đọc từ worktree verify tại cùng snapshot.

Lượt tập trung đạt **33/33 test** trên bốn file benchmark và ba file packet/prompt.

Lượt mở rộng đạt **73/73 test** trên tám file assurance và bốn file benchmark.

Hai lượt không có skip, todo hoặc failure theo output `node:test`.

Không dùng lời khai 659 test làm bằng chứng. Không chạy `verify:all`.

`git diff --name-status --find-renames 676fefc HEAD` không cho thấy test file bị xóa.

Probe `TEST_TITLE_DELTA` ghi nhận:

| File | Trước → sau | Kết quả |
|---|---:|---|
| `golden.test.ts` | 1 → 1 | Giữ test. |
| `matcher.test.ts` | 4 → 6 | Thêm tie-break và lenient nearest-first. |
| `statistics.test.ts` | 3 → 3 | Giữ test. |
| `synthetic.test.ts` | 4 → 4 | Giữ cả bốn test. |
| `freeze.test.ts` | 6 → 9 | Thêm ba test. |
| `corpus-packet.test.ts` | 5 → 5 | Thay test round-trip bằng test digest và grounding. |

Probe `DISABLED_TESTS` không tìm thấy declaration `.skip`, `.only` hoặc `.todo` trong sáu file đã đổi.

Các assertion work order, budget và block content được thay bằng digest cố định của toàn payload.

Đối với golden fixture, thay đổi này tăng phạm vi kiểm tra (`packages/application/src/assurance/corpus-packet.test.ts:279`; `:284`).

Oracle degradation đổi từ `0` sang `−0.25` có phép tính tay và log giải thích (`statistics.test.ts:79`; `phase-04-review-log.md:1666`).

`expected-matches.json` giữ kết quả cũ và thêm nhóm `ungrounded` cùng `outside-file`, qua `git diff 676fefc..HEAD`.

Helper chuyển sang corpus không mất export trong probe `SYNTHETIC_RELOCATION`.

Test vẫn import helper mới (`evals/review-benchmark/synthetic.test.ts:10`).

Canonical discovery vẫn tìm thấy `synthetic.test.ts` và `freeze.test.ts` trong probe `DISCOVERY`.

Tôi không chạy nguyên bản các test corpus tạo scratch repository. Replay read-only không thay thế publication-gate execution.

### Mutation không bị bắt

**Mutation 1: từ chối finding có `lineEnd: null`.**

Chèn trước fallback tại `evals/review-benchmark/matcher.ts:88`:

```ts
if (f.lineEnd === null) return null;
```

Cả **73/73 test** đã chạy vẫn qua với mutant này.

Probe `NULL_LINE_END_PROBE` dùng gold range `100–110`, finding `lineStart: 105`, `lineEnd: null`.

HEAD cho một match. Mutant cho zero match.

Helper test thường tự đặt `lineEnd = lineStart`, nên bỏ qua nhánh này (`evals/review-benchmark/matcher.test.ts:18`).

**Mutation 2: làm sai template metadata.**

Thay tại `packages/application/src/assurance/prompt.ts:266`:

```ts
templateSha256: '0'.repeat(64),
```

Cả **73/73 test** vẫn qua.

Assertion hiện chỉ so metadata giữa hai lần gọi cùng renderer (`packages/application/src/assurance/prompt.test.ts:96`).

Golden digest không chứa metadata này (`packages/application/src/assurance/prompt.ts:257`).

## Finding mới

| ID | Mức | file:line | Finding và thay đổi cần có |
|---|---|---|---|
| P4-V9-MED-001 | MEDIUM | [freeze.ts:239](/Volumes/DoanBHSST9/Outsource/asep-review-p4-fbaf6ac/evals/review-corpus/freeze.ts:239); [freeze.ts:522](/Volumes/DoanBHSST9/Outsource/asep-review-p4-fbaf6ac/evals/review-corpus/freeze.ts:522) | Prior text bị phân loại sai thành phụ thuộc packet code. Lưu `evidence` và `requiredFix` từ label trước provenance-stage freeze. Dùng quy tắc tách cố định và masker hiện có. Đây là phần còn lại của MED-003. |
| P4-V9-LOW-001 | LOW | [matcher.test.ts:18](/Volumes/DoanBHSST9/Outsource/asep-review-p4-fbaf6ac/evals/review-benchmark/matcher.test.ts:18); [matcher.ts:88](/Volumes/DoanBHSST9/Outsource/asep-review-p4-fbaf6ac/evals/review-benchmark/matcher.ts:88) | Thiếu case finding có start nhưng end null. Thêm expected match cho cả strict và lenient. Mutant đã chứng minh khoảng trống coverage. |
| P4-V9-LOW-002 | LOW | [prompt.test.ts:96](/Volumes/DoanBHSST9/Outsource/asep-review-p4-fbaf6ac/packages/application/src/assurance/prompt.test.ts:96); [prompt.ts:266](/Volumes/DoanBHSST9/Outsource/asep-review-p4-fbaf6ac/packages/application/src/assurance/prompt.ts:266) | `templateSha256` chỉ được kiểm tính ổn định. Pin metadata bằng hash độc lập đã ghi trong review log. Mutant metadata sai vẫn qua. |

## Ranh giới

HEAD cuối lượt vẫn là `fbaf6ac10dcd526071914433f940aa2c118098f0`, qua `git rev-parse HEAD`.

`git status --porcelain=v1` cuối lượt rỗng. Không sửa file hoặc tạo ref.

Không thấy evals import application qua kiểm tra import bằng `rg`.

Các đường dẫn application trong golden là dữ liệu lịch sử, không phải import edge (`evals/review-benchmark/synthetic.test.ts:133`).

Diff `676fefc..HEAD` không đổi ports, contracts, migrations, apps, workers hoặc review-loop slot.

Probe `BOUNDARY_PROOF` xác nhận slot block còn 894 dòng, byte-identical với v8.

SHA256 vẫn là:

```text
9cc21c980d552d607c01bb0a330749eb88070b1cbdce55747fbfdc742960871a
```

Không thấy network API, time API, random API hoặc `process.env` trong các module production được rà bằng `rg`.

Collector vẫn dùng scratch directory cho publication gates (`evals/review-corpus/collect.ts:669`).

Tên scratch không tham gia manifest inputs hoặc body (`evals/review-corpus/freeze.ts:449`; `:599`).

## Kết luận

**S19 provenance-stage freeze chưa đủ chấp nhận trọn vẹn theo R44.**

Cần hoàn tất prior text của P4-V9-MED-001 trước khi đóng P4-S20-MED-003.

**S20 pure core đủ căn cứ chấp nhận về hành vi đã rà.**

Hai HIGH phần làm ngay, tie-break, degradation và hai mutation v8 đã được xử lý.

Hai finding LOW mới cần bổ sung assertion bảo vệ.

Final freeze và scorer integration vẫn chưa được chứng minh trong lượt này (`docs/implementation/phases/phase-04-plan.md:2503`).

I3, I5, I6 và I11 tiếp tục mở theo R44 (`docs/implementation/phases/phase-04-review-log.md:1729`).
