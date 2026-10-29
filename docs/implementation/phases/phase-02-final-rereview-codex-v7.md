<!-- PROVENANCE NOTE (added when this transcript was committed to the repo).

Independent re-review, cycle 7. Reviewer: Codex `gpt-6.1-sol`, run through the
kiro-proxy gateway, on 2026-10-29. Reviewed snapshot: `863fed0` (full SHA
`863fed0832507a5efeab1a914bbda23309d59a5b`, branch
`phase/02-single-agent-vertical-slice`), a separate copy of the tree, not the
implementer's worktree. The run was interrupted by provider quota errors (HTTP
429, then 503) and resumed three times in the same Codex session; the text below
is the reviewer's final output, verbatim. The implementer's cycle-7 follow-up
commits (`ec280f8`..`f3bb704`) came after this snapshot and are not covered by
it. The controller's own gate run at `863fed0`, on a clean detached worktree,
observed `pnpm verify:all` exit 0 (648 pass, 0 fail, 0 skipped; 56 files, 34
required suites) and `pnpm test:integration` exit 0 (25 pass; 7 itest files, 7
required suites). Dispositions for every finding are recorded in
`phase-02-review-log.md` ("Final review cycle 7 dispositions").
-->

VERDICT: REQUEST_CHANGES  confidence 0.99

| ID | verdict | file:line bằng chứng | ghi chú ngắn |
|---|---|---|---|
| HIGH-001 | RESOLVED | `.github/workflows/ci.yml:89`; `scripts/integration/run-integration.mjs:152,188`; `scripts/integration/lib.mjs:31` | Integration vẫn bắt buộc và fail-closed. Kết quả chạy toàn gate không xác minh được trong phiên này. |
| HIGH-002 | PARTIAL | `scripts/lib/ts-guard.mjs:194,451`; `packages/application/src/pipeline-steps.ts:178`; `adapters/command-runner/src/command-runner.ts:52` | Waiver đã bỏ. Object-rest vẫn giữ claim isolation nhưng bỏ trường Docker, khiến runner chạy trên host. |
| HIGH-003 | REGRESSED | `packages/application/src/governed-execution.ts:169`; `packages/application/src/resume-attempt.ts:64,143,193,235` | Đường chạy mới vẫn admission đúng. Đường resume mới không kiểm risk trước lease, push hoặc PR. |
| HIGH-004 | RESOLVED | `apps/control-plane-api/src/app.ts:112`; `apps/control-plane-api/src/principal-resolver.ts:71,78,84` | Organization creation vẫn cần operator capability. Project membership vẫn lấy từ authority phía server. |
| HIGH-005 | PARTIAL | `adapters/persistence/src/migrations.ts:489,501,204,131,90` | Side-effect identity và outcome đã chặt hơn. PR, lease và các artifact reference khác vẫn thiếu coherence bắt buộc. |
| HIGH-006 | PARTIAL | `adapters/persistence/src/side-effect-log.ts:171`; `adapters/persistence/src/migrations.ts:656`; `packages/application/src/resume-attempt.ts:199,218` | Takeover đã có fencing. Resume vẫn bỏ cửa sổ commit/evidence; liveness dùng thời điểm bắt đầu transaction. |
| HIGH-007 | RESOLVED | `packages/application/src/execute-task.ts:124`; `adapters/git-worktree/src/git-worktree.test.ts:282` | Inspection vẫn từ chối HEAD movement và agent-created commit. |
| HIGH-008 | PARTIAL | `adapters/agent-claude/src/claude-provider.ts:204,473,543,577`; `adapters/agent-claude/src/agent-sandbox.itest.ts:259` | CLI, input và proxy credential đã sửa đáng kể. Host-gateway isolation chưa được chặn hoặc kiểm chứng. |
| HIGH-009 | PARTIAL | `scripts/pilot/authority-resolver.mjs:165,209`; `scripts/pilot/verify-pilot-manifest.mjs:170,326,365` | Byte hash, live head và signature binding đã sửa. Verifier vẫn nhận fake provider và provenance tự khai. |
| MED-001 | RESOLVED | `adapters/persistence/src/concurrency.itest.ts:59,98,129,156` | Các bài kiểm PostgreSQL nhiều connection vẫn tồn tại. Không tái chạy được backend thật. |
| MED-002 | RESOLVED | `adapters/github-app/src/forge-provider.ts:289,405`; `adapters/github-app/src/credential-provider.ts:79` | `resolveRef()` dùng cùng bounded re-mint và bypass credential cache khi refresh. |
| MED-003 | RESOLVED | `apps/control-plane-api/src/vertical-slice.itest.ts:158,184,198`; `packages/application/src/completion-observer.ts:19` | Kiểm mười span, correlation và audit vẫn được giữ. |
| MED-004 | RESOLVED | `apps/control-plane-api/src/principal-resolver.ts:84`; `packages/application/src/registration.ts:180`; `scripts/lib/ts-guard.mjs:564` | Membership đi qua application use case. Typed guard bắt persistence call theo declaration. |
| MED-005 | PARTIAL | `docs/implementation/phases/phase-02-report.md:13,25,41,166`; `docs/implementation/phases/phase-02-exit-criteria.md:118` | Report đã phân biệt self-review với acceptance. Claim implementation complete vẫn vượt trạng thái implementation thực tế. |
| MED-006 | RESOLVED | `apps/control-plane-api/src/pilot-faults.test.ts:146,244,274`; `docs/implementation/phases/phase-02-pilot-rehearsal.md:65,106` | Fault 3/5 đã đi qua governed pipeline và adapter thật. Sai phạm recovery còn thuộc HIGH-006. |
| MED-NEW-001 | RESOLVED | `adapters/persistence/src/object-store-s3.itest.ts:62,76,94,106`; `scripts/integration/lib.mjs:48` | Suite MinIO thật vẫn kiểm bytes, create-only, idempotency và missing object. |
| MED-NEW-002 | RESOLVED | `scripts/integration/lib.mjs:43`; `apps/control-plane-api/src/vertical-slice.itest.ts:145` | Vertical slice real-backend vẫn là required suite. |
| CYCLE5-PROVENANCE | RESOLVED | `docs/implementation/phases/phase-02-final-rereview-codex-v5.md:1`; `docs/implementation/phases/phase-02-final-rereview-codex-v6.md:1`; lệnh `git rev-parse HEAD` | Provenance note phân biệt snapshot cũ. HEAD review hiện tại đúng `863fed0832507a5efeab1a914bbda23309d59a5b`. |
| CYCLE5-PILOT-TEST | RESOLVED | `apps/control-plane-api/src/pilot-main.test.ts:31`; `scripts/lib/canonical-tests.mjs:181` | Pilot entrypoint test vẫn tồn tại và bắt buộc. |
| MED-NEW-003 | PARTIAL | `scripts/cold-cache-reset.sh:33,39,44,55` | Lỗi `rm` đã được bắt. Lỗi discovery từ `find` vẫn bị mất, khiến reset báo PASS. |
| MED-NEW-004 | PARTIAL | `scripts/pii-scan.sh:106,118,147,187`; `docs/implementation/phases/phase-02-review-log.md:380` | Metadata được quét nhưng PII cũ được grandfather. Quyết định owner chỉ có lời ghi của implementer. |

