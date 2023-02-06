import type { z } from "zod";
import type { BodyEnvelope } from "./body.js";
import type { HttpHeaders } from "./headers.js";
import type { HttpStatusCode } from "./status-code.js";

export type HttpResponse<
  Type extends string = string,
  Status extends HttpStatusCode = HttpStatusCode,
  Body extends z.ZodType = z.ZodType,
  Headers extends HttpHeaders.Schema = HttpHeaders.Schema
> = {
  status: Status;
  error?: never;
  statusText?: string;
} & BodyEnvelope<Body> &
  HttpHeaders.Envelope<Headers>;

export function HttpResponse<
  Type extends string,
  Body extends z.ZodType,
  Headers extends HttpHeaders.Schema = HttpHeaders.Schema,
  Status extends HttpStatusCode = 200
>(
  type: Type,
  props: {
    body?: Body;
    status?: Status;
    statusText?: string;
    headers?: Headers;
  }
): HttpResponse.Class<HttpResponse.Schema<Type, Body, Headers, Status>> {
  return class HttpResponse {
    static readonly kind = "HttpResponse";
    static readonly type = type;
    static readonly body = props.body;
    static readonly status = props.status ?? 200;
    static readonly headers = props?.headers;

    readonly type = type;
    readonly status;
    readonly headers;
    constructor(readonly body: any, props?: HttpHeaders.Envelope) {
      this.status = HttpResponse.status;
      this.headers = props?.headers as any;
    }
  } as any;
}

export declare namespace HttpResponse {
  export type Class<Props extends Schema> = Props & {
    new (
      props: {
        body: z.infer<Props["body"]>;
      } & HttpHeaders.Envelope<Props["headers"]>
    ): Of<Props>;
  };

  export interface Schema<
    Type extends string = string,
    Body extends z.ZodType = z.ZodType,
    Headers extends HttpHeaders.Schema = HttpHeaders.Schema,
    Status extends HttpStatusCode = HttpStatusCode
  > {
    kind: "Response";
    type: Type;
    body: Body;
    headers: Headers;
    status: Status;
  }
  export type Of<T extends Schema | undefined> = T extends Schema
    ? HttpResponse<T["type"], T["status"], T["body"], T["headers"]>
    : HttpResponse;
}
