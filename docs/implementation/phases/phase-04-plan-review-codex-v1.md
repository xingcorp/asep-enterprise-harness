# Phase 4 — Codex Plan Review v1 (verbatim)

> Provenance: independent, read-only plan review by Codex running `gpt-5.6-sol` through the kiro-proxy gateway,
> commissioned by the controller on 2026-10-29. Reviewed branch `phase/04-independent-assurance` at HEAD
> `a2a7b8a` (`a2a7b8ad09a5389339fc3ef7131ae7b2b294d97f`). Copied into the repository by the Lane B session from the
> controller's output file (sha256 of the source file: `5743097fe9ffd9b1deab94b42a9012d3c1a75650b54163776aa425de675588d0`).
> The body below is byte-identical to that file except for two edits required by repository gates: (1) the
> publication path-leak gate (`scripts/check-publication.sh` `LEAK_PATTERNS`) — in the P4-PLAN-MED-003 row, an
> absolute home-directory path to the controller-owned lane contract is rewritten to the
> `~/.openclaw/lanes/lane-contract.md` form; (2) the format gate (`scripts/format-check.sh`) — a final newline is
> added. The review is in Vietnamese, as produced. Line numbers in it refer to the documents at `a2a7b8a`, not to
> the v2 documents. Dispositions are recorded in `phase-04-review-log.md`.

---

VERDICT: REQUEST_CHANGES confidence 0.99

