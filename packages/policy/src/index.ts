import type { RiskLevel } from '@asep/contracts';

export interface GatePolicy {
  readonly independentReviewers: number;
  readonly requireDifferentModelFamily: boolean;
  readonly requireHumanMerge: boolean;
  readonly requireHumanRelease: boolean;
  readonly allowAutoMerge: boolean;
}

export function gatePolicy(risk: RiskLevel): GatePolicy {
  switch (risk) {
    case 'R0': return { independentReviewers: 0, requireDifferentModelFamily: false, requireHumanMerge: false, requireHumanRelease: false, allowAutoMerge: true };
    case 'R1': return { independentReviewers: 1, requireDifferentModelFamily: false, requireHumanMerge: false, requireHumanRelease: false, allowAutoMerge: true };
    case 'R2': return { independentReviewers: 1, requireDifferentModelFamily: true, requireHumanMerge: true, requireHumanRelease: false, allowAutoMerge: false };
    case 'R3': return { independentReviewers: 2, requireDifferentModelFamily: true, requireHumanMerge: true, requireHumanRelease: true, allowAutoMerge: false };
    case 'R4': return { independentReviewers: 2, requireDifferentModelFamily: true, requireHumanMerge: true, requireHumanRelease: true, allowAutoMerge: false };
    default: return assertNever(risk);
  }
}

export function canUseExperimentalOutputReducer(input: {
  risk: RiskLevel; commandCategory: 'LISTING'|'DIAGNOSTIC'|'SECURITY'|'MIGRATION'|'MACHINE_READABLE'; rawCaptured: boolean;
}): boolean {
  if (!input.rawCaptured) return false;
  if (input.risk === 'R3' || input.risk === 'R4') return false;
  return input.commandCategory === 'LISTING';
}

function assertNever(value: never): never { throw new Error(`Unhandled risk level: ${String(value)}`); }
