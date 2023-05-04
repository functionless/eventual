import type openapi from "openapi3-ts";
import type { FunctionRuntimeProps } from "../function-props.js";
import type { HttpMethod } from "../http-method.js";
import type { RestParams } from "../http/command.js";
import type { DurationSchedule } from "../schedule.js";
import type {
  SubscriptionFilter,
  SubscriptionRuntimeProps,
} from "../subscription.js";
import type { TaskSpec } from "./task.js";

/**
 * Specification for an Eventual application
 */
export interface ServiceSpec {
  /**
   * List of workflows
   */
  workflows: WorkflowSpec[];
  transactions: TransactionSpec[];
  tasks: TaskSpec[];
  commands: CommandSpec<any, any, any, any>[];
  /**
   * Open API 3 schema definitions for all known Events in this Service.
   */
  events: EventSpec[];
  /**
   * Individually bundled {@link EventFunction}s containing a single `subscription` event handler.
   */
  subscriptions: SubscriptionSpec[];
  buckets: {
    buckets: BucketSpec[];
  };
  entities: {
    entities: EntitySpec[];
  };
  openApi: {
    info: openapi.InfoObject;
  };
}

export interface FunctionSpec {
  memorySize?: number;
  timeout?: DurationSchedule;
}

export interface SubscriptionSpec<Name extends string = string> {
  /**
   * Unique name of this Subscription.
   */
  name: Name;
  /**
   * Subscriptions this Event Handler is subscribed to. Any event flowing
   * through the Service's Event Bus that match these criteria will be
   * sent to this Lambda Function.
   */
  filters: SubscriptionFilter[];
  /**
   * Runtime configuration for this Event Handler.
   */
  props?: SubscriptionRuntimeProps;
  /**
   * Only available during eventual-infer.
   */
  sourceLocation?: SourceLocation;
}

export interface EventSpec {
  /**
   * The Event's globally unique name.
   */
  readonly name: string;
  /**
   * An optional Schema of the Event.
   */
  schema?: openapi.SchemaObject;
}

export interface CommandSpec<
  Name extends string = string,
  Input = undefined,
  Path extends string | undefined = undefined,
  Method extends HttpMethod | undefined = undefined
> extends FunctionRuntimeProps {
  name: Name;
  /**
   * Long description of the API, written to the description field of the generated open API spec.
   */
  description?: string;
  /**
   * Short description of the API, written to the summary field of the generated open API spec.
   */
  summary?: string;
  input?: openapi.SchemaObject;
  output?: openapi.SchemaObject;
  path?: Path;
  method?: Method;
  params?: RestParams<Input, Path, Method>;
  sourceLocation?: SourceLocation;
  passThrough?: boolean;
  /**
   * Used to isolate rpc paths.
   *
   * /rpc[/namespace]/command
   */
  namespace?: string;
  /**
   * Enable or disable schema validation.
   *
   * @default true
   */
  validate?: boolean;
}

export function isSourceLocation(a: any): a is SourceLocation {
  return (
    a &&
    typeof a === "object" &&
    typeof a.fileName === "string" &&
    typeof a.exportName === "string"
  );
}

export interface SourceLocation {
  fileName: string;
  exportName: string;
}

export interface Schemas {
  [schemaName: string]: openapi.SchemaObject;
}

export interface WorkflowSpec {
  name: string;
}

export interface BucketSpec {
  name: string;
  handlers: BucketNotificationHandlerSpec[];
}

export type BucketNotificationEventType = "put" | "copy" | "delete";

export interface BucketNotificationHandlerOptions extends FunctionRuntimeProps {
  /**
   * A list of operations to be send to the stream.
   *
   * @default All Operations
   */
  eventTypes?: BucketNotificationEventType[];
  /**
   * Filter objects in the stream by prefix or suffix.
   */
  filters?: { prefix?: string; suffix?: string }[];
}

export interface BucketNotificationHandlerSpec {
  name: string;
  bucketName: string;
  options?: BucketNotificationHandlerOptions;
  sourceLocation?: SourceLocation;
}

export interface EntitySpec {
  name: string;
  /**
   * An Optional schema for the entity within an entity.
   */
  schema?: openapi.SchemaObject;
  streams: EntityStreamSpec[];
}

export type EntityStreamOperation = "insert" | "modify" | "remove";

export interface EntityStreamOptions extends FunctionRuntimeProps {
  /**
   * A list of operations to be send to the stream.
   *
   * @default All Operations
   */
  operations?: EntityStreamOperation[];
  /**
   * When true, the old value will be sent with the new value.
   */
  includeOld?: boolean;
  /**
   * A subset of namespaces to include in the stream.
   *
   * If neither `namespaces` or `namespacePrefixes` are provided, all namespaces will be sent.
   */
  namespaces?: string[];
  /**
   * One or more namespace prefixes to match.
   *
   * If neither `namespaces` or `namespacePrefixes` are provided, all namespaces will be sent.
   */
  namespacePrefixes?: string[];
}

export interface EntityStreamSpec {
  name: string;
  entityName: string;
  options?: EntityStreamOptions;
  sourceLocation?: SourceLocation;
}

export interface TransactionSpec {
  name: string;
}

export interface EnvironmentManifest {
  serviceName: string;
  serviceSpec: ServiceSpec;
  serviceUrl: string;
}