| ID | severity | file:line | vấn đề | thay đổi bắt buộc |
|---|---|---|---|---|
| P4-PLAN-CRIT-001 | CRITICAL | `docs/implementation/phases/phase-04-plan.md:341-347,476-486`; `docs/implementation/phases/phase-04-architecture.md:308-315,343-355`; `docs/implementation/phases/phase-04-threat-model-delta.md:46` | Packet chứa diff được dựng trước kiểm tra secret. Reviewer vẫn được gọi trước adjudication. Secret có thể bị gửi tới gateway dù sau đó bị BLOCK. | Chạy kiểm tra secret và phân loại dữ liệu trước mọi external call. Secret, binary chưa quét, hoặc omission nhạy cảm phải dừng trước gateway. Thêm test chứng minh fake gateway nhận đúng 0 request. |
| P4-PLAN-HIGH-001 | HIGH | `docs/implementation/phases/phase-04-architecture.md:292-297`; `docs/implementation/phases/phase-04-data-model.md:133-160,317-322`; `docs/implementation/phases/phase-04-exit-criteria.md:75-77` | `review_records` không có owner, fencing token, heartbeat, hoặc claim expiry. Resume được phép gọi model lại nhưng chưa có takeover an toàn. Thiết kế lặp lại Phase 2 HIGH-006. | Thêm claim lease, fencing token, expiry và transaction takeover. Test owner mới hoàn tất được sau handoff. Test owner cũ bị fence sau handoff. |
| P4-PLAN-HIGH-002 | HIGH | `docs/implementation/phases/phase-04-plan.md:446-453`; `docs/implementation/phases/phase-04-data-model.md:324-334`; `docs/implementation/phases/phase-04-exit-criteria.md:79-82` | Reviewer được tự báo finding cũ là `RESOLVED`. Chạm file hoặc vị trí trích dẫn đã đủ tránh `closure-without-change`. Cùng reviewer có thể tự xác nhận sửa của chính mình. | Giữ finding blocking cho tới khi deterministic proof, reviewer độc lập khác, hoặc human xác nhận. Cấm reviewer ban đầu tự chuyển finding sang trạng thái không blocking. |
| P4-PLAN-HIGH-003 | HIGH | `docs/implementation/phases/phase-04-plan.md:249-287,289-317,319-334`; `docs/implementation/phases/phase-04-exit-criteria.md:123-130`; `docs/implementation/phases/phase-04-risk-register.md:8-13` | Phase 2 được gọi là test split nhưng toàn bộ label đã lộ cho người thiết kế prompt. Nhãn chủ yếu do chính `gpt-5.6-sol` tạo. Hash-freeze không tạo blind holdout. | Đổi phép đo thành “descriptive rediscovery on self-labelled history”. Không dùng nó để promotion. Thêm human relabel độc lập, post-fix negative pairs và controller-signed preregistration. |
| P4-PLAN-HIGH-004 | HIGH | `docs/implementation/phases/phase-04-data-model.md:364-376`; `docs/platform/metrics-dictionary.yaml:276-314`; `docs/implementation/phases/phase-04-plan.md:492-506` | `review.completed` được phát khi round đóng. Human disposition đến sau và không sửa immutable event. Yield và false-positive rate sẽ dựa trên kết quả harness tự chấm. | Thêm event disposition riêng hoặc tính metric từ disposition authoritative. Test human accept/reject sau round phải làm snapshot yield thay đổi đúng. |
| P4-PLAN-HIGH-005 | HIGH | `docs/implementation/phases/phase-04-plan.md:618-627,798-801`; `packages/contracts/COMPATIBILITY.md:31-33`; `packages/contracts/src/validate.ts:48-62,76-104` | Thay live `review-report` và `finding` bằng v2 không giữ runtime v1. Validator hiện key theo logical name, không theo major. Snapshot v1 không phải runtime contract. | Chọn contract logical mới cho Phase 4. Hoặc thiết kế registry và validator version-aware, giữ đồng thời live v1 và v2. |
| P4-PLAN-HIGH-006 | HIGH | `docs/implementation/phases/phase-04-exit-criteria.md:64-69,148-155`; `docs/implementation/phases/phase-04-plan.md:777-783,800-806` | Injection suite có thể xanh khi detection bằng 0 vì D5 không có ngưỡng. D-3 không đặt quality floor. Signed promotion vẫn có thể mở R2. | Đặt floor trước capture cho recall, injection degradation, malformed rate và stability. Human chỉ quyết định trên các floor đã đạt. Self-history không được mở gating. |
| P4-PLAN-HIGH-007 | HIGH | `docs/implementation/phases/phase-04-plan.md:513-521,741-749`; `apps/control-plane-api/src/pilot-main.ts:149-180,235-256`; `adapters/agent-claude/src/claude-provider.ts:128-162` | S12 không bắt buộc real coder provider. Agent hiện chạy `--network none`, không nhận model credential, và nhận các flag ref riêng. Repair loop vẫn có thể xanh với coder fake. | Ghi Phase 2 HIGH-008 là blocker của full-loop verdict. Chỉ gọi S12 “assurance-only” trước khi real coder slice chạy thành công. |
| P4-PLAN-HIGH-008 | HIGH | `docs/implementation/phases/phase-04-architecture.md:308-321`; `docs/implementation/phases/phase-04-plan.md:256-259`; `docs/platform/verification-and-review.md:37-39`; `docs/implementation/phases/phase-04-risk-register.md:30` | Packet chỉ chứa verification verdict. Nó loại raw output và deterministic findings. Reviewer không thể phát hiện skipped test, fake backend, hoặc evidence reduction sai. | Thêm bounded execution manifest, command, exit status, environment digest và raw-evidence references. Thêm seeded false-green case mà reviewer hoặc deterministic checker phải bắt. |
| P4-PLAN-MED-001 | MEDIUM | `docs/implementation/phases/phase-04-exit-criteria.md:24-27,161-164`; `docs/implementation/phases/phase-04-plan.md:515-521`; `scripts/lib/canonical-tests.mjs:85-105` | Coverage guard chỉ kiểm file, registry và marker. Nó không chứng minh named test đã chạy hoặc assertion thật sự kiểm MUST. | Ghi proof manifest từ test reporter. Mỗi MUST trọng yếu cần mutation âm tính làm gate đỏ. |
| P4-PLAN-MED-002 | MEDIUM | `docs/implementation/90-day-plan.md:33-40`; `docs/implementation/phases/phase-04-plan.md:798-806`; `docs/implementation/phases/phase-04-exit-criteria.md:136-140` | D-6 cho phép dashboard xanh mà Grafana chưa từng load provisioning. J3 chỉ kiểm cấu trúc JSON và dictionary. | Chạy Grafana digest-pinned trong required integration gate. Query API để xác nhận datasource, dashboard và panel load thành công. |
| P4-PLAN-MED-003 | MEDIUM | `~/.openclaw/lanes/lane-contract.md:46-64`; `docs/implementation/phases/phase-04-plan.md:601-605,629-638`; `docs/implementation/phases/phase-04-data-model.md:251-252,254-273` | Plan tuyên bố có full DDL nhưng bỏ artifact FKs và trigger body. Controller chưa đủ dữ liệu để reconcile migration chính xác. | Ghi đầy đủ DDL, constraint names, indexes, trigger functions và rollback migration trước plan lock. |
| P4-PLAN-MED-004 | MEDIUM | `docs/implementation/phases/phase-04-plan.md:374-375,693-695`; `docs/implementation/phases/phase-04-architecture.md:48-50,349-355`; `docs/implementation/phases/phase-04-threat-model-delta.md:39-42` | Credential được đọc từ process environment tại call time. Điều này không tương đương “adapter-only”. Live gateway path chỉ là opt-in capture hoặc smoke. | Inject credential source tại composition root. Giới hạn lifetime và hỗ trợ rotation. Thêm required production-path test khi credential được cung cấp. |
| P4-PLAN-MED-005 | MEDIUM | `docs/implementation/phases/phase-04-plan.md:731-749` | S11 gộp steps, admission, events và hai drivers. S12 gộp composition với bốn backend. S13 gộp evaluator, persistence và Grafana. | Tách S11–S13 thành commit nhỏ theo ownership. Mỗi commit cần acceptance check riêng và rollback độc lập. |
| P4-PLAN-LOW-001 | LOW | `docs/implementation/phases/phase-04-plan.md:132-146` | Claim baseline xanh chưa được xác minh độc lập. Lệnh `pnpm verify:all` đã chạy nhưng exit 1 vì `EPERM` khi tạo temp trong sandbox read-only. | Controller phải chạy lại từ clean writable checkout. Lưu exit code, test count, required-suite count và exact HEAD. |

