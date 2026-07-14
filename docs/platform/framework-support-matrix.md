# Framework Support Matrix

| Tool | Support | Intended boundary | Not allowed |
|---|---|---|---|
| Temporal | Core | run/milestone/task durability | model reasoning |
| Claude Code | First-class | coding/review adapter | canonical workflow state |
| Codex | First-class | coding/review adapter | self-approval |
| OpenHands | Planned first-class | agent server, ACP, workspace provider | merge policy authority |
| Google ADK | Optional | bounded inner graph | multi-day source of truth |
| DeerFlow 2 | Optional | research/general work order | global run ownership |
| Open Design | Optional | versioned design artifacts | unapproved direct frontend mutation |
| Spec Kit | Importer | specification/governance input | sole operational state |
| Spec Kitty | Trial | work package integration | direct internal-file coupling |
| Addy Agent Skills | Vendor/import | selected engineering skills | automatic production update |
| Superpowers | Vendor/import | process skills and review patterns | assumptions about unsupported subagent tools |
| BMAD | Importer | discovery/workshop artifacts | execution controller |
| Open GSD Core | Importer/trial | planning/context methodology | canonical orchestration |
| Mem0 | Optional | episodic memory | requirements/approval/evidence |
| Graphiti | Optional | temporal relationships | canonical AST/code graph |
| RTK | Experimental | reduced listing output | trusted exit/evidence path |
| Caveman | Experimental | concise human summaries | code/config/canonical docs |
| Public skill catalog | Discovery | candidates in quarantine | bulk install |

A tool is “supported” only when there is a versioned port, adapter owner, contract tests, compatibility matrix, security review, telemetry and rollback path.
