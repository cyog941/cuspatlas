import { createHash } from 'node:crypto';

/**
 * Claims partner port (B6/B7; B-S2 clearinghouse qualification is blocked-on-discovery, HARDWARE-AND-
 * CLAIMS-QUALIFICATION C1/C2). Every call carries a stable key; nothing with PHI crosses it (claim
 * lines carry SYN- codes, amounts and server references only). The ONLY implementation is the fake
 * below: no X12 library, no real payer identifier, no CDT code, no network.
 */
export interface ClaimSubmitRequest {
  readonly submissionKey: string;
  readonly payerRef: string;
  readonly claimRef: string;
  readonly versionNo: number;
  readonly lines: readonly {
    readonly lineNo: number;
    readonly codeRef: string;
    readonly billedMinor: number;
  }[];
}
export type TransportAnswer =
  | { readonly outcome: 'transmitted'; readonly transportRef: string }
  | { readonly outcome: 'rejected'; readonly rejectionCode: string }
  | { readonly outcome: 'unknown' };
export interface PartnerEvent {
  readonly eventRef: string;
  readonly kind: 'payer_acknowledged' | 'payer_rejected' | 'adjudicated_paid' | 'adjudicated_denied';
  readonly code?: string;
  readonly occurredAt: string;
}
export interface RemittanceLine {
  readonly lineNo: number;
  readonly claimRef: string;
  readonly claimLineNo: number;
  readonly paidMinor: number;
  readonly contractualMinor: number;
  readonly patientResponsibilityMinor: number;
  readonly denialCode?: string;
}
/** Synthetic ERA-like structure (not X12): one payment advice with its lines. */
export interface RemittanceAdvice {
  readonly remittanceRef: string;
  readonly payerRef: string;
  readonly currency: string;
  readonly totalPaidMinor: number;
  readonly lines: readonly RemittanceLine[];
}
export interface ClaimsPartnerPort {
  submit(request: ClaimSubmitRequest): Promise<TransportAnswer>;
  /** Side-effect-free status by key; never a new submission. */
  lookup(submissionKey: string): Promise<TransportAnswer | { readonly outcome: 'not_found' }>;
  /** Responses received so far for a transmitted submission (idempotent per eventRef). */
  poll(submissionKey: string): Promise<readonly PartnerEvent[]>;
  sendAppeal(request: {
    readonly appealKey: string;
    readonly transportRef: string;
  }): Promise<{ readonly sentRef: string } | null>;
  /** Side-effect-free status of an appeal send by its key; never a new send. */
  lookupAppeal(appealKey: string): Promise<{ readonly sentRef: string } | { readonly outcome: 'not_found' }>;
  fetchRemittance(remittanceRef: string): Promise<RemittanceAdvice | null>;
}

const h = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

/**
 * The fake clearinghouse: in-process, deterministic by the synthetic payer reference.
 * `syn-payer-reject...` is a transport rejection (SYN-RJ-001); `syn-payer-transport-timeout...` answers unknown on
 * submit and transmitted on lookup; `syn-payer-deny...` acknowledges then denies (SYN-DN-045); any
 * other payer acknowledges then pays; `syn-payer-cl-reject-first` payer-rejects version 1 (SYN-RJ-014). Remittances exist only when staged (`stageRemittance`).
 */
export function createFakeClearinghouse() {
  const submitted = new Map<string, ClaimSubmitRequest>();
  const remittances = new Map<string, RemittanceAdvice>();
  const appeals = new Map<string, string>();
  const answerFor = (r: ClaimSubmitRequest): TransportAnswer =>
    r.payerRef.startsWith('syn-payer-reject')
      ? { outcome: 'rejected', rejectionCode: 'SYN-RJ-001' }
      : { outcome: 'transmitted', transportRef: `syn-tx-${h(`tx:${r.submissionKey}`)}` };
  const port: ClaimsPartnerPort & {
    stageRemittance(advice: RemittanceAdvice): void;
    submittedRequest(key: string): ClaimSubmitRequest | undefined;
  } = {
    async submit(r) {
      submitted.set(r.submissionKey, r);
      if (r.payerRef.startsWith('syn-payer-transport-timeout')) return { outcome: 'unknown' };
      return answerFor(r);
    },
    async lookup(key) {
      const r = submitted.get(key);
      return r ? answerFor(r) : { outcome: 'not_found' };
    },
    async poll(key) {
      const r = submitted.get(key);
      if (!r || answerFor(r).outcome !== 'transmitted') return [];
      const at = new Date().toISOString();
      const ack: PartnerEvent = {
        eventRef: `syn-evt-${h(`ack:${key}`)}`,
        kind: 'payer_acknowledged',
        occurredAt: at,
      };
      if (r.payerRef.startsWith('syn-payer-deny')) {
        return [
          ack,
          {
            eventRef: `syn-evt-${h(`adj:${key}`)}`,
            kind: 'adjudicated_denied',
            code: 'SYN-DN-045',
            occurredAt: at,
          },
        ];
      }
      if (r.payerRef.startsWith('syn-payer-noresponse')) return [];
      // `syn-payer-cl-reject-first...`: the payer rejects version 1 and pays a corrected replacement.
      if (r.payerRef.startsWith('syn-payer-cl-reject-first') && r.versionNo === 1) {
        return [
          ack,
          {
            eventRef: `syn-evt-${h(`prj:${key}`)}`,
            kind: 'payer_rejected',
            code: 'SYN-RJ-014',
            occurredAt: at,
          },
        ];
      }
      return [ack, { eventRef: `syn-evt-${h(`adj:${key}`)}`, kind: 'adjudicated_paid', occurredAt: at }];
    },
    async sendAppeal(r) {
      const sentRef = `syn-appeal-${h(`appeal:${r.appealKey}`)}`;
      appeals.set(r.appealKey, sentRef);
      return { sentRef };
    },
    async lookupAppeal(key) {
      const sentRef = appeals.get(key);
      return sentRef ? { sentRef } : { outcome: 'not_found' };
    },
    async fetchRemittance(ref) {
      return remittances.get(ref) ?? null;
    },
    stageRemittance(advice) {
      remittances.set(advice.remittanceRef, advice);
    },
    submittedRequest: (key) => submitted.get(key),
  };
  return port;
}
export type FakeClearinghouse = ReturnType<typeof createFakeClearinghouse>;
