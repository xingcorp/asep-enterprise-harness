# Phase 4 — Codex Review v8: S19 freeze and S20 pure core (verbatim)

> Provenance: independent, read-only review of the S19 freeze and the S20 pure core by Codex running `gpt-6.1-sol`
> through the kiro-proxy gateway, commissioned by the controller on 2026-10-30. Reviewed branch
> `phase/04-independent-assurance` at snapshot `676fefc` (`676fefcde9eecf7f5ff0bb996ef8e461ccd5008b`). Codex CLI
> 0.165.0, one uninterrupted run. Copied into the repository by the Lane B session from the controller's output file
> (sha256 of the source file: `931d3306a2c070cec12e9e0bfbdbb05da6606090573fbae07edc82cd4f0e176f`). The body below is
> byte-identical to that file except for two edits required by repository gates: (1) the publication path-leak gate
> (`scripts/check-publication.sh`, `scripts/lib/publication-leak-patterns.txt`) — 2 absolute home-directory paths to
> the controller-owned reconciliation file are rewritten to the `~/.openclaw/lanes/reconciliation-v1.md` form; (2) the
> format gate (`scripts/format-check.sh`) — a final newline is added. The review is in Vietnamese, as produced. Line
> numbers in it refer to the documents and code at `676fefc`; the probes it names (`READ_ONLY_FREEZE_REPLAY`,
> `GIT_PROVENANCE`, `PRIVATE_BUNDLE_PACKET_SOURCES`, `BUNDLE_SOURCE`, `FINGERPRINT_TIE_RECALL`,
> `MUTATION_LENIENT_DISTANCE`, `TEMPLATE_DIGEST` and others) were run by the reviewer and are not in the repository.
> Dispositions are recorded in `phase-04-review-log.md` ("Review v8").
>
> Controller checks at the same snapshot, on a clean detached worktree: `pnpm verify:all` twice, exit 0 each; 654
> tests, 654 pass, 0 fail, 0 skipped each; 68 test files; 37 required suites; the slot block byte-identical (sha256
> `9cc21c98…`); `collect.ts --write` then `freeze.ts --write` regenerate the committed corpus byte for byte
> (`git status` empty; corpusSha256 `b140616b…`). (The reviewer ran neither the full gate nor the writing collector;
> its own counts are in the body below.)

---

VERDICT: REQUEST_CHANGES  confidence 0.98

## S19 freeze

Manifest tái lập byte-identical trong phép chạy read-only `READ_ONLY_FREEZE_REPLAY`.

Hash thu được là `b140616bd1453d7c2f087e8b7f8e0f9631935caa78cd44e20a722b95d0dd30e0`.

Phép chạy gọi `freezeCorpus` hai lần và đối chiếu manifest committed. Callback gate dùng lại quyết định sạch đã lưu.

Đây chưa phải phép chạy nguyên bản `freeze.ts`. Gate nguyên bản tạo repository tạm tại `evals/review-corpus/collect.ts:669`.

Kết quả kiểm tra độc lập:

- Có 153 item, 46 included, 122 blob và 19 mapping diff (`READ_ONLY_FREEZE_REPLAY`).
- Exclusion gồm 69 `plan-defect`, 19 `reviewed-tree-unknown`, 16 `no-location`, 3 `leakage-filtered` (`READ_ONLY_FREEZE_REPLAY`).
- Có 17 first-occurrence, 29 residual và 9 negative candidate (`READ_ONLY_FREEZE_REPLAY`).
- Đã đối chiếu 153 document line, 46 reviewed tree và 216 excerpt với Git (`GIT_PROVENANCE`).
- Đã kiểm tra 43 fix-commit reference qua subject và ancestry (`GIT_PROVENANCE`).
- Có 15 included item mang `fixCommits: []`; không thể gọi chúng là đã có fix được chứng minh (`GIT_PROVENANCE`).
- Không có included item thiếu location (`GIT_PROVENANCE`).
- Không thấy tree bị đoán cho hai cycle không xác định; collector xử lý riêng tại `evals/review-corpus/collect.ts:583`.
- Có 8 included item thuộc private history và 12 item phụ thuộc private history (`READ_ONLY_FREEZE_REPLAY`).

