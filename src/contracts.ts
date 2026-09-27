// The named contracts Dailies' own documents declare (ADR-0010). A document
// carries a `contract` and `schemaVersion: 1`; loading and inspection
// dispatch on the contract.

export const SINGLE_CONFIG_CONTRACT = 'dailies/single-config/v1' as const;
export const SINGLE_REPORT_CONTRACT = 'dailies/single-report/v1' as const;
export const SUITE_CONFIG_CONTRACT = 'dailies/suite-config/v1' as const;
export const SUITE_REPORT_CONTRACT = 'dailies/suite-report/v1' as const;
export const RELEASE_POLICY_CONTRACT = 'dailies/release-policy/v1' as const;

/** The configuration contracts the CLI runs and `dailies digest` updates. */
export const CONFIG_CONTRACTS: readonly string[] = [SINGLE_CONFIG_CONTRACT, SUITE_CONFIG_CONTRACT];

/** The `contract` a raw document declares, or `undefined` when it names none. */
export function declaredContract(raw: unknown): unknown {
  return typeof raw === 'object' && raw !== null && 'contract' in raw
    ? (raw as { contract?: unknown }).contract
    : undefined;
}