## Giới hạn tự khai của implementer

| Mục | Đánh giá | Bằng chứng |
|---|---|---|
| (2) Static guard có thể bị né | Không đủ để đóng HIGH-002. Runtime hiện kiểm boolean tự khai, không kiểm execution capability. Object-rest đã né được mà không cần runtime computation. | `pipeline-steps.ts:178`; `command-runner.ts:52`; `ts-guard.mjs:194` |
| (3) Model API là kênh dữ liệu tin cậy | Chấp nhận trong threat model hiện tại. Không được diễn giải thành khả năng ngăn exfiltration qua nội dung model request. | `docs/implementation/phases/phase-02-threat-model-delta.md:34`; `egress-proxy.mjs:115,140` |
| (4) `dockerBinary` là config seam | Chấp nhận khi binary thuộc cấu hình tin cậy. Production root không truyền binary tùy ý từ request. | `adapters/command-runner/src/sandbox.ts:147`; `apps/control-plane-api/src/production-root.ts:155` |
| (5) Timeout chỉ kill Docker client | Phải sửa trong Phase 2. Process group của Docker client không chứa tiến trình container do daemon quản lý. | `command-runner.ts:75,86,96`; `sandbox.ts:174`; exit criteria `F3:67` |
| (6) Resume chỉ hỗ trợ commit và evidence bền vững | Không chấp nhận như giới hạn Phase 2. D8 yêu cầu phục hồi giữa commit và evidence mà không tạo commit thứ hai. | `resume-attempt.ts:199,218`; exit criteria `D8:49` |
| (7) Lease thiếu FK tới attempt; TTL lớn hơn agent budget | FK vẫn phải sửa. TTL check đã có nhưng không chứng minh lease thuộc attempt và binding đúng. | `migrations.ts:131,589`; `governed-execution.ts:181` |
| (8) Prefix check nhận `fake-claude` | Phải sửa. Đây là đúng loại fake adapter mà K5 yêu cầu từ chối. | `verify-pilot-manifest.mjs:61,326`; exit criteria `K5:113` |
| (9) Verifier cần build trước | Chấp nhận. Prerequisite và lỗi hướng dẫn đã được ghi rõ. | `authority-resolver.mjs:402`; `phase-02-pilot-runbook.md:95` |
| (10) Bắt buộc `ASEP_OBJECT_STORE_DIR` | Chấp nhận. Đây là thay đổi hợp đồng vận hành có tài liệu, giúp verifier đọc lại bytes bền vững. | `pilot-main.ts:164`; `phase-02-pilot-runbook.md:89` |
| (12) Shared PGlite wasm ảnh hưởng dev server | Chấp nhận về thiết kế. Module được chia sẻ nhưng mỗi lần `create()` vẫn tạo PGlite instance mới. Dev-server runtime không xác minh được. | `pglite-client.ts:50,63,71`; `apps/control-plane-api/src/server-main.ts:41` |