Thứ tự năm exclusion đã áp dụng đúng protocol tại `evals/review-corpus/freeze.ts:346`. Hai exclusion cuối chưa được áp dụng.

| finding | ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|---|
| Freeze thiếu packet eligibility. | P4-S19-HIGH-001 | HIGH | `evals/review-corpus/freeze.ts:7`; `evals/review-corpus/freeze.ts:460`; `evals/review-corpus/collect.ts:782` | Manifest chốt hash khi `not-in-packet` và `egress-stopped` còn pending. Excerpt chỉ bao phủ file được label trích dẫn. | Dựng packet theo cycle, áp chunking và egress trước khi chốt eligibility. Lưu đủ packet source và synthetic record. Tính lại manifest và hash. |

Finding này trái phạm vi R41 tại `~/.openclaw/lanes/reconciliation-v1.md:904`.

Nguồn packet cũng chưa đầy đủ cho cycle private-history `bb11d00`. Kiểm tra `PRIVATE_BUNDLE_PACKET_SOURCES` tìm thấy 148 changed path sau leakage filter.

Excerpt của included item trong cycle chỉ trỏ tới 19 path. Kiểm tra `BUNDLE_SOURCE` xác nhận nhiều post-image không có trong bất kỳ corpus blob nào.

Ví dụ gồm `.gitignore`, `adapters/agent-claude/package.json` và `adapters/agent-claude/src/event-parser.ts` (`BUNDLE_SOURCE`).

Leakage glob đúng danh sách protocol tại `evals/review-corpus/freeze.ts:84`. Masker giữ nguyên chiều dài token tại `evals/review-benchmark/synthetic.ts:53`.

Bốn golden part khớp Git sau masking (`GOLDEN_GIT_ROUNDTRIP_PARTS`). Golden prompt hiện không chứa finding-ID token (`packages/application/src/assurance/corpus-packet.test.ts:233`).

Chưa có full-cycle packet để chứng minh review content không lọt qua recipe hoàn chỉnh (`evals/review-benchmark/golden/P2-FINAL-HIGH-003/item.json:104`).

Publication wrapper xử lý fail-closed cho spawn error, signal, status lạ và findings không nêu excerpt (`evals/review-corpus/collect.ts:699`).

Verifier đưa mọi blob và mapping diff qua wrapper tại `evals/review-corpus/corpus-verifier.test.ts:104`. Golden test đưa bốn round-trip part qua wrapper tại `evals/review-benchmark/synthetic.test.ts:171`.

Kiểm tra read-only `READ_ONLY_PUBLICATION_BODIES` quét đủ 145 file và không tìm thấy secret, PII hoặc private path.

Kiểm tra đó cũng xác nhận giới hạn kích thước, CRLF và final newline. Tôi không chạy wrapper hoặc self-test tạo file tạm.

## S20 pure core

Đã chạy 31 test tập trung bằng `node --input-type=module -e`, với TypeScript loader trong bộ nhớ.

Bốn file benchmark đạt 11/11 test. Ba file application packet/prompt đạt 20/20 test.

Nguồn gồm `matcher.test.ts`, `post-fix-mapping.test.ts`, `statistics.test.ts`, `golden.test.ts`, `corpus-packet.test.ts`, `packet.test.ts` và `prompt.test.ts`.

Category table, tolerance, strict/lenient và cardinality cơ bản đúng (`evals/review-benchmark/matcher.ts:25`; `evals/review-benchmark/matcher.ts:122`).

Matcher từ chối ID trùng và bảo đảm one-to-one (`evals/review-benchmark/matcher.ts:100`). Không thấy phụ thuộc thứ tự mảng với ID duy nhất.

Mapping xử lý rename, deletion và default hunk count đúng trong test đã chạy (`evals/review-benchmark/post-fix-mapping.test.ts:17`).

Wilson dùng z cố định và đúng công thức (`evals/review-benchmark/statistics.ts:9`; `evals/review-benchmark/statistics.ts:37`).

Các trường hợp `n=0`, `k=0`, `k=n` đều qua oracle số cố định (`evals/review-benchmark/statistics.test.ts:10`).

