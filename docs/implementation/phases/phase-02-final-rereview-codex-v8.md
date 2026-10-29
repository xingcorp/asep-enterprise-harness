<!-- PROVENANCE NOTE (added when this transcript was committed to the repo).

Independent re-review, cycle 8. Reviewer: Codex `gpt-6.1-sol` (Codex CLI
0.165.0, read-only sandbox, reasoning effort xhigh), run through the kiro-proxy
gateway, finished 2026-10-30. Reviewed snapshot: `d1d9e7a` (full SHA
`d1d9e7a694dfa744e128172bf99ace53f406bb20`, branch
`phase/02-single-agent-vertical-slice`), a separate copy of the tree, not the
implementer's worktree. Single uninterrupted run; the text below is the
reviewer's final output, verbatim. The controller's own gate run at `d1d9e7a`,
on a clean detached worktree, observed `pnpm verify:all` exit 0 (762 pass, 0
fail, 0 skipped; 57 files, 35 required suites) and `pnpm test:integration` exit
0 (34 pass; 7 itest files, 7 required suites). Dispositions for every finding
are recorded in `phase-02-review-log.md` ("Final review cycle 8
dispositions"). One edit to the verbatim text: the absolute path of the
controller's gate log, which lies outside the repository, is shortened to
`<controller lane directory>/…`, as the publication gate's path scan requires.
-->

VERDICT: REQUEST_CHANGES  confidence 0.99

| ID | verdict | file:line bằng chứng | ghi chú ngắn |
|---|---|---|---|
| HIGH-001 | RESOLVED | `scripts/integration/lib.mjs:32`; `.github/workflows/ci.yml:99` | Integration vẫn bắt buộc và không được skip khi thiếu backend. |
| HIGH-002 | PARTIAL | `adapters/command-runner/src/sandbox.ts:77,220`; `adapters/command-runner/src/command-runner.ts:90` | Object-rest đã bị chặn. Mảng flags vẫn sửa được qua handle thật. |
| HIGH-003 | RESOLVED | `packages/application/src/governed-execution.ts:170`; `packages/application/src/resume-attempt.ts:154` | Cả execution mới và resume đều admission trước lease. |
| HIGH-004 | RESOLVED | `apps/control-plane-api/src/app.ts:113`; `apps/control-plane-api/src/principal-resolver.ts:78,84` | Organization creation vẫn kiểm operator. Membership vẫn lấy từ authority phía server. |
| HIGH-005 | PARTIAL | `adapters/persistence/src/migrations.ts:190,830,934,1024` | PR và các reference được sửa đã chặt hơn. Reference stdout/stderr vẫn không có scoped FK. |
| HIGH-006 | PARTIAL | `packages/application/src/resume-attempt.ts:230,255`; `adapters/github-app/src/forge-provider.ts:368,386` | Recovery sau commit đã sửa đáng kể. Remote fencing vẫn có race tái hiện được. |
| HIGH-007 | RESOLVED | `adapters/git-worktree/src/worktree-manager.ts:180,206` | Inspection vẫn phát hiện HEAD movement và agent-created branch. |
| HIGH-008 | RESOLVED | `adapters/agent-claude/src/claude-provider.ts:120,132,593`; `adapters/agent-claude/src/agent-sandbox.itest.ts:329` | Network đã dùng isolated gateway và kiểm lại trước attachment. Giới hạn kiểm chứng nêu dưới. |
| HIGH-009 | PARTIAL | `scripts/pilot/authority-resolver.mjs:347`; `scripts/pilot/verify-pilot-manifest.mjs:816` | Probe fake cũ bị từ chối. Verifier vẫn nhận verification thiếu mandatory levels. |
| MED-001 | RESOLVED | `adapters/persistence/src/concurrency.itest.ts:211,267` | Các kiểm tra PostgreSQL nhiều connection vẫn còn. |
| MED-002 | RESOLVED | `adapters/github-app/src/forge-provider.ts:428` | Reconciliation dùng cùng bounded credential recovery. |
| MED-003 | RESOLVED | `apps/control-plane-api/src/vertical-slice.itest.ts:168,184,198` | Assertions về mười span, correlation và audit vẫn còn. |
| MED-004 | RESOLVED | `apps/control-plane-api/src/principal-resolver.ts:84` | Membership vẫn đi qua application use case. |
| MED-005 | PARTIAL | `docs/implementation/phases/phase-02-report.md:13,92,99`; `docs/implementation/phases/phase-02-exit-criteria.md:119` | Nguồn self-assessment được khai rõ. Claim implementation complete vẫn vượt implementation hiện tại. |
| MED-006 | RESOLVED | `apps/control-plane-api/src/pilot-faults.test.ts:193`; `apps/control-plane-api/src/crash-recovery.test.ts:385` | Recovery test đã kiểm cùng attempt và evidence đã reserve. |
| MED-NEW-001 | RESOLVED | `scripts/integration/lib.mjs:49`; `adapters/persistence/src/object-store-s3.itest.ts:62` | Suite MinIO thật vẫn bắt buộc. |
| MED-NEW-002 | RESOLVED | `scripts/integration/lib.mjs:44` | Vertical slice thật vẫn thuộc required suites. |
| CYCLE5-PROVENANCE | RESOLVED | `docs/implementation/phases/phase-02-final-rereview-codex-v7.md:1`; lệnh `git rev-parse HEAD` | Provenance phân biệt snapshot cũ. HEAD hiện tại đúng SHA được giao. |
| CYCLE5-PILOT-TEST | RESOLVED | `apps/control-plane-api/src/pilot-main.test.ts:31`; `scripts/lib/canonical-tests.mjs:181` | Pilot entrypoint test vẫn tồn tại và bắt buộc. |
| MED-NEW-003 | RESOLVED | `scripts/cold-cache-reset.sh:35,43,52` | Discovery failure hiện làm reset thất bại. |
| MED-NEW-004 | RESOLVED | `scripts/pii-scan.sh:118,187`; `docs/implementation/phases/phase-02-review-log.md:895` | Controller đã cung cấp quyết định owner độc lập trong đề bài. |
| CYCLE7-HIGH-001 | PARTIAL | `adapters/command-runner/src/sandbox.ts:79,228,231` | Capability lookup đúng identity nhưng cấu hình bên trong chưa bất biến. |
| CYCLE7-HIGH-002 | PARTIAL | `adapters/persistence/src/migrations.ts:190,191`; `adapters/persistence/src/persistence.test.ts:926` | Coverage chỉ liệt kê năm nhóm reference và bỏ command output. |
| CYCLE7-HIGH-003 | PARTIAL | `adapters/github-app/src/port-adapter.ts:66`; `adapters/github-app/src/forge-provider.ts:379,386` | Push bỏ epoch. PR kiểm epoch bằng read-then-update không atomic. |
| CYCLE7-HIGH-004 | RESOLVED | `adapters/agent-claude/src/claude-provider.ts:137,603`; `adapters/agent-claude/src/agent-sandbox.itest.ts:331,355,364` | Đã thêm host-service, gate-port, DNS và IPv6 canary. Metadata chưa có probe riêng. |
| CYCLE7-HIGH-005 | PARTIAL | `scripts/pilot/verify-pilot-manifest.mjs:842,849`; `policies/verification-matrix.yaml:21` | “Có một mandatory check” chưa chứng minh đủ mandatory levels. |
| CYCLE7-HIGH-006 | RESOLVED | `adapters/command-runner/src/command-runner.ts:146,181`; `adapters/command-runner/src/container-teardown.ts:74` | Timeout/cancel đã xử lý container identity và xác nhận không còn container. |
| CYCLE7-HIGH-007 | RESOLVED | `packages/application/src/resume-attempt.ts:154`; `packages/application/src/resume-attempt.test.ts:121` | Probe R4 dừng sau duy nhất `task.get`. |
| CYCLE7-MED-001 | RESOLVED | `adapters/persistence/src/migrations.ts:784`; `adapters/persistence/src/side-effect-log.ts:353` | Adapter và trigger dùng đồng hồ DB tại thời điểm quyết định. |
| CYCLE7-MED-002 | RESOLVED | `scripts/cold-cache-reset.sh:36` | Probe discovery lỗi trả exit 1 và không in PASS. |
| CYCLE7-MED-003 | RESOLVED | `scripts/integration/lib.mjs:151,168`; `scripts/integration/run-integration.mjs:135,147` | Backend publication bắt buộc bind `127.0.0.1`. |
| CYCLE7-MED-004 | RESOLVED | `scripts/pii-scan.sh:183`; `docs/implementation/phases/phase-02-review-log.md:899` | Quyết định giữ lịch sử đã được controller xác nhận cùng các lựa chọn. |

Các ID không có tiền tố giữ nghĩa trong bảng cycle 7. Các ID `CYCLE7-*` giữ nghĩa finding mới của cycle đó.

## Giới hạn tự khai của implementer

| Mục | Đánh giá | Bằng chứng |
|---|---|---|
| (a) Push không lưu epoch; GitHub PR không có CAS | **Phải sửa trong Phase 2.** Đây vẫn vi phạm invariant chống zombie, không chỉ thiếu telemetry. | `adapters/github-app/src/port-adapter.ts:66`; `adapters/github-app/src/forge-provider.ts:379`; probe `CYCLE8_PR_AFTER_ZOMBIE`. |
| (b) Người ghi được DB và object store có thể giả provenance | **Chấp nhận trong trust boundary hiện tại.** Harness, DB và artifact authority thuộc phía tin cậy. Thiếu FK tới reservation không tự tạo thêm bypass đã chứng minh. | `docs/implementation/phases/phase-02-threat-model-delta.md:12,23`; `scripts/pilot/authority-resolver.mjs:423`. |
| (c) CONFORMANCE chưa chạy lại sau network change | **Chấp nhận cho PILOT_PENDING.** Không đủ chứng minh LIVE với cấu hình pilot hiện tại. | `docs/implementation/phases/phase-02-report.md:78`; `docs/implementation/phases/phase-02-pilot-runbook.md:28`. |
| (d) CI chưa kiểm Docker Engine ≥ 28 | **Chấp nhận như giới hạn tương thích.** Provider kiểm capability thực tế và fail-closed trước khi attach agent. | `.github/workflows/ci.yml:89`; `adapters/agent-claude/src/claude-provider.ts:603`. |
| (e) Timeout khoảng 30 giây dưới tải | **Chấp nhận như rủi ro ổn định test còn mở.** Không có bằng chứng timeout bị đổi thành thành công. Nguyên nhân timeout không xác minh được. | `scripts/run-canonical-tests.mjs:68,100`; `adapters/agent-claude/src/claude-provider.ts:110`; `adapters/command-runner/src/container-teardown.ts:42`. |
| (f) MED-004 thiếu các lựa chọn trong review log | **Đã đủ disposition để đóng finding.** Controller xác nhận owner chọn giữ lịch sử và chặn từ nay. | Xác nhận controller trong đề bài, ngày 2026-10-29 lúc 07:15 UTC; `scripts/pii-scan.sh:187`. |

Phần (b) không đồng nghĩa DB/object-store writer tự tạo được chữ ký reviewer mới. Resolver vẫn xác minh Ed25519 tại `scripts/pilot/authority-resolver.mjs:492`.

Verifier vẫn kiểm attempt, result SHA và PR được ký tại `scripts/pilot/verify-pilot-manifest.mjs:548`. Lỗ mandatory coverage dưới đây độc lập với giới hạn đặc quyền này.

CONFORMANCE chạy real CLI qua fake Docker tại `adapters/agent-claude/src/claude-live.live.ts:210,218`. Vì vậy, chạy lại CONFORMANCE cũng không thay thế LIVE container proof.

Không gán timeout 30 giây cho lỗi V8 mà controller đã chẩn đoán. Hai timeout hữu hạn tồn tại riêng tại `claude-provider.ts:110` và `container-teardown.ts:42`.

Chạy riêng file xanh không chứng minh gate toàn bộ xanh. Log controller tại HEAD hiện tại ghi cả hai gate xanh; nguồn chứng cứ nêu dưới.

Ngoại lệ PII chỉ áp dụng identity hash trong lịch sử được pin tại `scripts/pii-scan.sh:118`. Commit mới mang identity đó vẫn bị từ chối tại dòng 187.

## Regression check

Đã đối chiếu range bằng `git log --reverse --oneline 863fed0..HEAD`. Range có 19 commit.

| Commit | Kết quả đối chiếu |
|---|---|
| `ec280f8` | Publication đi qua loopback validator tại `scripts/integration/lib.mjs:151,168`. |
| `7d1b4df` | Lease có composite FK tới attempt cùng tenant/binding tại `adapters/persistence/src/migrations.ts:757`. |
| `d5e4bb3` | Resolver đọc artifact của đúng attempt tại `scripts/pilot/authority-resolver.mjs:300`. |
| `dec962b` | Teardown xóa theo identity và kiểm survivor tại `adapters/command-runner/src/container-teardown.ts:74`. |
| `f3bb704` | `git show --format= --name-only f3bb704` xác nhận chỉ đổi report và review log. |
| `215db41` | Transcript có provenance note tại `docs/implementation/phases/phase-02-final-rereview-codex-v7.md:1`. |
| `61138bd` | `find` chạy trong điều kiện kiểm exit status tại `scripts/cold-cache-reset.sh:36`. |
| `78413e3` | `git show 78413e3` xác nhận thay đổi newline của transcript. |
| `de0fba1` | Lookup dùng identity tại `command-runner.ts:78`. Freeze vẫn shallow tại `sandbox.ts:79`. |
| `946ba77` | Resume đọc risk authoritative trước lease tại `packages/application/src/resume-attempt.ts:154`. |
| `8c3f970` | Liveness, heartbeat và sweep dùng `clock_timestamp()` tại `lease-repository.ts:72,84,122`. |
| `54af435` | Migration thêm scoped reference tại `migrations.ts:934`. Command output vẫn bị bỏ sót tại dòng 190. |
| `0e7eb0d` | Draft được lưu trước reservation tại `adapters/persistence/src/evidence-store.ts:126`. |
| `7fdd47d` | Commit được ghi create-only vào attempt ref tại `worktree-manager.ts:300`. |
| `3de3f08` | Confirmation có thật tại `pipeline-steps.ts:784`. PR vẫn có TOCTOU tại `forge-provider.ts:386`. |
| `9d782c1` | Provider tạo rồi inspect isolated network tại `claude-provider.ts:593,603`. |
| `f11d49b` | Verifier kiểm task và provenance nhưng thiếu mandatory coverage tại `verify-pilot-manifest.mjs:816`. |
| `7bbee45` | Disposition owner được ghi tại `phase-02-review-log.md:895`. |
| `d1d9e7a` | Report khai rõ self-assessment tại `phase-02-report.md:92`. Claim reference đầy đủ vẫn sai tại dòng 99. |

Các kiểm tra regression đã chạy:

- `git diff --diff-filter=D --name-status 863fed0 HEAD -- '*test*'` trả rỗng.
- Tìm `.skip`, `.todo`, `.only` chỉ thấy hai live test opt-in tại `claude-live.live.ts:139,188`.
- Diff `packages/contracts`, `packages/policy`, `scripts/verify-all.sh`, canonical runner và CI workflow trả rỗng.
- Required integration suites vẫn đủ tại `scripts/integration/lib.mjs:32`.
- Required canonical suites thêm resume tại `scripts/lib/canonical-tests.mjs:209`.
- Fake Docker thêm lifecycle state và network inspection tại `scripts/testing/fake-docker.mjs:8,139`.
- Fake CLI vẫn kiểm input hash tại `scripts/testing/fake-claude-cli.mjs:225`.
- `git diff --check 863fed0 HEAD` thành công.
- `git status --porcelain=v1` trả rỗng sau review.

Không phát hiện gate bị nới trong các diff trên. Tuy nhiên, có test mới khẳng định hành vi quá rộng.

Test verifier coi R1 chỉ có L0/L1 là genuine tại `verify-pilot-manifest.test.ts:232,243,387`. Test còn cho L1 thất bại dưới nhãn advisory tại dòng 893.

Đây không phải sửa đúng mandatory matrix. R1 yêu cầu L0/L1/L2 tại `policies/verification-matrix.yaml:22`.

Ngược lại, recovery tests đã sửa implementation lẫn invariant cần kiểm. Chúng assert cùng attempt tại `crash-recovery.test.ts:379,414`.

Các test đó đối chiếu evidence với reserved draft tại `crash-recovery.test.ts:372,408`. Vì vậy, đây không chỉ là đổi expected value.

Các probe cycle 7 đã chạy lại bằng loader TS trong bộ nhớ. Source lấy từ snapshot hiện tại; không build hoặc sửa file.

| Probe | Kết quả quan sát |
|---|---|
| Object-rest giữ `isolationEnforced: true` | `CYCLE7_OBJECT_REST true SandboxHandleNotProvenError`. Không xuất hiện `CYCLE7_HOST_EXECUTION`. |
| PR có binding khác attempt | DB từ chối bằng constraint `pull_requests_attempt_binding_fk`. |
| Resume task R4 | Dừng tại `admission`; call list chỉ có `task.get`. |
| Mười task `fake-claude`, R4, WorkOrder/session bịa | Probe dùng SQL resolver, PGlite và chữ ký thật bị từ chối; test 1/1 xanh. |
| Transaction mở trước expiry | `frozen_live: true`, `actually_live: false`; trigger từ chối expired-owner completion. |
| Reference command output không tồn tại | Insert thành công; finding mới ghi bên dưới. |

Probe mười task dùng Map object store thay filesystem để giữ read-only. SQL resolver và logic ký/xác minh vẫn dùng source thật.

Đã chạy 14 test persistence liên quan lease, scoped references và migration; cả 14 xanh. Đã chạy 9 test resume; cả 9 xanh.

Đã chạy 76 test verifier không cần filesystem; cả 76 xanh. Các test CLI/filesystem không thuộc lần chạy này.

Không chạy `verify:all`. Không tự chạy integration vì Docker socket trả `permission denied`.

Về migrations:

- `migrate()` trên PGlite mới áp dụng đủ 18 migration.
- Lần gọi thứ hai áp dụng 0 và skip đủ 18 migration.
- So sánh nội dung SQL xác nhận 0013–0015 không bị sửa.
- Migrator giữ checksum và transaction riêng tại `adapters/persistence/src/migrator.ts:104,119`.
- 0016 thay liveness function và giữ share lock tại `migrations.ts:777,787`.
- 0017 backfill reference hợp lệ trước khi drop JSONB tại `migrations.ts:840,857`.
- Tìm `product_spec_ref`, `work_order_ref`, `context_pack_ref` không thấy runtime reader ngoài migrations.
- Test upgrade JSONB hợp lệ và dangling reference đã chạy xanh tại `persistence.test.ts:1011`.

0018 **không nâng cấp trong suốt database đã có completed commit hoặc attached evidence**. Migration chủ động từ chối toàn bộ trường hợp đó tại `migrations.ts:1011`.

Test tương ứng đã chạy và xác nhận upgrade thất bại tại `persistence.test.ts:1061`. Đây là fail-closed, không phải bằng chứng backfill dữ liệu cũ.

Không thấy migration xóa các bản ghi đó. Transaction rollback nằm tại `migrator.ts:119`.

Trong Phase 2 chưa có live pilot, có thể chấp nhận yêu cầu database mới hoặc xử lý dữ liệu cũ riêng. Không được mô tả 0018 là upgrade tương thích mọi dữ liệu cũ.

## Mutation không bị bắt

Mutant sống mà implementer khai là equivalent với cây hiện tại.

Nhánh bị xóa là refusal cho host execution có claim isolation tại `command-runner.ts:79`. Host record duy nhất được cấp tại `sandbox.ts:254`.

Handle đó có `isolationEnforced: false` tại `sandbox.ts:259`. Handle bị freeze và hàm `issue()` không export tại `sandbox.ts:77`.

Vì vậy, không có đường cấp host record với claim `true` trong code hiện tại. Kết luận equivalent không chứng minh mảng flags cũng bất biến.

Đã thử thêm mutant sau trong bộ nhớ:

```diff
- if ((x === '--network' || x === '--net') && flags[k + 1] !== 'none') {
+ if ((x === '--network') && flags[k + 1] !== 'none') {
```

Vị trí: `scripts/pilot/verify-pilot-manifest.mjs:770`.

Cả baseline lẫn mutant đều vượt 76 test verifier đã chạy. Các test unsafe-network hiện chỉ dùng `--network` tại `verify-pilot-manifest.test.ts:870`.

Probe thêm `--net host` cho kết quả:

```text
CYCLE8_NET_ALIAS 0 false
CYCLE8_NET_ALIAS 1 true []
```

Mutant này không equivalent. Nó làm verifier nhận provenance chứa network alias nguy hiểm.

Không chạy toàn gate với mutant. Các test CLI/filesystem bị loại khỏi lần kiểm read-only này.

Không tái chạy đủ 90 mutant mà implementer báo. Con số 89/90 chỉ được ghi nhận như self-report tại `phase-02-report.md:85`.

## Finding mới

### CYCLE8-HIGH-001 — Handle thật vẫn cho sửa cấu hình execution riêng

Invariant gốc yêu cầu runner thực thi đúng containment do provider cấp. Invariant này áp dụng cả handle copy và handle gốc.

`issue()` chỉ shallow-freeze handle và execution tại `sandbox.ts:77`. Provider đặt cùng mảng `labelled` vào cả hai object tại dòng 228 và 231.

Probe trả:

```text
CYCLE8_FROZEN true false true
```

Handle frozen, mảng flags không frozen, và hai phía giữ cùng identity mảng.

Probe sau sửa thành công cấu hình trong private execution record:

```ts
h.runFlags.splice(h.runFlags.indexOf("--network")+1,1,"host");
h.runFlags.push("--privileged","-v","/var/run/docker.sock:/var/run/docker.sock");
```

`executionOf(h).runFlags` sau đó chứa `--network host`, `--privileged` và Docker socket mount.

Runner dùng chính mảng đó để tạo Docker argv tại `command-runner.ts:90`. Provenance cũng trả cùng mảng tại dòng 216.

Probe không chạy container đặc quyền. Nó chứng minh đường cấu hình bị thay đổi trước invocation thật.

Test freeze chỉ thử assignment/delete ở top level tại `command-runner.test.ts:671`. Test không thử mutation mảng lồng nhau.

Cần tách bản sao bất biến của execution config khỏi handle và provenance public. Cần regression thử `splice`, `push` và sửa qua provenance.

### CYCLE8-HIGH-002 — Authoritative command-output references vẫn không được DB bảo vệ

Invariant gốc áp dụng mọi authoritative artifact reference. D6 yêu cầu scoped FK mang artifact ID và expected checksum tại `phase-02-exit-criteria.md:47`.

`command_executions.stdout_artifact_id` và `stderr_artifact_id` vẫn là `char(26)` tại `migrations.ts:190`. Không có FK tới artifacts.

Probe trên schema đủ 18 migration insert cả hai field bằng ID không tồn tại. Insert thành công.

Query `pg_constraint` chỉ thấy attempt FK, primary key và NOT NULL của bảng này.

Danh sách reference được test chỉ gồm run, task, context pack và hai evidence links tại `persistence.test.ts:926`. Command output không nằm trong danh sách.

Do đó, claim “every authoritative reference” tại `phase-02-report.md:99` chưa đúng.

Chưa chứng minh đường đọc runtime khai thác reference này. Finding là lỗ invariant DB mà D6 yêu cầu đóng.

Cần bảo vệ hai reference bằng scope, checksum và kind tương ứng. Cần kiểm ID không tồn tại, tenant khác, checksum sai và kind sai.

### CYCLE8-HIGH-003 — Epoch chỉ thu hẹp race, không fence external publication

Invariant gốc yêu cầu owner đã bị takeover không tiếp tục external side effect. Review log cũng ghi invariant này tại `phase-02-review-log.md:720`.

`confirmOwner()` kiểm và renew lease trong transaction tại `side-effect-log.ts:242`. Transaction kết thúc trước forge call tại `pipeline-steps.ts:790,923`.

Push adapter bỏ `fencingEpoch` tại `port-adapter.ts:66`. Vì vậy, remote push không có hard fence theo epoch.

PR adapter đọc marker tại `forge-provider.ts:379`. Sau đó adapter update PR không kèm atomic precondition tại dòng 386.

Đã tái hiện race bằng `GitHubAppForgeProvider` thật với transport trong bộ nhớ:

1. Owner epoch 1 đọc PR cũ rồi bị giữ lại.
2. Owner epoch 2 cập nhật PR thành công.
3. Owner epoch 1 tiếp tục update bằng dữ liệu đã đọc.

Kết quả:

```text
CYCLE8_PR_NEW_OWNER 2
CYCLE8_PR_AFTER_ZOMBIE 1
```

Probe dùng cùng semantic body cho hai owner. Nó chứng minh epoch bị hạ, không giả định thêm payload divergence.

Test mới chỉ pause trước khi inner forge đọc PR tại `crash-takeover.itest.ts:483`. Test chưa chặn giữa `pulls.list()` và `pulls.update()`.

Test push còn chủ động cho late push tới forge tại `crash-takeover.itest.ts:498`. Completion bị từ chối sau đó không thu hồi external call.

Recovery commit/evidence đã sửa đúng các cửa sổ chính:

- Attempt ref được ghi trước HEAD movement tại `worktree-manager.ts:300,308`.
- Resume reconcile PENDING commit tại `pipeline-steps.ts:467`.
- Resume hoàn thiện evidence từ reserved draft tại `resume-attempt.ts:255`.
- Push và PR PENDING reconcile theo natural key tại `pipeline-steps.ts:763,897`.

Không tìm thấy đường tạo attempt mới sau khi attempt ref đã land trong các đường này.

Vẫn có cửa sổ `commit-tree` trước `update-ref` tại `worktree-manager.ts:291,300`. Crash ở đó để lại object chưa được ref hoặc HEAD công bố.

Resume không tìm thấy ref sẽ trả `not-resumable` tại `resume-attempt.ts:242`. Vì vậy, không được claim mọi Git-call boundary đều reconcile cùng attempt.

Không chứng minh cửa sổ object vô danh tạo duplicate commit được publish. Coverage kill ngay tại boundary này không xác minh được.

Cần cơ chế publication ngăn stale publisher thực sự, cùng test race bên trong transport. Thêm marker hoặc kiểm lease thêm lần nữa vẫn còn TOCTOU.

### CYCLE8-HIGH-004 — Verifier nhận verification thiếu mandatory assurance levels

Invariant gốc yêu cầu verifier phân biệt run genuine với proof tự khai. Mandatory matrix thuộc authority policy tại `policies/verification-matrix.yaml:21`.

Producer kiểm đầy đủ mandatory levels tại `pipeline-steps.ts:179`. Verifier chỉ yêu cầu có ít nhất một check tự khai `mandatory: true` tại `verify-pilot-manifest.mjs:842`.

Verifier không đối chiếu `level` với mandatory matrix trong `provenanceReasons()` tại dòng 788.

Đã dùng fixture authority hiện có, bỏ toàn bộ check ngoài L0 và đặt `planId: "invented"`. Các identity, artifact và agent facts còn lại giữ nguyên.

Kết quả:

```text
CYCLE8_R1_ONLY_L0 { ok: true, reasons: [] }
```

R1 yêu cầu L0/L1/L2 tại `policies/verification-matrix.yaml:22`. Run này không thể đạt producer policy hiện tại.

Positive fixture vốn đã thiếu L2 tại `verify-pilot-manifest.test.ts:232`. Test còn cho mandatory L1 thất bại khi đổi thành advisory tại dòng 902.

Đây là lỗ validation độc lập với việc người có toàn quyền DB/object store có thể giả bytes.

Cần suy ra mandatory levels từ policy trusted. Verifier phải từ chối thiếu level, level sai và mandatory bị hạ thành advisory.

## Tính trung thực của verdict

Report đã phân biệt self-assessment với acceptance tại `phase-02-report.md:15,92`. Report cũng khai đúng việc chưa chạy LIVE tại dòng 79.

Tuy nhiên, claim mọi reference đã được bảo vệ vẫn sai tại `phase-02-report.md:99`. Claim fencing vẫn chưa đạt invariant như probe trên chứng minh.

Đã đọc log controller:

`<controller lane directory>/controller-verify-d1d9e7a.log:1`

Log bind đúng HEAD `d1d9e7a694dfa744e128172bf99ace53f406bb20`.

Log ghi `verify:all exit=0` và 762/762 tại dòng 3. Log ghi integration 34/34 và required-suite PASS tại dòng 19.

Đây là kết quả controller ghi lại, không phải số implementer được mặc nhiên tin. Tôi không tự tái thực thi toàn gate.

Sentinel trong worktree implementer đã đọc chứa đúng full SHA hiện tại. `git rev-parse HEAD` tại snapshot trả cùng SHA.

Transcript `turn-3.jsonl` ghi final gates trước thao tác “Write L1 sentinel last”. Output thao tác đó ghi clean tree và cùng SHA.

Vì vậy, HEAD binding có bằng chứng phù hợp L1. Thứ tự ghi LAST có chứng cứ transcript; không có phép quan sát độc lập lúc ghi sentinel.

Sentinel không chứng minh L2. Điều kiện không còn HIGH chưa đạt tại `phase-02-exit-criteria.md:119`.

Nếu mọi finding được sửa, Phase 2 có thể ACCEPT ở mức `IMPLEMENTATION_COMPLETE_PILOT_PENDING`. K6/L4 cho phép tại `phase-02-exit-criteria.md:114,121`.

Trạng thái đó vẫn yêu cầu các MUST không phụ thuộc live pilot được đáp ứng. Nó không miễn containment, scoped references, fencing hoặc verifier correctness.

## Kết luận

Không ACCEPT snapshot `d1d9e7a694dfa744e128172bf99ace53f406bb20`.

Còn bốn HIGH cần sửa: mutable execution flags, command-output references, remote fencing và mandatory verification coverage.

Các probe gốc đã bị chặn đúng ở nhiều điểm. Các probe mới vẫn tái hiện vi phạm invariant dù gate hiện tại xanh.

Sau sửa, cần regression tương ứng và hai gate trên HEAD mới theo `phase-02-exit-criteria.md:118`.

Review giữ read-only. `git status --porcelain=v1` cuối phiên trả rỗng.