Các mục (5), (7), (8) vẫn chưa được sửa trong snapshot này. Các locus tương ứng nằm tại `command-runner.ts:96`, `migrations.ts:131` và `verify-pilot-manifest.mjs:61`.

## Regression check

Đã đối chiếu đủ 15 commit bằng history, diff và code hiện tại. Lệnh `git log --reverse --oneline 00a6889..HEAD` trả đúng range người dùng nêu.

| Commit | Kết quả tự kiểm |
|---|---|
| `ae3ac32` | Commit thêm transcript cycle 6 và provenance note tại `phase-02-final-rereview-codex-v6.md:1`. |
| `5e171a3` | Helper reset bắt lỗi removal nhưng vẫn mất lỗi discovery tại `cold-cache-reset.sh:39,44`. |
| `367395b` | Metadata scan đã thêm; ngoại lệ legacy vẫn tồn tại tại `pii-scan.sh:106,187`. |
| `d5b2edd` | Credential recovery đã hợp nhất tại `forge-provider.ts:289,405`. |
| `31aeca7` | Migration 0013 đóng side-effect identity và shape tại `migrations.ts:452,489,501`. |
| `94504b2` | `git show 94504b2` chỉ đổi comment và tên test; assertion không đổi. |
| `c11078e` | Takeover và resume đã thêm. Scope recovery bị thu hẹp tại `resume-attempt.ts:23,199,218`. |
| `ab580a6` | Containment, proxy, input bytes và strict fake CLI đã thêm tại `claude-provider.ts:424,543,552`. |
| `37956ac` | Waiver bị bỏ. Typed guard vẫn thiếu object-rest tại `ts-guard.mjs:194`. |
| `c7f7e59` | Membership đã chuyển qua use case tại `principal-resolver.ts:84` và `registration.ts:180`. |
| `a73ddb6` | Shared wasm giữ instance riêng tại `pglite-client.ts:50,71`. |
| `a52f6fa` | Evidence bytes, live PR head và signed payload đã được đối chiếu tại `authority-resolver.mjs:194,250,261`. |
| `0d23b31` | Local repository lookup đã lazy tại `binding-resolver.ts:104`. |
| `5981089` | Fault 3/5 đã inject vào pipeline tại `pilot-faults.test.ts:146,244`. |
| `863fed0` | Report ghi rõ chưa được review, nhưng vẫn claim implementation complete tại `phase-02-report.md:13,25`. |

Các kiểm tra regression đã chạy:

