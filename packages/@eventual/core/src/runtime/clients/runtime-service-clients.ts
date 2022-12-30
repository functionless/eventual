import {
  EventualServiceClient,
  ExecutionEventsRequest,
  ExecutionEventsResponse,
  GetExecutionsRequest,
  GetExecutionsResponse,
  PublishEventsRequest,
} from "../../service-client.js";
import { Execution, ExecutionHandle } from "../../execution.js";
import { Workflow } from "../../workflow.js";
import { EventClient } from "./event-client.js";
import { ExecutionHistoryClient } from "./execution-history-client.js";
import {
  StartWorkflowRequest,
  SendSignalRequest,
  CompleteActivityRequest,
  FailActivityRequest,
  HeartbeatRequest,
  HeartbeatResponse,
  WorkflowClient,
} from "./workflow-client.js";

export interface RuntimeServiceClientProps {
  workflowClient: WorkflowClient;
  executionHistoryClient: ExecutionHistoryClient;
  eventClient: EventClient;
}

/**
 * An implementation of the {@link EventualServiceClient} using the eventual runtime clients.
 *
 * Intended to be used when there is direct access to the eventual service internals.
 */
export class RuntimeServiceClient implements EventualServiceClient {
  constructor(private props: RuntimeServiceClientProps) {}

  public async startExecution<W extends Workflow = Workflow>(
    request: StartWorkflowRequest<W>
  ): Promise<ExecutionHandle<W>> {
    const executionId = await this.props.workflowClient.startWorkflow<W>(
      request
    );
    return new ExecutionHandle(executionId, this);
  }

  public async getExecutions(
    request: GetExecutionsRequest
  ): Promise<GetExecutionsResponse> {
    return this.props.workflowClient.getExecutions(request);
  }

  public getExecution(
    executionId: string
  ): Promise<Execution<any> | undefined> {
    return this.props.workflowClient.getExecution(executionId);
  }

  public getExecutionEvents(
    request: ExecutionEventsRequest
  ): Promise<ExecutionEventsResponse> {
    return this.props.executionHistoryClient.getEvents(request);
  }

  public async sendSignal(request: SendSignalRequest): Promise<void> {
    return this.props.workflowClient.sendSignal(request);
  }

  public publishEvents(request: PublishEventsRequest): Promise<void> {
    return this.props.eventClient.publish(...request.events);
  }

  public sendActivitySuccess(
    request: CompleteActivityRequest<any>
  ): Promise<void> {
    return this.props.workflowClient.completeActivity(request);
  }

  public sendActivityFailure(request: FailActivityRequest): Promise<void> {
    return this.props.workflowClient.failActivity(request);
  }

  public sendActivityHeartbeat(
    request: HeartbeatRequest
  ): Promise<HeartbeatResponse> {
    return this.props.workflowClient.heartbeatActivity(request);
  }
}
