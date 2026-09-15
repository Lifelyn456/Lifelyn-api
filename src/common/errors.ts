import {
  Catch,
  HttpException,
  type ExceptionFilter,
  type ArgumentsHost,
} from "@nestjs/common";
import { ZodError } from "zod";
type FastifyReply = {
  status: (status: number) => { send: (body: unknown) => void };
};
type FastifyRequest = { id: string };

export class AppException extends HttpException {
  constructor(code: string, message: string, status: number) {
    super({ code, message }, status);
  }
}

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const response = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    const status = exception instanceof ZodError ? 400 : exception instanceof HttpException ? exception.getStatus() : 500;
    // Unexpected (non-HttpException, non-Zod) failures are logged server-side so they are not
    // completely invisible in production. This only ever logs the exception's own stack trace,
    // never request bodies/headers/PHI, matching the "no PHI in logs" security requirement.
    if (status === 500) console.error(`[requestId=${request.id}] Unhandled exception:`, exception);
    const payload =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const explicit =
      payload && typeof payload === "object"
        ? (payload as { code?: unknown; message?: unknown })
        : undefined;
    const message =
      exception instanceof ZodError
        ? "Request validation failed."
        : typeof explicit?.message === "string"
        ? explicit.message
        : exception instanceof HttpException
          ? exception.message
          : "An internal error occurred.";
    response
      .status(status)
      .send({
        error: {
          code:
            typeof explicit?.code === "string"
              ? explicit.code
              : status === 401
              ? "UNAUTHORIZED"
              : status === 403
                ? "FORBIDDEN"
                : status === 400
                  ? "VALIDATION_ERROR"
                  : status === 503
                    ? "SERVICE_UNAVAILABLE"
                    : "INTERNAL_ERROR",
          message,
          requestId: request.id,
        },
      });
  }
}
