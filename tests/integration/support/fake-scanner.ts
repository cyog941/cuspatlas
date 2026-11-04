import type { MalwareScannerPort, ScanVerdict } from '@cuspatlas/contracts';

/**
 * Synthetic malware scanner (test only). No real scanner is qualified. It reports `infected` for
 * bytes carrying the synthetic signature below (an EICAR-like marker string, deliberately NOT the
 * real EICAR test file so host antivirus never quarantines this repository), `unknown` for the
 * outage marker or while `outage` is set, and `clean` otherwise.
 */
export const SYNTHETIC_MALWARE_SIGNATURE = 'CUSPATLAS-SYNTHETIC-MALWARE-TEST-SIGNATURE';
export const SYNTHETIC_SCAN_OUTAGE = 'CUSPATLAS-SYNTHETIC-SCANNER-CANNOT-DECIDE';

export interface FakeScanner extends MalwareScannerPort {
  outage: boolean;
  readonly calls: number;
}

const contains = (bytes: Uint8Array, text: string) =>
  Buffer.from(bytes).includes(Buffer.from(text, 'latin1'));

export function createFakeScanner(): FakeScanner {
  let calls = 0;
  return {
    outage: false,
    get calls() {
      return calls;
    },
    async scan(bytes): Promise<ScanVerdict> {
      calls += 1;
      if (this.outage || contains(bytes, SYNTHETIC_SCAN_OUTAGE)) return 'unknown';
      return contains(bytes, SYNTHETIC_MALWARE_SIGNATURE) ? 'infected' : 'clean';
    },
  };
}
