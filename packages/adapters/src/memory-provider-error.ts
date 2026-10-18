/** Thrown when a memory provider would contact a private endpoint without deployment-owner authorization. */
export class MemoryProviderDeploymentOwnerRequiredError extends Error {
  readonly code = "DEPLOYMENT_OWNER_REQUIRED" as const;
  constructor(message = "This memory provider endpoint requires deployment-owner authorization.") {
    super(message);
    this.name = "MemoryProviderDeploymentOwnerRequiredError";
  }
}
