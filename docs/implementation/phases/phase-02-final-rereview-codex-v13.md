<!-- PROVENANCE NOTE (added when this transcript was committed to the repo).

Independent re-review, cycle 13. Reviewer: Codex `gpt-6.1-sol` (Codex CLI
0.165.0, read-only sandbox, reasoning effort xhigh), run through the kiro-proxy
gateway, finished 2026-10-30. Reviewed snapshot: `26d2a55` (full SHA
`26d2a55dcb3abf477278bba017e8ea1ab5b16bdb`, branch
`phase/02-single-agent-vertical-slice`), a separate copy of the tree, not the
implementer's worktree. Single uninterrupted run (exit 0, no resumes); the text
below is the reviewer's final output, in Vietnamese as written, verbatim but
for two kinds of edit. The controller's own gate runs at `26d2a55`, through
`gate.sh` with its Node-launch sampler: `pnpm verify:all` twice, exit 0, 885
pass, 0 fail each, longest Node launch 2.96 s and 3.25 s; `pnpm
test:integration` twice, exit 0, 34 of 34 each, longest launch 0.96 s and
0.74 s; no launch of 10 s or more, so all four runs are valid under R47; the
process registry found no process; no container, network or orphan left; the
sentinel equals HEAD. The controller also ended the two orphan proxies the
implementer had left (pids 4822 and 89091). The controller's decisions on this
review are reconciliation R48; dispositions for every finding are recorded in
`phase-02-review-log.md` ("Final review cycle 13 dispositions"). The edits:
four absolute paths outside the repository — the controller's reconciliation
file, its gate log for `26d2a55`, the directory holding both, and the L1
sentinel in the implementer's worktree — are shortened to
`<controller lanes directory>/…`, `<controller lane directory>/…` and
`<implementer worktree>/…`, as the publication gate's path scan requires.
Paths under `/tmp/` (the implementer's logs) are left as written; the scan
does not reject them. A final newline, which the reviewer's output lacks, is
added for the repository's format check.
-->

VERDICT: REQUEST_CHANGES  confidence 0.99

| ID | verdict | file:line bằng chứng | ghi chú ngắn |
|---|---|---|---|
| CYCLE12-HIGH-001 | PARTIAL | `adapters/agent-claude/assets/egress-proxy.mjs:77`, `:228` | Lifetime đã độc lập, nhưng clock lùi vẫn kéo dài capability. |
| CYCLE12-MED-001 | PARTIAL | `scripts/lib/process-registry.mjs:56`, `:93`; `scripts/testing/fake-docker.test.ts:34` | Registry đã có, nhưng còn lỗi nhận diện, chứng minh absence và coverage. |
| CYCLE12-MED-002 | RESOLVED | `adapters/command-runner/src/container-teardown.ts:233`, `:291` | Hai helper đều từ chối absence đến sau deadline. |
| Mutation cut | RESOLVED | `adapters/command-runner/src/command-runner.test.ts:1028` | Probe chạy lại bắt được `cutMs + 1_000`. |
| Instrumentation: client PID | RESOLVED | `adapters/command-runner/src/container-teardown.ts:104`, `:133` | Record và mô tả call đều chứa PID khi spawn thành công. |
| Instrumentation: proxy kill | RESOLVED | `adapters/agent-claude/src/claude-provider.ts:824` | Kết quả kill lỗi được giữ trong teardown notes. |
| Instrumentation: tool budget | RESOLVED | `adapters/agent-claude/src/agent-claude.test.ts:1077` | Assertion in observation và timeline khi thất bại. |
| Probe Octokit | RESOLVED | `adapters/github-app/src/github-app.test.ts:534` | Test dùng Octokit thật; probe độc lập cũng nhận đúng một PATCH. |
| CYCLE11-HIGH-002 | PARTIAL | `<controller lanes directory>/reconciliation-v1.md:1051` | Nguyên nhân chưa được chứng minh; disposition R47 đã đủ bằng chứng gate. |
| TIMEOUTS | RESOLVED | `adapters/command-runner/src/container-teardown.ts:182`, `:236`, `:293` | Phần removal cũ đã sửa; vấn đề host tuân theo R47. |
| CYCLE10-HIGH-002 | RESOLVED | `adapters/agent-claude/src/claude-provider.ts:819`; `adapters/command-runner/src/command-runner.ts:273` | Removal marker chỉ phát sau bằng chứng hợp lệ trong bound. |
| CYCLE11-HIGH-001 | RESOLVED | `packages/application/src/pipeline-steps.ts:1152` | Repair vẫn ghi PR theo số đã lưu. |
| CYCLE11-MED-001 | RESOLVED | `adapters/command-runner/src/container-teardown.ts:170`; `adapters/command-runner/src/command-runner.test.ts:1093` | Lỗi daemon không được coi là absence. |
| Concern 2 | RESOLVED | `adapters/command-runner/src/command-runner.ts:263`; `adapters/command-runner/src/command-runner.test.ts:768` | Client error sau spawn vẫn đi qua cleanup. |
| CYCLE10-HIGH-001 | RESOLVED | `packages/application/src/pipeline-steps.ts:1439`, `:1476` | Completion trả đúng observation đã kiểm. |
| HIGH-006 | RESOLVED | `packages/application/src/resume-attempt.ts:352`, `:425` | Resume vẫn reconcile rồi persist PR đã kiểm. |
| MED-005 | RESOLVED | `docs/implementation/phases/phase-02-report.md:257` | Claim publication giữ đúng phạm vi đã sửa và residual R30. |
| CYCLE7-HIGH-003 | RESOLVED | `packages/application/src/pipeline-steps.ts:1154` | Repair không chọn lại PR đích. |
| CYCLE8-HIGH-003 | RESOLVED | `packages/application/src/resume-attempt.ts:352`; `adapters/github-app/src/forge-provider.ts:474` | Write theo number và read-back vẫn được giữ. |
| Monotonic waits | RESOLVED | `adapters/command-runner/src/container-teardown.ts:182` | Diff cycle này không hoàn tác clock của removal. |

## Proxy lifetime

HEAD đã kiểm là `26d2a55dcb3abf477278bba017e8ea1ab5b16bdb`, theo `git rev-parse HEAD`.

Tôi không sửa file hoặc kill process nào. Probe chạy bằng `node --input-type=module -e`, với doubles trong RAM.

Provider tính agent deadline bằng clock monotonic. Provider chuyển thời gian còn lại sang wall clock khi tạo expiry.

Bằng chứng: `adapters/agent-claude/src/claude-provider.ts:512`, `:542`, `:674`.

```ts
const deadline = started + Math.max(1, Math.round(req.budget.maxWallClockMinutes * 60_000));
const proxyExpiresAt = Math.round(Date.now() + (deadline - monotonicNow()) + PROXY_EXPIRY_GRACE_MS);
```

Expiry dùng epoch milliseconds. Grace là `30_000` ms tại `claude-provider.ts:175`.

Sau khi nhận argv, proxy không cần worker còn sống để chạy timer. Bằng chứng: `egress-proxy.mjs:225`, `:228`.

Proxy từ chối expiry thiếu, không phải safe integer, hoặc không còn tương lai. Bằng chứng: `egress-proxy.mjs:161`, `:206`.

Expiry quá xa vẫn được nhận. Timer chia thời gian chờ thành từng đoạn `2 ** 31 - 1` ms.

Probe `CYCLE13_EXPIRY_INPUT` xác nhận `Number.MAX_SAFE_INTEGER` được nhận. Bằng chứng code: `egress-proxy.mjs:54`, `:231`.

Không có trần lifetime riêng. Schema budget cũng chỉ đặt minimum bằng zero tại `packages/contracts/schema/work-order.schema.json:41`.

Các probe bắt buộc đã chạy lại:

| Probe | Kết quả |
|---|---|
| `CYCLE12_PROXY_PARENT_LOSS-model` | Đóng stdin làm `main()` gọi exit 0 ngay. |
| `CYCLE12_PROXY_PARENT_LOSS-model`, nhánh expiry | Timer gọi exit 0 tại lifetime 60.000 ms với clock ổn định. |
| `CYCLE13_CLOCK_ROLLBACK_BEFORE_EXPIRY` | Tại elapsed 60.000 ms, proxy vẫn forward key sau khi wall clock lùi. |
| `CYCLE13_EXPIRED_LATCH_TIMER` | Request mới bị từ chối, nhưng timer vẫn dời exit nếu wall clock lùi. |

Đây là phép chạy asset thật trên process/HTTP/timer doubles. Tôi không thực hiện SIGKILL thật trong phiên này.

Test SIGKILL thật đã xanh trong hai run controller. Bằng chứng: `controller-verify-26d2a55-run1.log:42` và `controller-verify-26d2a55-run2.log:42`, dưới thư mục controller lane.

Trong production, stdin đi qua Docker client và daemon. `docker run --rm -i` giữ link tại `claude-provider.ts:345`, `:774`.

Probe Docker thủ công chỉ được ghi nhận một lần tại `phase-02-review-log.md:2125`. Tôi không xác minh lại hành vi đó.

T2-16 nói rõ không dựa vào link Docker để bảo đảm bound. Bằng chứng: `phase-02-threat-model-delta.md:35`.

Với clock ổn định và đồng bộ, cửa sổ còn lại là:

```text
max(0, agentDeadline - workerDeath + 30_000) ms
```

Vì vậy, cửa sổ có thể bằng phần budget còn lại cộng 30 giây. Bằng chứng: `claude-provider.ts:542`, `:674`.

T2-16 mô tả đúng công thức dự kiến. Claim “at most” chưa đúng vô điều kiện vì clock lùi.

Clock của proxy dùng `Date.now()` cho cả admission và timer. Bằng chứng: `egress-proxy.mjs:77`, `:229`.

Test rollback hiện tại chỉ lùi clock sau một request đã quan sát expiry. Bằng chứng: `agent-claude.test.ts:879`, `:883`.

Request mới trên keep-alive vẫn qua admission check tại `egress-proxy.mjs:88`. Request đang dở không được kiểm lại từng chunk.

Bằng chứng: `egress-proxy.mjs:131`, `:143`.

Khi timer thực sự gọi `process.exit(0)`, proxy cắt các kết nối đang mở. Bằng chứng: `egress-proxy.mjs:193`.

Tuy nhiên, probe `CYCLE13_STREAM_AFTER_EXPIRY_OBSERVED` đã forward chunk tại elapsed 61.000 ms.

Probe đã quan sát expiry trước đó, rồi lùi clock. Timer dời thêm 10.000 ms; request mới nhận 403.

Như vậy, latch admission không chặn stream đã mở. Bằng chứng: `egress-proxy.mjs:82`, `:143`, `:229`.

Runtime streaming qua mốc expiry trong Docker chưa xác minh được.

## Fixture và registry

Registry nằm ngoài test worker, dưới thư mục tạm riêng cho checkout. Bằng chứng: `scripts/lib/process-registry.mjs:33`, `:156`.

Canonical runner truyền registry qua environment rồi sweep đầu và cuối. Bằng chứng: `scripts/run-canonical-tests.mjs:79`; `process-registry.mjs:185`, `:198`.

Docker shim khôi phục biến registry sau bước lọc environment. Bằng chứng: `agent-claude.test.ts:208`; `process-registry.mjs:150`.

`startProxy` đã cleanup khi readiness thất bại. Bằng chứng: `agent-claude.test.ts:730`.

Fixture thường đã kết thúc process group trước khi xóa state. Bằng chứng: `scripts/testing/fake-docker-fixture.mjs:38`.

Tuy nhiên, sweep chưa chứng minh chắc process thuộc run đã ghi. Marker của fake container chỉ lấy hai argv đầu.

Bằng chứng: `scripts/testing/fake-docker.mjs:400`; `process-registry.mjs:98`.

Probe `CYCLE13_REGISTRY_PID_REUSE` dùng marker `/usr/local/bin/node -e`.

Một process khác có cùng prefix và PID tái sử dụng vẫn bị chọn để kill. Tín hiệu chỉ được ghi trên double.

Registry cũng coi lỗi `ps` như danh sách rỗng. Bằng chứng: `process-registry.mjs:57`, `:83`.

Probe `CYCLE13_REGISTRY_PS_FAILURE` giữ process sống nhưng nhận outcome `gone`. `endRecorded` sau đó xóa record.

Bằng chứng xóa record: `process-registry.mjs:131`.

Fake Docker dùng cùng oracle đó tại `fake-docker.mjs:96`. Probe `CYCLE13_FAKE_DOCKER_PS_FAILURE` xác nhận `stopContainer()` trả true sai.

Do đó, vẫn có đường xóa record khi process chưa chết. Bằng chứng: `fake-docker.mjs:245`, `:251`.

Các test mới cũng chưa truyền registry ngoài worker đầy đủ. `startContainer()` mặc định chỉ truyền `PATH`.

Bằng chứng: `scripts/testing/fake-docker.test.ts:34`, `:36`.

Probe `CYCLE13_TEST_HELPER_REGISTRY_GAP` xác nhận child không nhận `ASEP_PROCESS_REGISTRY`, dù parent có biến đó.

Concern (6) có bằng chứng về stale record, chưa có bằng chứng về process sống.

C5b ghi PID 32205 với outcome `gone`. Bằng chứng: `/tmp/asep-v13-c5b.log:964`, `:965`.

Race teardown có thể xảy ra giữa ghi container record và đăng ký registry. Hai thao tác tách rời tại `fake-docker.mjs:405`.

Nguyên nhân cụ thể của record C5b không xác minh được. Tôi không coi giả thuyết race là kết luận đã chứng minh.

Controller ghi zero leftovers tại `controller-gates-26d2a55.log:33`. Tôi không kiểm độc lập bảng process được.

Lệnh `ps -axo …` bị sandbox từ chối với `operation not permitted`.

## Removal và cut

Hai helper production dùng chung module teardown. Agent gọi helper theo name; runner gọi helper theo label.

Bằng chứng: `claude-provider.ts:819`; `command-runner.ts:273`.

Helper label kiểm deadline trước khi nhận listing rỗng. Helper name kiểm deadline trước khi nhận inspect absence.

Bằng chứng: `container-teardown.ts:236`, `:293`.

Probe `CYCLE12_LATE_ABSENCE` chạy lại cho kết quả:

| Trường hợp | Kết quả |
|---|---|
| `ps` trả absence tại 5.000 ms, deadline 1.000 ms | Helper từ chối, ghi trễ 4.000 ms. |
| `rm` trả tại 5.000 ms | Helper từ chối và không chạy inspect. |
| `rm` trả tại 100 ms, inspect absence tại 5.100 ms | Helper từ chối, ghi trễ 4.100 ms. |
| Absence trả đúng deadline | Helper chấp nhận theo quy tắc “by deadline”. |

Regression tương ứng nằm tại `command-runner.test.ts:1145`. Probe bao phủ cả nhánh inspect sau `rm` đúng hạn.

Probe `CYCLE12_DELAYED_CUT_MUTANT` chạy nguyên callback test Docker caller, với filesystem/process/timer doubles.

Baseline PASS với kill tại 300 ms. Mutant `cutMs + 1_000` FAIL với kill tại 1.300 ms.

Assertion mới giới hạn `cutAfterMs` tới 800 ms. Duration của call bị cut được giới hạn tới 1.200 ms.

Bằng chứng: `command-runner.test.ts:1007`, `:1029`, `:1031`.

Các allowance là 500 ms cho timer và 400 ms cho close. Đây là assertion chặt hơn trước.

Host chậm vẫn có thể làm test đỏ. R47 loại launch ≥10 giây, nhưng không bảo đảm scheduler luôn trễ dưới 500 ms.

Bằng chứng: `command-runner.test.ts:1003`; `reconciliation-v1.md:1057`.

Tôi chưa xác minh được flake của upper bound mới. Hai run controller hiện tại đều xanh hợp lệ.

## Regression check

Tôi kiểm tám commit bằng `git log --reverse --oneline d9255fb..HEAD`, `git show` và aggregate diff.

| Commit | Kết quả đối chiếu |
|---|---|
| `158608f` | Archive cycle 12 khớp transcript sau các phép chuẩn hóa đã công bố. |
| `e58c588` | Commit bổ sung deadline check và late-absence regression. |
| `87c231c` | Commit thêm upper bounds, PID và teardown diagnostics. |
| `0d95b1f` | Commit thêm lifetime, nhưng còn lỗi clock tại CYCLE13-HIGH-001. |
| `2d974cb` | Commit thêm registry và fixture cleanup, nhưng coverage chưa hoàn chỉnh. |
| `e47b2cb` | Commit sửa việc quên registry record và phân biệt record với process sống. |
| `b95cb82` | Commit thêm test Octokit thật, chỉ thay fetch. |
| `26d2a55` | Commit cập nhật docs và giảm mức chắc chắn về nguyên nhân HIGH-002. |

Phép so sánh archive trả `ARCHIVE_NORMALIZED_EQUAL true`. Provenance note nằm tại `phase-02-final-rereview-codex-v12.md:17`.

Không có file bị xóa theo `git diff --name-status --diff-filter=D d9255fb HEAD`.

Có một test declaration cũ được thay thế, không phải giữ nguyên toàn bộ declarations.

Test “without a credential” được nhập vào bảng refusal rộng hơn tại `agent-claude.test.ts:832`, `:842`.

Expected exit 2 và assertion thông báo thiếu credential vẫn còn tại `agent-claude.test.ts:846`.

Quét added lines từng commit không thấy thêm `.skip`, `.todo` hoặc `.only`.

Hai live test vẫn opt-in tại `claude-live.live.ts:143`, `:192`. Diff không mở rộng điều kiện skip.

Không thấy assertion cũ bị nới trong cycle này. Thay đổi diagnostics giữ nguyên expected status.

Bằng chứng: `git diff d9255fb..HEAD -- adapters/agent-claude/src/agent-claude.test.ts`.

Không có thay đổi policy, schema, dependency lockfile, CI hoặc required-suite registry.

Bằng chứng: `git diff --numstat d9255fb HEAD` trên các đường dẫn tương ứng.

Discovery hiện có 60 test files và 36 required suites. Tôi đã chạy `discoverTestFiles()` và đọc `REQUIRED_SUITES`.

Fault 3 vẫn yêu cầu `/object store unavailable/` tại `apps/control-plane-api/src/pilot-faults.test.ts:168`.

Production removal bounds không bị nâng. Proxy grace 30 giây là contract mới, được khai tại `claude-provider.ts:175`.

Không thấy test double cũ bị nới để bỏ qua lỗi production. Fake Docker đã mạnh hơn trong đường cleanup bình thường.

Các lỗi mới của double được liệt kê riêng bên dưới.

`--test-force-exit` không được đưa vào gate. Bằng chứng: `scripts/lib/node-test-flags.mjs:35`.

Vụ mutation treo 16 phút được công bố tại `phase-02-review-log.md:2188`. Nguyên nhân runtime đó chưa được tôi xác minh.

Kiểm an ninh trong phạm vi diff:

| Mục | Kết quả và bằng chứng |
|---|---|
| S1 — Secrets | PASS. `gitleaks git --no-banner --redact --log-opts=d9255fb..HEAD .` quét tám commit, không tìm thấy leak. |
| S2 — Capability/ownership | FAIL HIGH. Lifetime còn phụ thuộc wall clock tại `egress-proxy.mjs:77`, `:229`. |
| S3 — Input validation | PASS cho argv expiry. Safe-integer và future checks nằm tại `egress-proxy.mjs:206`. |
| S4 — Logging | Không thấy regression. Log proxy giữ method/path/status tại `egress-proxy.mjs:56`. |
| S5 — Crypto | N/A cho cơ chế ký hoặc mã hóa. Diff không đổi các cơ chế đó. |
| S6 — Transport | Không thấy nới origin/method/path. Allowlist nằm tại `egress-proxy.mjs:36`, `:105`, `:118`. |
| S7 — Dependencies | N/A. Manifest và lockfile không đổi theo `git diff --numstat`. |
| S8 — File/process identity | FAIL MED. Registry nhận diện process chưa đủ tại `process-registry.mjs:98`. |
| S9 — Error handling | FAIL MED. Lỗi `ps` bị chuyển thành absence tại `process-registry.mjs:57`. |
| S10 — Gate integrity | FAIL MED. Leftover cũ không làm gate đỏ tại `run-canonical-tests.mjs:148`. |

Semgrep và Trivy không có trong `PATH`, theo `command -v`. Tôi không khai kết quả SAST hoặc dependency audit tương ứng.

## Mutation không bị bắt

Mutation cụ thể làm yếu identity check:

```diff
-  if (command !== undefined && !command.includes(marker)) return 'not-ours';
+  if (command !== undefined && !command.includes(marker.split(' ')[0])) return 'not-ours';
```

Locus là `scripts/lib/process-registry.mjs:98`.

Probe `CYCLE13_MARKER_PREFIX_MUTANT` chạy callback negative test hiện tại trên process doubles.

Baseline và mutant đều PASS callback tại `process-registry.test.ts:54`.

Test đó dùng marker khác hoàn toàn. Nó không kiểm hai process dùng cùng executable nhưng khác phần argv sau.

Probe bổ sung dùng marker `/usr/local/bin/node -e` và command `/usr/local/bin/node /unrelated/run.js`.

Baseline trả `not-ours`. Mutant chọn process khác để kill.

Các assertion fake Docker hiện chỉ kiểm marker xuất hiện trong command. Bằng chứng: `fake-docker.test.ts:95`, `:97`.

Không có oracle âm tương ứng cho shared prefix. Tôi chưa chạy toàn suite với mutant này.

Vì vậy, kết quả đã xác minh là negative test hiện tại không phân biệt mutant. Không được diễn giải thành mutant đã sống qua `verify:all`.

Claim 39/39 mutants của implementer chưa được tôi xác minh toàn bộ. Claim nằm tại `phase-02-review-log.md:2114`, `:2180`, `:2220`, `:2238`, `:2252`.

## Finding mới

**CYCLE13-HIGH-001 — Clock lùi kéo dài model capability và có thể giữ stream sau expiry đã quan sát.**

Admission và expiry timer đều đọc `Date.now()`. Bằng chứng: `egress-proxy.mjs:77`, `:229`.

Probe rollback kéo lifetime 60.000 ms thành ít nhất 70.000 ms, khi parent link còn mở.

Probe streaming còn forward chunk sau một request đã nhận 403 vì expiry.

Bằng chứng thực thi: `CYCLE13_CLOCK_ROLLBACK_BEFORE_EXPIRY` và `CYCLE13_STREAM_AFTER_EXPIRY_OBSERVED`.

T2-16 và runbook vì vậy đang hứa bound quá chắc. Bằng chứng: `phase-02-threat-model-delta.md:35`; `phase-02-pilot-runbook.md:115`.

Cần chốt deadline monotonic trong proxy và dùng chung cho admission, timer, cùng việc kết thúc stream.

Cần thêm regression rollback trước expiry và stream đang dở. CYCLE12-HIGH-001 chưa thể đóng theo R47.

**CYCLE13-MED-001 — Registry có thể kill process khác sau PID reuse.**

Fake container marker có thể chỉ là `/usr/local/bin/node -e`. Bằng chứng: `fake-docker.mjs:400`; `fake-docker.test.ts:95`.

Registry chỉ kiểm substring, không lưu định danh lần sinh process. Bằng chứng: `process-registry.mjs:98`, `:140`.

Probe `CYCLE13_REGISTRY_PID_REUSE` xác nhận process khác cùng prefix vượt qua guard.

Cần định danh riêng cho run/process và kiểm thời điểm sinh. Không được kill khi identity chưa xác minh được.

**CYCLE13-MED-002 — Lỗi `ps` bị coi là bằng chứng process đã chết.**

`processes()` không kiểm `status` hoặc `error` của `spawnSync`. Bằng chứng: `process-registry.mjs:57`.

Output rỗng làm `stillRunning()` trả false. Registry và fake Docker sau đó có thể xóa record.

Bằng chứng: `process-registry.mjs:83`, `:131`; `fake-docker.mjs:96`, `:251`.

Hai probe `CYCLE13_REGISTRY_PS_FAILURE` và `CYCLE13_FAKE_DOCKER_PS_FAILURE` xác nhận đường này.

Cần phân biệt “gone” với “không đọc được bảng process”. Trạng thái chưa biết phải giữ record và làm cleanup thất bại.

**CYCLE13-MED-003 — Test cleanup mới vẫn tạo process ngoài registry của canonical run.**

`startContainer()` bỏ environment registry khi caller không truyền thêm env. Bằng chứng: `fake-docker.test.ts:34`, `:36`.

Test giữ process dài hạn gọi helper theo cách đó tại `fake-docker.test.ts:62`.

Một spawn trực tiếp khác cũng chỉ truyền `PATH` tại `fake-docker.test.ts:126`.

Cleanup của các process này vẫn phụ thuộc `finally` trong worker. Bằng chứng: `fake-docker.test.ts:79`, `:137`.

Probe `CYCLE13_TEST_HELPER_REGISTRY_GAP` xác nhận outer registry không tới child.

Cần đăng ký mọi helper dài hạn vào canonical registry, kể cả các test kiểm chính registry.

**CYCLE13-MED-004 — Process tồn đọng của run cũ không làm gate thất bại.**

Runner chỉ tính `stuck` từ `left`, bỏ qua `earlier`. Bằng chứng: `run-canonical-tests.mjs:148`.

Probe `CYCLE13_EARLIER_STUCK_GATE` đưa outcome `still-running` vào hai vị trí.

Với `earlier`, runner trả code 0. Với `left`, runner trả code 1.

Header của runner lại hứa process không kết thúc được sẽ làm run thất bại. Bằng chứng: `run-canonical-tests.mjs:25`.

Cần fail gate khi sweep run cũ không hoàn tất. Cần thêm negative wiring test cho nhánh này.

## Tính trung thực của verdict

Report giữ `_UNREVIEWED` và không tự nhận phase acceptance. Bằng chứng: `phase-02-report.md:13`, `:24`.

Mức chắc chắn về HIGH-002 đã được sửa đúng R47. Launch-policy queue được gọi là giả thuyết mạnh, chưa chứng minh.

Nguồn burst vẫn được ghi là chưa biết. Bằng chứng: `phase-02-review-log.md:1880`, `:2257`; `phase-02-report.md:37`.

Không cần chứng minh lại root cause để thỏa disposition L2 hiện tại. Bằng chứng: `reconciliation-v1.md:1051`.

Tôi đã đọc raw logs và tính lại bốn sampler của controller:

| Gate tại HEAD cuối | Kết quả | Samples | Launch lớn nhất | Launch ≥10 s |
|---|---:|---:|---:|---:|
| `verify:all` lần 1 | 885/885; exit 0 | 195 | 2.956 ms | 0 |
| `verify:all` lần 2 | 885/885; exit 0 | 182 | 3.245 ms | 0 |
| `test:integration` lần 1 | 34/34; exit 0 | 45 | 960 ms | 0 |
| `test:integration` lần 2 | 34/34; exit 0 | 45 | 742 ms | 0 |

Bằng chứng kết quả: `<controller lane directory>/controller-gates-26d2a55.log:1`, `:12`, `:21`, `:27`.

Raw sampler lần lượt là:

- `gate-runs/20261030-203249-controller.node-launch`.
- `gate-runs/20261030-204009-controller.node-launch`.
- `gate-runs/20261030-204707-controller.node-launch`.
- `gate-runs/20261030-204845-controller.node-launch`.

Các đường dẫn trên nằm dưới `<controller lanes directory>/`.

Đây là hai run xanh hợp lệ liên tiếp cho mỗi gate tại HEAD cuối. R47 không còn chặn acceptance.

Sentinel triển khai chứa đúng HEAD, byte-identical với output `git rev-parse HEAD`.

Bằng chứng: phép so sánh `L1_BYTE_IDENTICAL`, và `<implementer worktree>/.phase-02-implementation-complete:1`.

Snapshot review không chứa sentinel. Worktree triển khai không chứa `.task-complete`, theo lệnh kiểm file đã chạy.

Implementation SHA trong report đúng `b95cb82`. Sau SHA đó chỉ có hai file docs đổi.

Bằng chứng: `git rev-parse b95cb82`; `git diff --name-only b95cb82 HEAD`.

Claim lifetime trong report, threat model và runbook chưa khớp các probe rollback.

Bằng chứng: `phase-02-report.md:266`; `phase-02-threat-model-delta.md:35`; `phase-02-pilot-runbook.md:115`.

Claim fixture giữ record tới khi process được chứng minh chết cũng còn ngoại lệ.

Bằng chứng: `phase-02-report.md:251`; `process-registry.mjs:57`; probe lỗi `ps`.

Live CONFORMANCE chưa được xác minh lại sau thay đổi proxy. Test vẫn opt-in tại `claude-live.live.ts:192`.

Thiếu live proof được công bố đúng phạm vi pilot pending tại `phase-02-report.md:255`, `:277`.

## Kết luận

Chưa ACCEPT_PHASE vì CYCLE12-HIGH-001 và CYCLE12-MED-001 còn PARTIAL, với năm finding mới nêu trên.

Bốn gate controller hiện tại đều xanh hợp lệ. Sentinel L1 cũng đúng HEAD.

Nếu các finding còn lại được sửa, phase có thể nhận `ACCEPT_PHASE` ở mức `IMPLEMENTATION_COMPLETE_PILOT_PENDING`.

Điều kiện gồm review xác nhận sửa, docs trung thực, clean tree và sentinel đúng HEAD cuối.

Mọi commit sửa tiếp sẽ làm bằng chứng gate hiện tại stale. Cần hai run xanh hợp lệ của mỗi gate tại HEAD mới.

Bằng chứng: `phase-02-exit-criteria.md:118`, `:119`; `reconciliation-v1.md:1059`.

Không cần gọi HIGH-002 là đã tìm được nguyên nhân. Recorded disposition R47 vẫn áp dụng.

K2/K5/K6 tiếp tục pending; chưa được claim `COMPLETE` hoặc tạo `.task-complete`.

Bằng chứng: `phase-02-exit-criteria.md:110`, `:114`, `:121`.
