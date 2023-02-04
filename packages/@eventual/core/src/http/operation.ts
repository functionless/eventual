import type { FunctionRuntimeProps } from "../function-props.js";
import type { HttpError } from "./error.js";
import type { HttpHeaders } from "./headers.js";
import type { Params } from "./params.js";
import type { HttpRequest } from "./request.js";
import type { HttpResponse, HttpResponseOrError } from "./response.js";

export interface HttpOperation<
  Path extends string,
  Request extends HttpRequest.Schema | undefined = undefined,
  Response extends HttpResponse.Schema | undefined = undefined,
  Errors extends HttpError.Schema | undefined = undefined,
  Headers extends HttpHeaders.Schema | undefined = undefined,
  Params extends Params.Schema | undefined = undefined
> {
  kind: "HttpOperation";
  path: Path;
  request: Request;
  response: Response;
  errors: Error;
  headers: Headers;
  params: Params;
  (request: HttpRequest<Request, Headers, Params>): Promise<
    HttpResponseOrError<Response, Errors>
  >;
}

export namespace HttpOperation {
  export interface Props<
    Path extends string = string,
    Input extends HttpRequest.Schema | undefined =
      | HttpRequest.Schema
      | undefined,
    Output extends HttpResponse.Schema | undefined =
      | HttpResponse.Schema
      | undefined,
    Errors extends HttpError.Schema | undefined = HttpError.Schema | undefined,
    Headers extends HttpHeaders.Schema | undefined =
      | HttpHeaders.Schema
      | undefined,
    Params extends Params.Schema<Params.Parse<Path>> = Params.Schema<
      Params.Parse<Path>
    >
  > extends FunctionRuntimeProps {
    input?: Input;
    output?: Output | Output[];
    errors?: Errors | Errors[];
    headers?: Headers;
    params?: Params;
  }

  export interface Handler<
    Path extends string = string,
    Request extends HttpRequest.Schema | undefined = undefined,
    Response extends HttpResponse.Schema | undefined = undefined,
    Errors extends HttpError.Schema | undefined = undefined,
    Headers extends HttpHeaders.Schema | undefined = undefined,
    Params extends Params.Schema<Params.Parse<Path>> = Params.Schema<
      Params.Parse<Path>
    >
  > {
    (request: HttpRequest<Request, Headers, Params>):
      | HttpResponseOrError<Response, Errors>
      | Promise<HttpResponseOrError<Response, Errors>>;
  }

  export interface Router {
    <Path extends string>(path: Path, handler: Handler): HttpOperation<Path>;
    <
      Path extends string,
      Output extends HttpRequest.Schema | undefined = undefined,
      Response extends HttpResponse.Schema | undefined = undefined,
      Errors extends HttpError.Schema | undefined = undefined,
      Headers extends HttpHeaders.Schema | undefined = undefined,
      Params extends Params.Schema<Params.Parse<Path>> = Params.Schema<
        Params.Parse<Path>
      >
    >(
      path: Path,
      props: Props<Path, Output, Response, Errors, Headers, Params>,
      handler: Handler<Path, Output, Response, Errors, Headers, Params>
    ): HttpOperation<Path, Output, Response, Errors, Headers, Params>;
  }

  export interface Get<
    Path extends string,
    Response extends HttpResponse.Schema | undefined,
    Errors extends HttpError.Schema | undefined,
    Headers extends HttpHeaders.Schema | undefined,
    Params extends Params.Schema | undefined
  > extends HttpOperation<Path, undefined, Response, Errors, Headers, Params> {}

  export namespace Get {
    export interface Props<
      Output extends HttpResponse.Schema | undefined,
      Errors extends HttpError.Schema | undefined = undefined,
      Headers extends HttpHeaders.Schema | undefined = undefined,
      Params extends Params.Schema | undefined = undefined
    > extends FunctionRuntimeProps {
      headers?: Headers;
      params?: Params;
      output?: Output | Output[];
      errors?: Errors | Errors[];
    }

    export interface Router {
      <Path extends string>(path: Path, handler: Handler): HttpOperation<Path>;
      <
        Path extends string,
        Response extends HttpResponse.Schema | undefined = undefined,
        Errors extends HttpError.Schema | undefined = undefined,
        Headers extends HttpHeaders.Schema | undefined = undefined,
        Params extends Params.Schema<Params.Parse<Path>> = Params.Schema<
          Params.Parse<Path>
        >
      >(
        path: Path,
        props: Props<Response, Errors, Headers, Params>,
        handler: Handler<Path, undefined, Response, Errors, Headers, Params>
      ): HttpOperation.Get<Path, Response, Errors, Headers, Params>;
    }
  }
}
