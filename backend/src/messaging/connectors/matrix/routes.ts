import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from "express";
import { verifyMatrixInboundAuthorization, type MatrixHsTokenVerifier } from "./auth.js";
import { MAX_MATRIX_TRANSACTION_BYTES } from "./events.js";
import { MatrixApplicationService, MatrixServiceError } from "./service.js";

export interface MatrixRouterOptions {
  readonly verifier: MatrixHsTokenVerifier;
  readonly service: Pick<MatrixApplicationService, "ingestTransaction" | "queryUser" | "queryAlias">;
}

interface MatrixErrorBody { readonly errcode: string; readonly error: string }

function matrixError(res: Response, status: number, errcode: string, message: string): void {
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ errcode, error: message } satisfies MatrixErrorBody);
}

function authorizationValues(request: Request): string | readonly string[] | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "authorization") values.push(request.rawHeaders[index + 1] ?? "");
  }
  if (values.length > 1) return values;
  return values[0] ?? request.headers.authorization;
}

function authenticate(verifier: MatrixHsTokenVerifier): RequestHandler {
  return (request, response, next) => {
    const decision = verifyMatrixInboundAuthorization({
      authorization: authorizationValues(request),
      url: request.originalUrl,
    }, verifier);
    if (!decision.authorized) {
      if (decision.code === "missing") {
        matrixError(response, 401, "M_MISSING_TOKEN", "Application Service token is required");
      } else {
        matrixError(response, 403, "M_FORBIDDEN", "Application Service token was rejected");
      }
      return;
    }
    next();
  };
}

async function readBody(request: Request, maximum: number): Promise<Uint8Array> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new MatrixServiceError(400, "M_BAD_JSON", "Expected application/json");
  }
  const declared = request.headers["content-length"];
  if (typeof declared === "string" && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    throw new MatrixServiceError(413, "M_BAD_JSON", "Matrix request body exceeds bounds");
  }
  if (request.readableEnded) throw new MatrixServiceError(400, "M_BAD_JSON", "Matrix body parser was mounted too late");
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maximum) {
        cleanup();
        request.resume();
        reject(new MatrixServiceError(413, "M_BAD_JSON", "Matrix request body exceeds bounds"));
        return;
      }
      chunks.push(bytes);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, total)); };
    const aborted = () => fail(new MatrixServiceError(400, "M_BAD_JSON", "Matrix request body was interrupted"));
    const cleanup = () => {
      request.off("data", data);
      request.off("end", end);
      request.off("error", fail);
      request.off("aborted", aborted);
    };
    request.on("data", data);
    request.on("end", end);
    request.on("error", fail);
    request.on("aborted", aborted);
  });
}

function asyncRoute(operation: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => { void operation(request, response).catch(next); };
}

function methodNotAllowed(allow: string): RequestHandler {
  return (_request, response) => {
    response.setHeader("Allow", allow);
    matrixError(response, 405, "M_UNRECOGNIZED", "Unrecognized request method");
  };
}

const TRANSACTION_PATH = "/_matrix/app/v1/transactions/:txnId";
const USER_PATH = "/_matrix/app/v1/users/:userId";
const ALIAS_PATH = "/_matrix/app/v1/rooms/:roomAlias";

/** Mount this router before browser authentication and every generic body parser. */
export function createMatrixApplicationServiceRouter(options: MatrixRouterOptions): Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  router.use("/_matrix/app/v1", authenticate(options.verifier));

  router.put(TRANSACTION_PATH, asyncRoute(async (request, response) => {
    const body = await readBody(request, MAX_MATRIX_TRANSACTION_BYTES);
    await options.service.ingestTransaction(request.params.txnId!, body);
    response.status(200).json({});
  }));
  router.all(TRANSACTION_PATH, methodNotAllowed("PUT"));

  router.get(USER_PATH, asyncRoute(async (request, response) => {
    await options.service.queryUser(request.params.userId!);
    response.status(200).json({});
  }));
  router.all(USER_PATH, methodNotAllowed("GET"));

  router.get(ALIAS_PATH, asyncRoute(async (request, response) => {
    await options.service.queryAlias(request.params.roomAlias!);
    response.status(200).json({});
  }));
  router.all(ALIAS_PATH, methodNotAllowed("GET"));

  router.use("/_matrix/app/v1", (_request, response) => {
    matrixError(response, 404, "M_UNRECOGNIZED", "Unrecognized Application Service route");
  });
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) { next(error); return; }
    if (error instanceof MatrixServiceError) {
      matrixError(response, error.status, error.errcode, error.message);
      return;
    }
    matrixError(response, 503, "M_UNAVAILABLE", "Matrix Application Service is unavailable");
  });
  return router;
}

/** Disabled configuration has no token/client and still never falls through to the SPA. */
export function createUnavailableMatrixApplicationServiceRouter(): Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  const unavailable: RequestHandler = (_request, response) => {
    matrixError(response, 503, "M_UNAVAILABLE", "Matrix Application Service is disabled or unavailable");
  };
  router.put(TRANSACTION_PATH, unavailable);
  router.all(TRANSACTION_PATH, methodNotAllowed("PUT"));
  router.get(USER_PATH, unavailable);
  router.all(USER_PATH, methodNotAllowed("GET"));
  router.get(ALIAS_PATH, unavailable);
  router.all(ALIAS_PATH, methodNotAllowed("GET"));
  router.use("/_matrix/app/v1", (_request, response) => {
    matrixError(response, 404, "M_UNRECOGNIZED", "Unrecognized Application Service route");
  });
  return router;
}
