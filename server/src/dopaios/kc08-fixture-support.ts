import type {
  ConnectorAdapter,
  ConnectorAdapterIdentity,
  ConnectorExecutionInput,
} from "./connector-gateway.js";

export type FakeConnectorOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: ConnectorExecutionError };

export class ConnectorExecutionError extends Error {
  constructor(
    readonly kind: "auth" | "quota" | "policy" | "transient" | "timeout",
    message: string,
    readonly retrySafe = false,
  ) {
    super(message);
    this.name = "ConnectorExecutionError";
  }
}

export function connectorAuthFailure(message: string): FakeConnectorOutcome {
  return { ok: false, error: new ConnectorExecutionError("auth", message) };
}

export function connectorTransientFailure(message: string): FakeConnectorOutcome {
  return { ok: false, error: new ConnectorExecutionError("transient", message, true) };
}

export class FakeConnector implements ConnectorAdapter {
  invocationCount = 0;
  readonly invocations: ConnectorExecutionInput[] = [];

  constructor(
    private readonly outcomes: FakeConnectorOutcome[],
    readonly identity: ConnectorAdapterIdentity,
  ) {}

  async execute(input: ConnectorExecutionInput): Promise<Record<string, unknown>> {
    this.invocationCount += 1;
    this.invocations.push(input);
    const outcome = this.outcomes.shift();
    if (!outcome) throw new ConnectorExecutionError("transient", "FakeConnector has no configured outcome");
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