## Ý kiến về D-1 … D-7

- **D-1:** Chọn phương án **(b)**. Runtime validator hiện không hỗ trợ nhiều major cho cùng logical name (`packages/contracts/src/validate.ts:76-104`).

- **D-2:** Chọn **không cho R1**. R1 hiện không bắt human merge và còn cho auto-merge theo policy (`policies/approval-matrix.yaml:32-40`).

- **D-3:** Hai lựa chọn hiện tại đều thiếu. Dùng numeric safety floors đã preregister, sau đó yêu cầu human approval (`docs/architecture/adr/0014-human-accountability.md:10-16`).

- **D-4:** Comparator khác family phải là bắt buộc cho self-history. Comparator vẫn không thay thế human relabel độc lập (`docs/implementation/phases/phase-04-plan.md:249-255`).

- **D-5:** Chọn **yes**, nhưng guard phải chạy trước gateway và trước push (`docs/implementation/phases/phase-04-plan.md:341-352`).

- **D-6:** Chọn **yes**. Scope yêu cầu dashboard, không chỉ evaluator hoặc JSON (`docs/implementation/90-day-plan.md:33-40`).

- **D-7:** Chọn **amend**. `maxRounds=2` và blocking sets có thể giữ thử nghiệm (`docs/implementation/phases/phase-04-data-model.md:395-408`).

- Ngưỡng `n < 20` chỉ nên gắn nhãn mô tả. Nó không được dùng làm promotion threshold (`docs/implementation/phases/phase-04-research-register.md:86-89`).

## Tích hợp với Phase 3 và Phase 2