Các floor boundary và `INVALID_CONTROL` đều qua test (`evals/review-benchmark/statistics.test.ts:52`). Giá trị degradation âm đang bị đổi sai.

| finding | ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|---|
| Golden chưa chứng minh recipe. | P4-S20-HIGH-001 | HIGH | `evals/review-benchmark/golden/P2-FINAL-HIGH-003/item.json:104`; `evals/review-benchmark/golden.test.ts:41`; `packages/application/src/assurance/corpus-packet.test.ts:214` | Fixture chỉ dựng một file được label chọn. Matcher tự gán `grounded: true`. Không có digest độc lập cho packet-source, packet và prompt. | Dựng chunk theo cycle trên cả hai side. Commit các digest và chunk list. Kiểm tra output qua validation, grounding rồi matcher. |
| Tie-break dùng sai khóa. | P4-S20-MED-001 | MEDIUM | `evals/review-benchmark/matcher.ts:117` | Code so sánh pooled ID trước fingerprint. Protocol yêu cầu fingerprint. Probe cho recall 1/2 thay vì 2/2. | Tách fingerprint khỏi chunk identity. Sort theo distance, gold ID, fingerprint. Chỉ dùng chunk làm khóa cuối khi cần. |
| Degradation mất dấu âm. | P4-S20-MED-002 | MEDIUM | `evals/review-benchmark/floors.ts:63`; `evals/review-benchmark/statistics.test.ts:79` | Recall tăng từ 10/20 lên 15/20 bị báo degradation bằng 0. Công thức đã khóa cho kết quả −0.25. | Giữ hiệu có dấu khi báo kết quả. Sửa oracle đang yêu cầu giá trị 0. |
| Synthetic fields chưa vào corpus. | P4-S20-MED-003 | MEDIUM | `evals/review-corpus/collect.ts:859`; `evals/review-benchmark/synthetic.ts:109` | Không item nào trong 153 corpus item có synthetic record. Helper hiện chỉ sinh fresh-review record. | Ghi synthetic fields theo recipe vào item trước freeze. Ghi đúng round, repair base và priors cho Rule C. |
| Build include đi trước staging. | P4-S20-LOW-001 | LOW | `evals/tsconfig.json:11`; `docs/implementation/phases/phase-04-plan.md:2499` | `review-benchmark/**/*.ts` đã vào build include. Plan xếp include này trong S20 integration sau S0/S1. | Hoãn include tới integration, hoặc ghi amendment được controller chấp nhận. |
| Thiếu log đổi template hash. | P4-S20-LOW-002 | LOW | `packages/application/src/assurance/prompt.ts:61`; `docs/implementation/phases/phase-04-review-log.md:1564` | Template đổi nhưng review log chưa ghi thay đổi theo R42. | Ghi hash cũ, hash mới và căn cứ giữ `review-prompt/v1`. |

Probe `FINGERPRINT_TIE_RECALL` dùng hai gold item, gồm một item có nhiều location. Sort pooled ID cho một match.

Sort fingerprint theo protocol cho hai match. Đây là sai kết quả dù thứ tự mảng vẫn deterministic.

Validator chỉ chấp nhận execution không ghi nhận dưới dạng `{ verdict: 'NOT_RECORDED', environment: null, checks: [] }` (`packages/application/src/assurance/packet.ts:553`).

Runtime builder từ chối verdict `NOT_RECORDED` giả mạo trong test đã chạy (`packages/application/src/assurance/corpus-packet.test.ts:120`).

Không tìm thấy hash template cũ được persist (`git grep -n <hash> HEAD`, trong `TEMPLATE_DIGEST`).

Hash cũ là `c0cf6360f26b384db71320390c76901d737a8eb108515c6daaef88a06bf55178`.

Hash mới là `a8b62deb4368c4add78519d227d714bd7740950bef39135d9a60e08cb7f2647c`.

Giữ version được R42 cho phép tại `~/.openclaw/lanes/reconciliation-v1.md:914`.

Chưa có scorer thực thi việc từ chối `eligibleForPromotion` khác false. Plan đặt scorer trong S20 integration tại `docs/implementation/phases/phase-04-plan.md:2499`.

