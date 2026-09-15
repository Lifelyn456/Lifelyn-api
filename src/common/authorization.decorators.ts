import { SetMetadata } from "@nestjs/common";

export const PUBLIC_KEY = "lifelyn:public";
export const SKIP_AUTHORIZATION_KEY = "lifelyn:skip-authorization";
export const REQUIRES_AUTHORIZATION_KEY = "lifelyn:requires-authorization";

/** Route is unauthenticated by design (token issuance, health checks, internal service-to-service auth). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Route is authenticated but intentionally does not consult AuthorizationService — e.g. it only
 * ever reads/writes the caller's own identity, never another patient's consent-gated resource.
 * The reason is required so the exemption is a reviewable decision, not a silent omission.
 */
export const SkipAuthorization = (reason: string) => SetMetadata(SKIP_AUTHORIZATION_KEY, reason);

/**
 * Route touches a patient-owned, consent-gated resource and MUST call AuthorizationService.assert()
 * during handling. AuthorizationEnforcementInterceptor fails the request closed if it doesn't.
 */
export const RequiresAuthorization = () => SetMetadata(REQUIRES_AUTHORIZATION_KEY, true);
