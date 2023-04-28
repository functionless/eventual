import { Readable } from "node:stream";
import { getBucketHook } from "./internal/bucket-hook.js";
import { buckets } from "./internal/global.js";
import {
  BucketNotificationEventType,
  BucketNotificationHandlerOptions,
  BucketNotificationHandlerSpec,
  BucketSpec,
  isSourceLocation,
  SourceLocation,
} from "./internal/service-spec.js";
import { DurationSchedule } from "./schedule.js";

export interface BucketObjectReference {
  key: string;
  eTag: string;
  size: number;
}

export interface ListBucketResult {
  objects: BucketObjectReference[];
  keyCount: number;
  nextToken?: string;
}

export interface ListBucketRequest {
  nextToken?: string;
  startAfter?: string;
  prefix?: string;
  /**
   * @default 1000
   */
  maxKeys?: number;
}

export interface GetBucketObjectOptions {
  etag?: string;
}

export interface GetBucketObjectResponse {
  body: Readable;
  /**
   * Content length in bytes
   */
  contentLength: number;
  etag?: string;
}

export interface PutBucketObjectResponse {
  etag?: string;
}

export interface CopyBucketObjectOptions {
  sourceEtag?: string;
}

export interface CopyBucketObjectResponse {
  etag?: string;
}

export interface BucketNotificationHandler
  extends BucketNotificationHandlerSpec {
  kind: "BucketNotificationHandler";
  handler: BucketNotificationHandlerFunction;
  sourceLocation?: SourceLocation;
}

export interface BucketNotificationHandlerFunction {
  (item: BucketNotificationEvent): Promise<void> | void;
}

export interface BucketNotificationEventBase {
  handlerName: string;
  bucketName: string;
  key: string;
}

export interface BucketNotificationPutEvent
  extends BucketNotificationEventBase {
  event: "put" | "copy";
  etag: string;
  size: number;
}

export interface BucketNotificationDeleteEvent
  extends BucketNotificationEventBase {
  event: "delete";
}

export type BucketNotificationEvent =
  | BucketNotificationPutEvent
  | BucketNotificationDeleteEvent;

export type BucketNotificationHandlerEventInput =
  | BucketNotificationEventType[]
  | BucketNotificationEventType
  | "all";

export interface Bucket extends Omit<BucketSpec, "handlers"> {
  kind: "Bucket";
  handlers: BucketNotificationHandler[];
  get(
    key: string,
    options?: GetBucketObjectOptions
  ): Promise<GetBucketObjectResponse | undefined>;
  put(
    key: string,
    data: string | Buffer | Readable
  ): Promise<PutBucketObjectResponse>;
  delete(key: string): Promise<void>;
  copyTo(
    key: string,
    sourceKey: string,
    sourceBucket?: Bucket,
    options?: CopyBucketObjectOptions
  ): Promise<CopyBucketObjectResponse>;
  presignedUrl(
    /**
     * The key that the url can act on
     */
    key: string,
    /**
     * The operation the user can perform
     */
    operation: "put" | "get" | "delete",
    /**
     * Expiration Duration
     *
     * @default - 1 hour
     */
    expires?: DurationSchedule
  ): Promise<{ url: string; expires: string }>;
  list(request: ListBucketRequest): Promise<ListBucketResult>;
  /**
   * The name of the bucket in the cloud environment.
   *
   * For example, in AWS this is the s3 bucket name.
   *
   * In a local environment, this will just be the bucket name;
   */
  physicalName: string;
  on(
    events: BucketNotificationHandlerEventInput,
    name: string,
    options: Omit<BucketNotificationHandlerOptions, "eventTypes">,
    handler: BucketNotificationHandlerFunction
  ): BucketNotificationHandler;
  on(
    events: BucketNotificationHandlerEventInput,
    name: string,
    handler: BucketNotificationHandlerFunction
  ): BucketNotificationHandler;
}

export function bucket(name: string): Bucket {
  if (buckets().has(name)) {
    throw new Error(`bucket with name '${name}' already exists`);
  }

  const handlers: BucketNotificationHandler[] = [];
  const bucket: Bucket = {
    name,
    handlers,
    kind: "Bucket",
    get(key, options) {
      return getEventualCallHook().registerEventualCall(undefined, () => {
        return getBucketHook().get(name, key, options);
      });
    },
    put(key, data) {
      return getEventualCallHook().registerEventualCall(undefined, () => {
        return getBucketHook().put(name, key, data);
      });
    },
    copyTo(key, destKey, destBucket, options) {
      return getEventualCallHook().registerEventualCall(undefined, () => {
        return getBucketHook().copyTo(name, key, destKey, destBucket, options);
      });
    },
    delete(key) {
      return getEventualCallHook().registerEventualCall(undefined, () => {
        return getBucketHook().delete(name, key);
      });
    },
    list(request) {
      return getEventualCallHook().registerEventualCall(undefined, () => {
        return getBucketHook().list(name, request);
      });
    },
    presignedUrl(key, operation, expires) {
      return getEventualCallHook().registerEventualCall(undefined, () => {
        return getBucketHook().presignedUrl(name, key, operation, expires);
      });
    },
    get physicalName() {
      // should be constant, can be used directly in a workflow.
      return getBucketHook().physicalName(name);
    },
    on: (
      ...args:
        | [
            events: BucketNotificationHandlerEventInput,
            name: string,
            handler: BucketNotificationHandlerFunction
          ]
        | [
            events: BucketNotificationHandlerEventInput,
            name: string,
            options: Omit<BucketNotificationHandlerOptions, "eventTypes">,
            handler: BucketNotificationHandlerFunction
          ]
        | [
            sourceLocation: SourceLocation,
            events: BucketNotificationHandlerEventInput,
            name: string,
            handler: BucketNotificationHandlerFunction
          ]
        | [
            sourceLocation: SourceLocation,
            events: BucketNotificationHandlerEventInput,
            name: string,
            options: Omit<BucketNotificationHandlerOptions, "eventTypes">,
            handler: BucketNotificationHandlerFunction
          ]
    ) => {
      const [sourceLocation, events, streamName, options, handler] =
        args.length === 3
          ? [, args[0], args[1], , args[2]]
          : args.length === 5
          ? args
          : isSourceLocation(args[0]) && typeof args[2] === "string"
          ? [
              args[0],
              args[1] as BucketNotificationHandlerEventInput,
              args[2] as string,
              ,
              args[3],
            ]
          : [
              ,
              args[0] as BucketNotificationHandlerEventInput,
              args[1] as string,
              args[2] as Omit<BucketNotificationHandlerOptions, "eventTypes">,
              args[3],
            ];

      const bucketHandler: BucketNotificationHandler = {
        kind: "BucketNotificationHandler",
        handler,
        name: streamName,
        bucketName: name,
        options: {
          ...options,
          eventTypes:
            events === "all"
              ? undefined
              : Array.isArray(events)
              ? events
              : [events],
        },
        sourceLocation,
      };

      handlers.push(bucketHandler);

      return bucketHandler;
    },
  };

  buckets().set(name, bucket);

  return bucket;
}
