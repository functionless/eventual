import {
  CompleteActivityRequest,
  encodeExecutionId,
  EventualServiceClient,
  Execution,
  ExecutionEventsRequest,
  ExecutionEventsResponse,
  ExecutionHandle,
  ExecutionHistoryResponse,
  FailActivityRequest,
  GetExecutionsRequest,
  GetExecutionsResponse,
  GetWorkflowResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  HistoryStateEvent,
  PublishEventsRequest,
  SendSignalRequest,
  StartExecutionRequest,
  Workflow,
  WorkflowEvent,
  WorkflowInput,
} from "@eventual/core";
import "./fetch-polyfill.js";

export interface HttpServiceClientProps {
  serviceUrl: string;
  beforeRequest?: BeforeRequest;
}

export interface BeforeRequest {
  (request: Request): Promise<Request>;
}

export class HttpServiceClient implements EventualServiceClient {
  constructor(private props: HttpServiceClientProps) {}

  public async getWorkflows(): Promise<GetWorkflowResponse> {
    const workflowNames = await this.request<void, string[]>(
      "GET",
      `workflows`
    );

    return { workflows: workflowNames.map((n) => ({ name: n })) };
  }

  public async startExecution<W extends Workflow<any, any>>(
    request: StartExecutionRequest<W>
  ): Promise<ExecutionHandle<W>> {
    const workflow =
      typeof request.workflow === "string"
        ? request.workflow
        : request.workflow.workflowName;

    // TODO support timeout and execution name via api

    const { executionId } = await this.request<
      WorkflowInput<W>,
      { executionId: string }
    >("POST", `workflows/${workflow}/executions`, request.input);

    return new ExecutionHandle(executionId, this);
  }

  public async getExecutions(
    request: GetExecutionsRequest
  ): Promise<GetExecutionsResponse> {
    // TODO support status filtering
    // TODO Switch the API to focus on executions, accept workflow, statuses, etc as params
    // TODO don't return an array from the API
    // TODO support pagination
    const response = await this.request<void, Execution[]>(
      "GET",
      request.workflowName
        ? `workflows/${request.workflowName}/executions`
        : `workflows/executions`
    );

    return {
      executions: response,
    };
  }

  public getExecution(
    _executionId: string
  ): Promise<Execution<any> | undefined> {
    // TODO implement api
    throw new Error("Method not implemented.");
  }

  public async getExecutionEvents(
    request: ExecutionEventsRequest
  ): Promise<ExecutionEventsResponse> {
    // TODO: support pagination
    const resp = await this.request<void, WorkflowEvent[]>(
      "GET",
      `executions/${encodeExecutionId(request.executionId)}}/history`
    );

    return { events: resp };
  }

  public async getExecutionHistory(
    executionId: string
  ): Promise<ExecutionHistoryResponse> {
    // TODO: support pagination
    const resp = await this.request<void, HistoryStateEvent[]>(
      "GET",
      `executions/${encodeExecutionId(executionId)}}/workflow-history`
    );

    return { events: resp };
  }

  public sendSignal(_request: SendSignalRequest<any>): Promise<void> {
    // TODO: implement
    throw new Error("Method not implemented.");
  }

  public publishEvents(_request: PublishEventsRequest): Promise<void> {
    // TODO implement
    throw new Error("Method not implemented.");
  }

  public sendActivitySuccess(
    _request: CompleteActivityRequest<any>
  ): Promise<void> {
    // TODO implement
    throw new Error("Method not implemented.");
  }

  public sendActivityFailure(_request: FailActivityRequest): Promise<void> {
    // TODO implement
    throw new Error("Method not implemented.");
  }

  public sendActivityHeartbeat(
    _request: HeartbeatRequest
  ): Promise<HeartbeatResponse> {
    // TODO implement
    throw new Error("Method not implemented.");
  }

  private async request<Body = any, Resp = any>(
    method: "POST" | "GET",
    suffix: string,
    body?: Body
  ) {
    const initRequest = new Request(new URL(suffix, this.props.serviceUrl), {
      method,
      body: Buffer.from(JSON.stringify(body)),
      headers: {
        "Content-Type": "application/json",
      },
    });

    const request = this.props.beforeRequest
      ? await this.props.beforeRequest(initRequest)
      : initRequest;

    const resp = await fetch(request);

    return resp.json() as Resp;
  }
}
