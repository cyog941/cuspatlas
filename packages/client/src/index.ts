import { OPERATIONS, type OperationId, type Operations, type SyntheticRefusal } from './generated';

export * from './generated';

/**
 * Typed HTTP transport for the generated operation table. It carries no business logic: it fills
 * path parameters, sets the bearer token, the JSON or binary body and (for commands) the
 * Idempotency-Key, and returns either the typed result or the typed refusal. A refusal is never a
 * success: `ok` is true only for the operation's documented success status.
 */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  readonly baseUrl: string;
  /** Bearer token for the API audience (staff) or portal audience (portal operations). */
  readonly token: string | (() => string | Promise<string>);
  readonly fetch?: Fetch;
  /** Idempotency key source for commands; defaults to crypto.randomUUID. */
  readonly idempotencyKey?: () => string;
}

export type CallResult<K extends OperationId> =
  | {
      readonly ok: true;
      readonly status: number;
      readonly data: Operations[K]['result'];
      readonly correlationId: string | null;
      readonly deprecation: string | null;
      readonly sunset: string | null;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly refusal: SyntheticRefusal;
      readonly correlationId: string | null;
    };

export type CallInput<K extends OperationId> = {
  readonly params?: Operations[K]['params'];
  readonly body?: Operations[K]['body'];
  /** Closed: only the operation's documented query parameters (A-S6). */
  readonly query?: Operations[K]['query'];
  /** Overrides the generated key for a deliberate retry of the same command. */
  readonly idempotencyKey?: string;
};

export interface CuspAtlasClient {
  call<K extends OperationId>(operation: K, input?: CallInput<K>): Promise<CallResult<K>>;
}

export function createClient(opts: ClientOptions): CuspAtlasClient {
  const doFetch: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  return {
    async call(operation, input = {}) {
      const meta = OPERATIONS[operation];
      const params = (input.params ?? {}) as Record<string, string>;
      const path = meta.path.replace(/\{(\w+)\}/g, (_m, k: string) => {
        const v = params[k];
        if (v === undefined) throw new Error(`missing path parameter ${k} for ${operation}`);
        return encodeURIComponent(v);
      });
      const qs = input.query
        ? `?${new URLSearchParams(input.query as Record<string, string>).toString()}`
        : '';
      const token = typeof opts.token === 'function' ? await opts.token() : opts.token;
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      let body: RequestInit['body'] | undefined;
      if (meta.method === 'POST') {
        if (meta.binaryRequest) {
          headers['content-type'] = 'application/octet-stream';
          body = input.body as unknown as Uint8Array<ArrayBuffer>;
        } else {
          headers['content-type'] = 'application/json';
          body = JSON.stringify(input.body ?? {});
        }
        if (meta.idempotencyKey) {
          headers['idempotency-key'] = input.idempotencyKey ?? opts.idempotencyKey?.() ?? crypto.randomUUID();
        }
      }
      const res = await doFetch(`${opts.baseUrl}${path}${qs}`, {
        method: meta.method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
      const correlationId = res.headers.get('x-correlation-id');
      if (res.status !== meta.successStatus) {
        return {
          ok: false,
          status: res.status,
          refusal: (await res.json()) as SyntheticRefusal,
          correlationId,
        };
      }
      const data = meta.binaryResult ? new Uint8Array(await res.arrayBuffer()) : await res.json();
      return {
        ok: true,
        status: res.status,
        data,
        correlationId,
        deprecation: res.headers.get('deprecation'),
        sunset: res.headers.get('sunset'),
      };
    },
  };
}