Thiết kế giữ đúng ranh giới orchestration-agnostic. Plan cấm Temporal imports và giữ orchestration authority ở Lane A (`phase-04-plan.md:27-29`; `lane-contract.md:37-44`).

Chữ ký slot nhìn chung đủ để bọc thành Temporal activity. Input và output là dữ liệu JSON; `AbortSignal` cùng clock nằm trong activity context (`phase-04-plan.md:533-590`).

Slot còn thiếu claim owner và fencing identity. Thiếu chúng, retry sau lease handoff không thể tiếp quản `PENDING` an toàn (`phase-04-architecture.md:292-302`).

Dải migration `0200–0299` đúng lane contract (`lane-contract.md:63-64`; `phase-04-plan.md:629-636`).

Xung đột `attempts.status` đã được nhận diện. Controller phải tạo một migration chứa hợp của cả hai lane (`phase-04-plan.md:633-636`).

`run-event` minor bump cũng cần một owner duy nhất. Plan đã thừa nhận Lane A có thể đổi cùng contract (`phase-04-plan.md:620-625`).

Phase 4 đang lặp lỗi takeover của Phase 2. Test hiện tại chỉ chứng minh owner mới bị từ chối, không chứng minh takeover (`adapters/persistence/src/side-effect-log.test.ts:255-271`).

Phase 4 chưa thể dựa vào real repair loop của Phase 2. Current agent không có network hoặc model credential (`pilot-main.ts:153-157`; `claude-provider.ts:128-142`).

Không xác minh được directory ownership với plan thực tế của Lane A. Lane contract cấm đọc hoặc sửa worktree lane khác (`lane-contract.md:70-78`).

S1–S10 và S14–S16 có deliverable tương đối rõ. S11–S13 cần tách nhỏ trước implementation (`phase-04-plan.md:731-749`).

## Kết luận

Plan phủ đủ danh mục Days 46–60 trên giấy (`docs/implementation/90-day-plan.md:33-40`; `phase-04-plan.md:174-184`).

R2 admission và signed promotion là scope mở rộng nguy hiểm. Phần này nên hoãn tới independent corpus và promotion floors (`phase-04-plan.md:176-183,777-783`).

Current-state audit §1.1 được xác minh bằng schemas và compat gate (`review-report.schema.json:8-14`; `finding.schema.json:8-18`; `compat-gate.ts:184-250`).

Current-state audit §1.2 được xác minh. Lệnh `rg` chỉ tìm thấy `ReviewProvider` tại `packages/ports/src/index.ts:68-77`.

Current-state audit §1.3 được xác minh bằng policy và admission code (`approval-matrix.yaml:32-60`; `risk-admission.ts:127-134`).

Current-state audit §1.4 được xác minh. Pipeline đi thẳng từ evidence sang push (`pipeline-steps.ts:946-984`).

Current-state audit §1.5 được xác minh. Metrics chỉ được validate; không có runtime event store (`metrics.ts:215-230`; `migrations.ts:424-438`).

Current-state audit §1.6 được xác minh. Forbidden-imports chỉ phân tích import specifiers (`scripts/forbidden-imports.test.ts:48-88`).

Current-state audit §1.7 được xác minh bằng adapter, composition root và required-suite registries (`claude-provider.ts:251-260`; `production-root.ts:101-171`; `canonical-tests.mjs:91-185`).

Các count corpus 49, 20, 15 và 2 được xác minh bằng `rg -o ... | sort -u | wc -l`.

Các SHA `bb11d00` và `89a745b` tồn tại nhưng không reachable. SHA `7e5a911` không tồn tại, theo lệnh `git cat-file -e`.

Với corpus hiện tại, verdict trung thực là `IMPLEMENTATION_COMPLETE_DESCRIPTIVE_SELF_HISTORY_ONLY_UNVALIDATED`.

Verdict này không được mở R2 gating. Exit “reviewer performance measured” chưa đủ độ tin cậy để gọi là production-valid (`phase-04-plan.md:236-287`).