- `git diff --diff-filter=D --name-status 00a6889..HEAD -- '*test*'` trả rỗng. Không có file test bị xóa.
- `rg` cho `.skip`, `.todo`, `.only` và option `skip:` chỉ thấy hai test live opt-in thực sự.
- Hai test đó nằm tại `claude-live.live.ts:126,175`. G6 cho phép live test opt-in tại `phase-02-exit-criteria.md:79`.
- Diff `packages/contracts`, `packages/policy`, canonical runner, integration runner và CI workflow trả rỗng.
- Required suite được bổ sung, không bị bỏ: canonical tại `canonical-tests.mjs:91`; integration tại `integration/lib.mjs:31`.
- `verify-all.sh:75` thay reset inline bằng helper. Các gate cũ vẫn còn tại `verify-all.sh:77`.
- Các test waiver cũ bị thay khi API waiver bị xóa. Guard mới có mutation fixtures tại `ts-guard.test.ts:79,107,143,300`.
- Fake CLI mạnh hơn bản cũ: unknown option bị từ chối tại `fake-claude-cli.mjs:65`.
- Lệnh `node scripts/testing/fake-claude-cli.mjs --cycle7-invented-flag` đã trả lỗi unknown option.
- Local forge chuyển PR từ memory sang file tại `adapters/local-doubles/src/index.ts:89,104,139`. Git push thật vẫn còn tại dòng 134.
- Test verifier mới lại coi fake adapter là genuine tại `pilot-verifier.test.ts:49,164,189`. Đây là weakness cần sửa.
- Rehearsal mới hợp thức hóa “new attempt” sau lỗi evidence tại `pilot-faults.test.ts:181`. Điều này trái D8, dù fault injection đã tốt hơn.

Suite guard đã chạy 14/14 trên worktree có dependencies. Hai file guard và suite đã được đối chiếu trùng bytes với snapshot. Kết quả này không thay thế gate toàn snapshot.

Không chạy `verify:all` vì reset/build sẽ ghi hoặc xóa file. Snapshot không có `node_modules`.

Lệnh Docker đọc trạng thái daemon bị từ chối với lỗi `permission denied` trên Docker socket. Integration, host-gateway canary và live pilot không xác minh được.

`git status --porcelain` tại snapshot trả rỗng sau review. Không sửa file nào.

## Finding mới

### CYCLE7-HIGH-001 — Object-rest làm mất containment nhưng giữ claim isolation

Invariant gốc HIGH-002 yêu cầu command thực thi trong sandbox thật. Boolean tự khai không đủ chứng minh containment. Nguồn: `phase-02-final-review-codex-v1.md:15`.

Guard kiểm object literal và spread assignment tại `ts-guard.mjs:451`. Visitor không kiểm object binding/rest tại `ts-guard.mjs:194`.

Fixture virtual đã dùng phép biến đổi sau trong `SandboxProvider.start()`:

```ts
const { runFlags, image, ...handle } = await docker.start(profile, mount);
return handle;
```

Probe guard trả `{"violations":[],"filesChecked":1}`. Các control alias, computed property và object spread đều bị bắt.

Handle còn `isolationEnforced: true`, nên qua runtime refusal tại `pipeline-steps.ts:178`. Handle thiếu `runFlags/image`, nên runner chọn host spawn tại `command-runner.ts:52`.

Probe vô hại với handle tương ứng đã trả exit code `0` và output `CYCLE7_HOST_EXECUTION`.

Cần bỏ fallback host đối với handle claim isolation. Không thể chỉ dựa vào mở rộng static blacklist.

### CYCLE7-HIGH-002 — Hierarchy và authoritative references chưa đóng kín

Invariant gốc HIGH-005 áp dụng mọi child row và authoritative artifact reference. Nguồn: `phase-02-final-review-codex-v1.md:46`.

Migration 0013 đã sửa đúng side-effect identity tại `migrations.ts:489`. Tuy nhiên, PR vẫn có hai FK độc lập tại `migrations.ts:220,222`.

Probe PGlite in-memory đã chạy 14 migration SQL từ snapshot. Insert PR thuộc binding B nhưng attempt thuộc binding A đã thành công.

Lease cũng nhận attempt không tồn tại. Schema chỉ FK tới binding tại `migrations.ts:131`.

Các reference sau vẫn là JSONB tùy ý:

- `runs.product_spec_ref` tại `migrations.ts:72`.
- `tasks.work_order_ref` tại `migrations.ts:90`.
- `attempts.context_pack_ref` tại `migrations.ts:113`.

Probe insert `work_order_ref` tùy ý đã thành công. Workflow cũng không attach WorkOrder sau khi tạo artifact tại `vertical-slice-workflow.ts:286,351`.

