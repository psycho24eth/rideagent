export type ProviderErrorCode =
  | "configuration_missing"
  | "human_action_required"
  | "unsupported_operation"
  | "transport_not_configured"
  | "transport_error"
  | "correlation_mismatch";

/** A stable, inspectable error shape for provider integrations. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly provider: string;
  readonly details?: Readonly<Record<string, string>>;

  constructor(
    provider: string,
    code: ProviderErrorCode,
    message: string,
    details?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.code = code;
    this.details = details;
  }
}

export class ProviderConfigurationError extends ProviderError {
  constructor(provider: string, missing: readonly string[]) {
    super(
      provider,
      "configuration_missing",
      `Missing ${provider} configuration: ${missing.join(", ")}`,
      { missing: missing.join(",") },
    );
    this.name = "ProviderConfigurationError";
  }
}

export class HumanActionRequiredProviderError extends ProviderError {
  readonly deepLink: string;

  constructor(provider: string, deepLink: string) {
    super(
      provider,
      "human_action_required",
      "This provider requires the rider to complete booking in the linked app or website.",
      { deepLink },
    );
    this.name = "HumanActionRequiredProviderError";
    this.deepLink = deepLink;
  }
}

export class UnsupportedProviderOperationError extends ProviderError {
  constructor(provider: string, operation: string) {
    super(provider, "unsupported_operation", `${provider} does not support ${operation}.`, {
      operation,
    });
    this.name = "UnsupportedProviderOperationError";
  }
}
