import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
} from "@aws-cdk/aws-apigatewayv2-alpha";
import { HttpLambdaIntegration } from "@aws-cdk/aws-apigatewayv2-integrations-alpha";
import { ENV_NAMES, sanitizeFunctionName } from "@eventual/aws-runtime";
import { commandRpcPath, isDefaultNamespaceCommand } from "@eventual/core";
import type { CommandFunction } from "@eventual/core-runtime";
import { CommandSpec } from "@eventual/core/internal";
import { Arn, ArnFormat, aws_iam, Duration, Lazy, Stack } from "aws-cdk-lib";
import {
  Effect,
  IGrantable,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import type { Function, FunctionProps } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import openapi from "openapi3-ts";
import type { ActivityService } from "./activity-service";
import type { EventService } from "./event-service";
import { grant } from "./grant";
import {
  EventualResource,
  ServiceConstructProps,
  ServiceLocal,
} from "./service";
import { ServiceFunction } from "./service-function.js";
import type { ServiceEntityProps } from "./utils";
import type { WorkflowService } from "./workflow-service";

export type Commands<Service> = {
  default: EventualResource;
} & ServiceEntityProps<Service, "Command", EventualResource>;

export type CommandProps<Service> = {
  default?: CommandHandlerProps;
} & Partial<ServiceEntityProps<Service, "Command", CommandHandlerProps>>;

export interface CorsOptions {
  /**
   * Specifies whether credentials are included in the CORS request.
   * @default false
   */
  readonly allowCredentials?: boolean;
  /**
   * Represents a collection of allowed headers.
   * @default - No Headers are allowed.
   */
  readonly allowHeaders?: string[];
  /**
   * Represents a collection of allowed HTTP methods.
   * OPTIONS will be added automatically.
   *
   * @default - OPTIONS
   */
  readonly allowMethods?: CorsHttpMethod[];
  /**
   * Represents a collection of allowed origins.
   * @default - No Origins are allowed.
   */
  readonly allowOrigins?: string[];
  /**
   * Represents a collection of exposed headers.
   * @default - No Expose Headers are allowed.
   */
  readonly exposeHeaders?: string[];
  /**
   * The duration that the browser should cache preflight request results.
   * @default Duration.seconds(0)
   */
  readonly maxAge?: Duration;
}

export interface CommandsProps<Service = any> extends ServiceConstructProps {
  activityService: ActivityService<Service>;
  overrides?: CommandProps<Service>;
  eventService: EventService;
  workflowService: WorkflowService;
  cors?: CorsOptions;
  local: ServiceLocal | undefined;
}

/**
 * Properties that can be overridden for an individual API handler Function.
 */
export interface CommandHandlerProps
  extends Partial<Omit<FunctionProps, "code" | "runtime" | "functionName">> {
  /**
   * A callback that will be invoked on the Function after all the Service has been fully instantiated
   */
  init?(func: Function): void;
}

export class CommandService<Service = any> {
  /**
   * API Gateway for providing service api
   */
  public readonly gateway: HttpApi;
  /**
   * The OpenAPI specification for this Service.
   */
  readonly specification: openapi.OpenAPIObject;
  /**
   * A map of Command Name to the Lambda Function handling its logic.
   */
  readonly serviceCommands: Commands<Service>;
  readonly systemCommandsHandler: Function;
  private integrationRole: Role;

  /**
   * Individual API Handler Lambda Functions handling only a single API route. These handlers
   * are individually bundled and tree-shaken for optimal performance and may contain their own custom
   * memory and timeout configuration.
   */
  public get handlers(): Function[] {
    return Object.values(this.serviceCommands).map((c) => c.handler);
  }

  constructor(private props: CommandsProps<Service>) {
    const self = this;

    // Construct for grouping commands in the CDK tree
    // Service => System => EventualService => Commands => [all system commands]
    const commandsSystemScope = new Construct(
      props.eventualServiceScope,
      "Commands"
    );
    // Service => Commands
    const commandsScope = new Construct(props.serviceScope, "Commands");

    const serviceCommands = synthesizeAPI(
      commandsScope,
      this.props.build.commands.map(
        (manifest) =>
          ({
            manifest,
            overrides:
              props.overrides?.[manifest.spec.name as keyof Commands<Service>],
            init: (handler) => {
              // The handler is given an instance of the service client.
              // Allow it to access any of the methods on the service client by default.
              self.configureApiHandler(handler);
            },
          } satisfies CommandMapping)
      )
    );

    this.systemCommandsHandler = new ServiceFunction(
      commandsSystemScope,
      "SystemCommandHandler",
      {
        build: this.props.build,
        bundledFunction:
          this.props.build.system.eventualService.systemCommandHandler,
        functionNameSuffix: "system-command",
        serviceName: this.props.serviceName,
      }
    );

    this.integrationRole = new Role(commandsSystemScope, "IntegrationRole", {
      assumedBy: new ServicePrincipal("apigateway.amazonaws.com"),
    });

    this.integrationRole.addToPrincipalPolicy(
      new PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          Stack.of(this.props.systemScope).formatArn({
            service: "lambda",
            resourceName: `${this.props.serviceName}-`,
            resource: "function",
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      })
    );

    this.onFinalize(() => {
      // for update activity
      this.props.activityService.configureWriteActivities(
        this.systemCommandsHandler
      );
      this.props.activityService.configureCompleteActivity(
        this.systemCommandsHandler
      );
      // publish events
      this.props.eventService.configurePublish(this.systemCommandsHandler);
      // get and list executions
      this.props.workflowService.configureReadExecutions(
        this.systemCommandsHandler
      );
      // execution history
      this.props.workflowService.configureReadExecutionHistory(
        this.systemCommandsHandler
      );
      // send signal
      this.props.workflowService.configureSendSignal(
        this.systemCommandsHandler
      );
      // workflow history
      this.props.workflowService.configureReadHistoryState(
        this.systemCommandsHandler
      );
      // start execution
      this.props.workflowService.configureStartExecution(
        this.systemCommandsHandler
      );
    });

    // const handlerToIntegration: Set<Function> = new Set();

    // TODO system
    this.specification = createSpecification([
      ...Object.values(serviceCommands).map(({ handler, mapping }) => {
        return createAPIPaths(handler, mapping.manifest.spec, false);
      }),
      ...this.props.build.system.eventualService.commands.map((command) =>
        createAPIPaths(this.systemCommandsHandler, command, true)
      ),
    ]);
    this.serviceCommands = Object.fromEntries(
      Object.entries(serviceCommands).map(([c, { handler }]) => [
        c,
        new EventualResource(handler, this.props.local),
      ])
    ) as Commands<Service>;

    // Service => Gateway
    this.gateway = new HttpApi(props.serviceScope, "Gateway", {
      apiName: `eventual-api-${props.serviceName}`,
      defaultIntegration: new HttpLambdaIntegration(
        "default",
        this.serviceCommands.default.handler
      ),
      corsPreflight: props.cors
        ? {
            ...props.cors,
            allowMethods: Array.from(
              new Set([
                ...(props.cors.allowMethods ?? []),
                CorsHttpMethod.OPTIONS,
              ])
            ),
          }
        : undefined,
        
    });

    this.finalize();

    function synthesizeAPI(scope: Construct, commands: CommandMapping[]) {
      return Object.fromEntries(
        commands.map((mapping) => {
          const { manifest, overrides, init } = mapping;
          const command = manifest.spec;

          if (init) {
            self.onFinalize(() => init?.(handler));
          }
          if (overrides?.init) {
            // issue all override finalizers after all the routes and api gateway is created
            self.onFinalize(() => overrides!.init!(handler!));
          }

          let sanitizedName = sanitizeFunctionName(command.name);
          if (sanitizedName !== command.name) {
            // in this case, we're working with the low-level http api
            // we do a best effort to transform an HTTP path into a name that Lambda supports
            sanitizedName = `${sanitizedName}-${
              command.method?.toLocaleLowerCase() ?? "all"
            }`;
          }
          const namespacedName = isDefaultNamespaceCommand(command)
            ? sanitizedName
            : `${sanitizedName}-${command.namespace}`;

          const handler = new ServiceFunction(scope, namespacedName, {
            build: self.props.build,
            bundledFunction: manifest,
            functionNameSuffix: `${namespacedName}-command`,
            serviceName: props.serviceName,
            overrides,
            defaults: {
              environment: props.environment,
            },
          });

          return [
            command.name as keyof Commands<Service>,
            {
              handler,
              mapping,
            },
          ] as const;
        })
      );
    }

    function createAPIPaths(
      handler: Function,
      command: CommandSpec,
      iamAuth?: boolean
    ): openapi.PathsObject {
      // TODO: use the Open API spec to configure instead of consuming CloudFormation resources
      // this seems not so simple and not well documented, so for now we take the cheap way out
      // we will keep the api spec and improve it over time
      // self.onFinalize(() => {
      //   if (!handlerToIntegration.has(handler)) {
      //     handlerToIntegration.set(
      //       handler,
      //       new HttpLambdaIntegration(command.name, handler)
      //     );
      //   }
      //   const integration = handlerToIntegration.get(handler)!;
      //   if (!command.passThrough) {
      //     // internal and low-level HTTP APIs should be passed through
      //     self.gateway.addRoutes({
      //       path: `/${commandRpcPath(command)}`,
      //       methods: [HttpMethod.POST],
      //       integration,
      //       authorizer: overrides?.authorizer,
      //     });
      //   }
      //   if (command.path) {
      //     self.gateway.addRoutes({
      //       // itty router supports paths in the form /*, but api gateway expects them in the form /{proxy+}
      //       path: ittyRouteToApigatewayRoute(command.path),
      //       methods: [
      //         (command.method as HttpMethod | undefined) ?? HttpMethod.GET,
      //       ],
      //       integration,
      //       authorizer: overrides?.authorizer,
      //     });
      //   }
      // });

      // if (!handlerToIntegration.has(handler)) {
      //   self.onFinalize(() => {
      //     handler.addPermission("GatewayPermission", {
      //       principal: new ServicePrincipal("apigateway.amazonaws.com"),
      //       sourceArn: Stack.of(handler).formatArn({
      //         service: "execute-api",
      //         resource: self.gateway.apiId,
      //         resourceName: `*/*`,
      //       }),
      //     });
      //   });
      //   handlerToIntegration.add(handler);
      // }

      return {
        [`/${commandRpcPath(command)}`]: {
          post: {
            ...(iamAuth
              ? {
                  [XAmazonApiGatewayAuth]: {
                    type: "AWS_IAM",
                  } satisfies XAmazonApiGatewayAuth,
                }
              : {}),
            [XAmazonApiGatewayIntegration]: {
              connectionType: "INTERNET",
              httpMethod: HttpMethod.POST,
              payloadFormatVersion: "2.0",
              type: "AWS_PROXY",
              credentials: self.integrationRole.roleArn,
              uri: Lazy.string({
                produce: () => handler.functionArn,
              }),
            } satisfies XAmazonApiGatewayIntegration,
            requestBody: {
              content: {
                "application/json": {
                  schema: command.input,
                },
              },
            },
            responses: {
              default: {
                description: `Default response for ${command.method} ${command.path}`,
              } satisfies openapi.ResponseObject,
            },
          },
        } satisfies openapi.PathItemObject,
        ...(command.path
          ? {
              [ittyRouteToApigatewayRoute(command.path)]: {
                [command.method?.toLocaleLowerCase() ?? "get"]: {
                  [XAmazonApiGatewayIntegration]: {
                    connectionType: "INTERNET",
                    httpMethod: HttpMethod.POST,
                    payloadFormatVersion: "2.0",
                    type: "AWS_PROXY",
                    credentials: self.integrationRole.roleArn,
                    uri: Lazy.string({
                      produce: () => handler.functionArn,
                    }),
                  } satisfies XAmazonApiGatewayIntegration,
                  parameters: Object.entries(command.params ?? {}).flatMap(
                    ([name, spec]) =>
                      spec === "body" ||
                      (typeof spec === "object" && spec.in === "body")
                        ? []
                        : [
                            {
                              in:
                                typeof spec === "string"
                                  ? spec
                                  : (spec?.in as "query" | "header") ?? "query",
                              name,
                            } satisfies openapi.ParameterObject,
                          ]
                  ),
                },
              } satisfies openapi.PathItemObject,
            }
          : {}),
      };
    }

    function createSpecification(commandPaths: openapi.PathsObject[]) {
      const paths = Object.values(commandPaths).reduce<openapi.PathsObject>(
        (allPaths, paths) => mergeAPIPaths(allPaths, paths),
        {}
      );

      return {
        openapi: "3.0.1",
        info: {
          title: self.props.build.serviceName,
          // TODO: use the package.json?
          version: "1",
        },

        paths: {
          "/$default": {
            isDefaultRoute: true,
            [XAmazonApiGatewayIntegration]: {
              connectionType: "INTERNET",
              httpMethod: HttpMethod.POST, // TODO: why POST? Exported API has this but it's not clear
              payloadFormatVersion: "2.0",
              type: "AWS_PROXY",
              credentials: self.integrationRole.roleArn,
              uri: Lazy.string({
                produce: () => self.serviceCommands.default.handler.functionArn,
              }),
            } satisfies XAmazonApiGatewayIntegration,
          },
          ...paths,
        },
      } satisfies openapi.OpenAPIObject;

      function mergeAPIPaths(
        a: openapi.PathsObject,
        b: openapi.PathsObject
      ): openapi.PathsObject {
        for (const [path, route] of Object.entries(b)) {
          if (path in a) {
            // spread collisions into one
            // assumes no duplicate METHODs
            a[path] = {
              ...a[path],
              [path]: route,
            };
          } else {
            a[path] = route;
          }
        }
        return a;
      }
    }
  }

  private finalizers: (() => any)[] = [];
  private onFinalize(finalizer: () => any) {
    this.finalizers.push(finalizer);
  }

  private finalize() {
    this.finalizers.forEach((finalizer) => finalizer());
    this.finalizers = []; // clear the closures from memory
  }

  public configureInvokeHttpServiceApi(...functions: Function[]) {
    for (const func of functions) {
      this.grantInvokeHttpServiceApi(func);
      this.addEnvs(func, ENV_NAMES.SERVICE_URL);
    }
  }

  @grant()
  public grantInvokeHttpServiceApi(grantable: IGrantable) {
    grantable.grantPrincipal.addToPrincipalPolicy(
      this.executeApiPolicyStatement()
    );
  }

  private executeApiPolicyStatement() {
    return new PolicyStatement({
      actions: ["execute-api:*"],
      effect: Effect.ALLOW,
      resources: [
        Arn.format(
          {
            service: "execute-api",
            resource: Lazy.string({
              produce: () => this.gateway.apiId,
            }),
            resourceName: "*/*/*",
          },
          Stack.of(this.gateway)
        ),
      ],
    });
  }

  private configureApiHandler(handler: Function) {
    // The handlers are given an instance of the service client.
    // Allow them to access any of the methods on the service client by default.
    this.props.service.configureForServiceClient(handler);
    this.configureInvokeHttpServiceApi(handler);
  }

  private readonly ENV_MAPPINGS = {
    [ENV_NAMES.SERVICE_URL]: () =>
      Lazy.string({
        produce: () => this.gateway.apiEndpoint,
      }),
  } as const;

  private addEnvs(func: Function, ...envs: (keyof typeof this.ENV_MAPPINGS)[]) {
    envs.forEach((env) => func.addEnvironment(env, this.ENV_MAPPINGS[env]()));
  }
}

function ittyRouteToApigatewayRoute(route: string) {
  return route === "*"
    ? "/{proxy+}"
    : route.replace(/\*/g, "{proxy+}").replaceAll(/\:([^\/]*)/g, "{$1}");
}

interface CommandMapping {
  manifest: CommandFunction;
  overrides?: CommandHandlerProps;
  init?: (grantee: Function) => void;
  role?: aws_iam.IRole;
}

const XAmazonApiGatewayIntegration = "x-amazon-apigateway-integration";

interface XAmazonApiGatewayIntegration {
  payloadFormatVersion: "2.0";
  type: "AWS_PROXY";
  httpMethod: HttpMethod;
  uri: string;
  connectionType: "INTERNET";
  credentials: string;
}

const XAmazonApiGatewayAuth = "x-amazon-apigateway-auth";

interface XAmazonApiGatewayAuth {
  type: "AWS_IAM";
}
