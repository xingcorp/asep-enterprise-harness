# 4. State Machines

## Run state

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> DISCOVERY
  DISCOVERY --> SPECIFICATION_REVIEW
  SPECIFICATION_REVIEW --> ARCHITECTURE_REVIEW
  ARCHITECTURE_REVIEW --> PLANNING
  PLANNING --> READY
  READY --> EXECUTING
  EXECUTING --> VERIFYING
  VERIFYING --> INDEPENDENT_REVIEW: pass
  VERIFYING --> REPAIRING: fail
  INDEPENDENT_REVIEW --> INTEGRATING: approve
  INDEPENDENT_REVIEW --> REPAIRING: changes
  REPAIRING --> VERIFYING
  INTEGRATING --> PRODUCT_ACCEPTANCE
  PRODUCT_ACCEPTANCE --> RELEASE_REHEARSAL
  RELEASE_REHEARSAL --> DONE
  DRAFT --> CANCELLED
  EXECUTING --> PAUSED
  EXECUTING --> BLOCKED
  EXECUTING --> FAILED
```

## Task state

```text
PROPOSED → READY → LEASED → EXECUTING → EVIDENCE_PENDING
→ VERIFYING → REVIEWING → ACCEPTED → INTEGRATED
```

Failure/side branches: `BLOCKED`, `REPAIR_REQUIRED`, `INVALIDATED`, `BUDGET_EXHAUSTED`, `CANCELLED`.

A downstream task is invalidated when an upstream contract, schema or architecture decision changes beyond its compatibility envelope.

## Finding lifecycle

```text
OPEN → ACKNOWLEDGED → FIXED → VERIFIED → CLOSED
                  ↘ REFUTED → ADJUDICATED
                  ↘ WAIVED (human + expiry + rationale)
```

A model cannot waive HIGH/CRITICAL findings. Waivers expire and are linked to risk acceptance owners.
