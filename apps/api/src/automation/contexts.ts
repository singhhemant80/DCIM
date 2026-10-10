/** SecretBox AAD strings for Phase 8 secrets: a ciphertext only decrypts for the row it was written for. */
export const webhookContext = (orgId: string, id: string) => `webhook_subscription:${orgId}:${id}`;
export const billingContext = (orgId: string, id: string) => `billing_integration:${orgId}:${id}`;