`result_ref.commit.evidenceId` chỉ được kiểm cú pháp ULID tại `migrations.ts:511`. Đây chưa phải scoped artifact reference kèm checksum.

Các lỗ này vẫn vi phạm C2b/D6 tại `phase-02-exit-criteria.md:33,47`.

### CYCLE7-HIGH-003 — Recovery thu hẹp cửa sổ crash bắt buộc

Invariant gốc HIGH-006 yêu cầu restart hội tụ sau mọi boundary commit/object/GitHub. Nguồn: `phase-02-final-review-codex-v1.md:58`.

Resume từ chối commit record còn `PENDING` tại `resume-attempt.ts:204`. Resume cũng từ chối evidence chưa đọc được tại dòng 218.

Trong khi đó, reconciliation commit đã tồn tại tại `pipeline-steps.ts:349`. Đường resume mới không gọi cơ chế này.

Crash sau Git commit nhưng trước `log.complete()` vì vậy bị chuyển thành “new attempt”. Crash giữa commit và evidence cũng bị xử lý như vậy tại `resume-attempt.ts:229`.

Đây không phải scope Phase 3. D8 yêu cầu chính cửa sổ này tại `phase-02-exit-criteria.md:49`.

Test mới đang khẳng định giới hạn đó tại `crash-recovery.test.ts:299,314` và `pilot-faults.test.ts:181`. Cần sửa implementation và expectation tương ứng.

Về race, hai successor được bảo vệ bởi unique ACTIVE và unique epoch tại `migrations.ts:147,598`. Completion kiểm current owner dưới row lock tại `side-effect-log.ts:245,258`.

Tuy nhiên, fence chỉ chạy trước boundary tại `completion-observer.ts:54`. Push/PR không nhận fencing epoch tại `pipeline-steps.ts:653,777`.

Zombie bị dừng giữa `begin()` và external call vẫn có thể gọi forge sau takeover. Completion SQL bị từ chối không thu hồi external call. Race in-flight này chưa được tái hiện trên PostgreSQL/GitHub thật.

### CYCLE7-HIGH-004 — `--internal` chưa chứng minh agent chỉ tới được proxy

Invariant HIGH-008 yêu cầu runnable governed slice dùng containment đúng. Egress boundary được khai thêm tại `phase-02-threat-model-delta.md:34`.

Agent chỉ được attach mạng riêng tại `claude-provider.ts:205`. Proxy có hai network tại dòng 517 và 583.

Nhưng mạng riêng chỉ dùng `network create --internal` tại `claude-provider.ts:543`. Không có cấu hình isolated gateway hoặc rule chặn host trong đường này.

Internal bridge không đồng nghĩa loại bỏ host bridge address. Vì vậy claim “no gateway” tại `phase-02-pilot-runbook.md:36` vượt cấu hình đã thiết lập.

Canary chỉ thử public IPv4, upstream ở network khác và DNS mặc định tại `fake-claude-cli.mjs:405`. Canary chưa thử host gateway, host services hoặc IPv6.

Runtime bypass trên daemon hiện tại không xác minh được vì Docker socket bị từ chối. Không thể dùng canary hiện có để kết luận “chỉ proxy”.

Proxy application-level đã tốt hơn:

- Method/path được allowlist tại `egress-proxy.mjs:25,102`.
- Upstream hostname luôn cố định tại dòng 115.
- Absolute-form, CONNECT và upgrade bị từ chối tại dòng 95,143,148.
- Không thấy cơ chế follow redirect hoặc chọn arbitrary upstream trong code này.

Credential model được đưa qua proxy stdin tại `claude-provider.ts:577`. Agent chỉ có placeholder tại dòng 473.

Output được redact trước artifact tại `claude-provider.ts:728,749`. Audit boundary không mang model key tại `completion-observer.ts:38`.

Không tìm thấy đường bình thường đưa model key vào Docker argv hoặc container env. Kiểm tra `docker inspect` thực tế không xác minh được.

GitHub installation token vẫn nằm trong host Git argv qua URL tại `forge-provider.ts:334,338,415`. Đây là phần tin cậy host hiện có; không nên claim mọi credential đều vắng khỏi argv.

CLI flags hiện dùng khớp help của Claude `2.1.286` đã đọc. Không tái chạy được real-CLI container conformance.