Vì vậy, chưa thể xác nhận I3 đã đạt. Cờ `descriptiveOnly` theo n không thay thế promotion guard (`evals/review-benchmark/statistics.ts:50`).

### Mutation không bị bắt

Đã chạy hai mutation hoàn toàn trong bộ nhớ.

1. Đổi `return gap;` thành `return variant === 'lenient' ? 0 : gap;` tại `evals/review-benchmark/matcher.ts:84`.

   Cả 11 benchmark test vẫn qua. Probe `MUTATION_LENIENT_DISTANCE` chọn finding xa thay vì finding gần.

   Test cardinality lẽ ra phải bắt mutation này tại `evals/review-benchmark/matcher.test.ts:62`. Test hiện chỉ kiểm tra nearest-first bằng strict.

2. Thêm câu `Do not report SECURITY findings.` vào rubric tại `packages/application/src/assurance/prompt.ts:51`.

   Cả 20 packet/prompt test vẫn qua. Golden round-trip không kiểm tra prompt digest cố định.

   Test lẽ ra phải bắt tại `packages/application/src/assurance/corpus-packet.test.ts:161`. I12 yêu cầu digest độc lập tại `docs/implementation/phases/phase-04-plan.md:745`.

Oracle category table và Wilson có giá trị kỳ vọng viết riêng (`evals/review-benchmark/matcher.test.ts:22`; `evals/review-benchmark/statistics.test.ts:11`).

Golden oracle yếu hơn vì bỏ qua grounding và thiếu digest hoàn chỉnh (`evals/review-benchmark/golden.test.ts:35`).

## Ranh giới

Không sửa file hoặc tạo ref. `git status --short` cuối lượt kiểm tra rỗng.

HEAD vẫn là `676fefcde9eecf7f5ff0bb996ef8e461ccd5008b` (`git rev-parse HEAD`).

Không chạy `verify:all`. Không dùng số 654/654 làm bằng chứng.

Không thấy import application trong evals qua kiểm tra import bằng `rg`. Chuỗi đường dẫn application trong fixture là dữ liệu.

Application test đọc golden JSON qua `fs` không tạo runtime import edge (`packages/application/src/assurance/corpus-packet.test.ts:163`).

Cách đọc fixture đó phù hợp kiểm thử monorepo. Nó chưa chứng minh golden recipe đầy đủ.

Không thấy time, random API, network, `process.env` hoặc `@temporalio` trong phần production được rà bằng `rg`.

Collector dùng `mkdtempSync` cho scratch directory tại `evals/review-corpus/collect.ts:669`. Tên scratch không đi vào manifest.

Các tập hợp matcher được sort bằng khóa tổng tại `evals/review-benchmark/matcher.ts:117`. Thống kê Jaccard cộng bằng phân số chính xác tại `evals/review-benchmark/statistics.ts:85`.

Không đổi ports, contracts, persistence, apps hoặc workers (`git diff --name-only 27927d9..HEAD -- …`).

Slot block còn 894 dòng và đúng SHA256 `9cc21c980d552d607c01bb0a330749eb88070b1cbdce55747fbfdc742960871a` (`BOUNDARY_PROOF`).

Sáu private-history commit được kiểm tra không có ref chứa chúng (`BOUNDARY_PROOF`).

Policy vẫn đặt R1 ở shadow và khai báo comparator khác họ (`policies/review-policy.yaml:60`; `policies/review-policy.yaml:74`).

## Kết luận

**S19 freeze chưa đủ chấp nhận.** Manifest lặp lại được, nhưng packet eligibility và packet sources chưa được chốt đầy đủ.

**S20 pure core chưa đủ chấp nhận.** Cần sửa tie-break, degradation, synthetic records và golden proof.

I5/I6/I11 còn phụ thuộc scorer integration. I12 chưa được golden hiện tại chứng minh (`docs/implementation/phases/phase-04-exit-criteria.md:148`).

Kết quả hiện tại không cung cấp căn cứ kích hoạt D-2 hoặc promote reviewer (`docs/implementation/phases/phase-04-plan.md:477`).