Fake CLI từ chối flag lạ, nhưng fake và provider vẫn có thể cùng thêm một flag tự đặt. Conformance thật tại `claude-live.live.ts:175` là opt-in, không thuộc hai gate.

### CYCLE7-HIGH-005 — Verifier vẫn có thể chứng nhận pilot không genuine

Invariant HIGH-009 cấm proof tự khai thay authority. Nguồn: `phase-02-final-review-codex-v1.md:91`.

Verifier đã re-hash evidence bytes tại `authority-resolver.mjs:194`. Live PR head và signed result/attempt/PR cũng được kiểm tại `verify-pilot-manifest.mjs:410,438`.

Nhưng authority lookup không lấy task status, risk, WorkOrder hoặc provider session tại `authority-resolver.mjs:165`.

WorkOrder hash và session chỉ được kiểm uniqueness từ manifest tại `verify-pilot-manifest.mjs:170`. Sandbox provenance không được đối chiếu.

Fake-provider blacklist tại `verify-pilot-manifest.mjs:61` nhận cả `fake-claude` và `seam-test-agent`.

Evidence resolver chỉ trích bốn identity fields tại `authority-resolver.mjs:209`. JSON thiếu checks, diff và environment vẫn có thể được coi là bundle.

Probe in-memory đã dùng resolver thật, evidence bytes và chữ ký Ed25519 thật. Mười task với WorkOrder/session bịa và provider `fake-claude` được trả `ok: true`.

Cùng fixture khai risk `R4` cũng được trả `ok: true`. Đây là probe logic verifier, không phải live pilot.

Test mới phản ánh đúng lỗ này tại `pilot-verifier.test.ts:49,164,189`. Cần kiểm authoritative WorkOrder, session, state, risk, canonical evidence và provenance thực thi.

### CYCLE7-HIGH-006 — Verification timeout không dừng container

`command-runner.ts:86` chỉ signal process group của child Docker client. Timeout và abort gọi cơ chế này tại dòng 96 và 101.

`DockerSandboxProvider.stop()` lại không làm gì tại `sandbox.ts:174`. Không có container name/cid để cleanup.

`--rm` chỉ cleanup khi container kết thúc. Nó không bảo đảm container kết thúc khi Docker client bị SIGKILL.

Container có thể tiếp tục dùng CPU hoặc ghi working tree sau khi runner trả lỗi. Điều này vi phạm F3 tại `phase-02-exit-criteria.md:67`.

Cần kill và xác nhận container đã dừng trước khi hoàn tất cleanup. Agent provider đã có cơ chế `docker rm -f` riêng tại `claude-provider.ts:652`.

Runtime survivor không xác minh được trong phiên này.

### CYCLE7-HIGH-007 — Resume bypass risk admission

Đường `governedExecution()` vẫn admission trước lease tại `governed-execution.ts:169`.

Đường `resumeAttemptToReview()` lại acquire lease ngay tại `resume-attempt.ts:143`. `ResumeTaskPort` chỉ yêu cầu status/version tại dòng 64.

Resume không đọc risk hoặc gọi admission trước push/PR tại `resume-attempt.ts:193,235`.

Probe ports in-memory với task risk `R4` đã ghi nhận:

```text
lease
push
create PR
task:WAITING_FOR_HUMAN_REVIEW
persist PR
```

Probe trả `stoppedAt: complete`. Đây là kiểm use case, không phải chạy GitHub thật.

Cần admission từ risk authoritative trước lease và publication. I4 yêu cầu R2–R4 fail-closed trước push tại `phase-02-exit-criteria.md:97`.

### CYCLE7-MED-001 — Lease liveness dùng transaction-start time

Không thấy process clock quyết định lease liveness trong `lease-repository.ts:63,110` hoặc `side-effect-log.ts:305`.

Tuy nhiên, cả adapter và trigger dùng `now()`. PostgreSQL giữ giá trị này từ đầu transaction.

Probe PGlite đã mở transaction trước expiry rồi chờ quá TTL. Kết quả:

```text
frozen_live: true
actually_live: false
expired-owner completion accepted
```

Trigger nằm tại `migrations.ts:656`. Adapter dùng cùng phép kiểm tại `side-effect-log.ts:305`.

Cần kiểm thời gian thực của DB tại thời điểm quyết định. Locking của trigger và adapter cũng cần nhất quán khi lease bị sweep.

### CYCLE7-MED-002 — Cold-cache discovery vẫn fail-open

Hai process substitution tại `cold-cache-reset.sh:39,44` không truyền exit status của `find` về script.

Lệnh read-only sau đã chạy:

```sh
bash -c 'find() { return 1; }; export -f find; bash scripts/cold-cache-reset.sh .'
```

Lệnh trả exit `0` và in `cold-cache reset: PASS`.

Cần bắt lỗi discovery trước removal và survivor check. Các test hiện chỉ inject lỗi removal tại `cold-cache-reset.test.ts:73,86`.

### CYCLE7-MED-003 — Integration publish database và object store trên mọi host interface

Runner dùng port mapping không có host IP tại `run-integration.mjs:135,147`. Helper truyền nguyên mapping vào `docker -p` tại `integration/lib.mjs:143`.

Credential cố định nằm tại `run-integration.mjs:37`. Cấu hình này mở backend ra ngoài loopback trong thời gian gate chạy.

Cần bind rõ `127.0.0.1` và kiểm reachability từ mạng agent. Snapshot chưa chứa sửa chữa controller đã giao.

### CYCLE7-MED-004 — Ngoại lệ PII chưa chứng minh được owner disposition

Scanner cho phép một identity hash trên lịch sử được pin tại `pii-scan.sh:106,118,187`.

Do đó, sửa scanner không loại PII cũ khỏi lịch sử được publish. Đây là ngoại lệ policy, không chỉ là mở rộng coverage.

`phase-02-review-log.md:383` nói owner đã quyết định giữ history. Quyết định độc lập đó không xác minh được trong phiên này.

Không thể coi lời ghi này là bằng chứng hoàn tất yêu cầu “sửa hết”. Cần evidence disposition hoặc phương án xử lý đáp ứng publication policy.

## Tính trung thực của verdict

Report đã trung thực hơn về nguồn đánh giá. `_UNREVIEWED` và implementer self-assessment được nói rõ tại `phase-02-report.md:22,76`.

Tuy nhiên, “repaired all eleven” tại dòng 25 chưa đúng theo kết quả review này. “Runtime isolation refusal” tại dòng 169 cũng chỉ kiểm claim boolean.

Các số `648/25` được report gắn với implementation SHA `5981089` tại dòng 41,61. Không tái xác minh được toàn bộ số này.

Sentinel bản gốc đã đọc chứa đúng:

```text
863fed0832507a5efeab1a914bbda23309d59a5b
```

Giá trị này khớp SHA snapshot được review. Sentinel bị git-ignore tại `.gitignore:17`, nên việc không tự xuất hiện trong snapshot không phải finding riêng.

Không xác minh được sentinel được viết LAST sau hai gate xanh tại report commit. Đọc đúng SHA chỉ chứng minh phần HEAD binding của L1.

Worktree implementer sau đó đã tiến tới HEAD khác trong lúc review. Các thay đổi sau `863fed0` không thuộc verdict này.

Nếu mọi finding được sửa, phase có thể ACCEPT ở mức `IMPLEMENTATION_COMPLETE_PILOT_PENDING`. K6/L4 cho phép trạng thái đó tại `phase-02-exit-criteria.md:114,121`.

Nhưng trạng thái pending không miễn các MUST non-live. Hiện C2b, C7, D6, D8, F3, I4 và K5 còn blocker như trên.

K2/K6 vì vậy chưa chỉ chờ credential và GitHub App. Report cũng liệt kê image, LIVE proof, durable object store và mười task có chữ ký tại `phase-02-report.md:178`.

Các disposition tự ghi `ACCEPTED` không thay thế review độc lập. Report đã thừa nhận thứ tự tin cậy này tại `phase-02-report.md:25`.

## Kết luận

Không ACCEPT Phase 2 tại `863fed0832507a5efeab1a914bbda23309d59a5b`.

Năm HIGH trọng tâm vẫn PARTIAL. HIGH-003 còn REGRESSED qua đường resume mới.

Cần sửa các blocker non-live, bổ sung regression tương ứng và chạy lại hai gate trên SHA mới.

Sau đó mới đánh giá lại `IMPLEMENTATION_COMPLETE_PILOT_PENDING` theo L1–L4 tại `phase-02-exit-criteria.md:118`.