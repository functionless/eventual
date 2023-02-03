import {
  ActivityMetrics,
  MetricsCommon,
  OrchestratorMetrics,
} from "@eventual/runtime-core";
import { Dashboard, LogQueryWidget } from "aws-cdk-lib/aws-cloudwatch";
import { Construct } from "constructs";
import { Service } from "./service";

export interface DebugDashboardProps {
  service: Service;
}

/**
 * Detailed dashboard for debug purposes.
 */
export class DebugDashboard extends Construct {
  public readonly dashboard: Dashboard;

  constructor(scope: Construct, id: string, { service }: DebugDashboardProps) {
    super(scope, id);

    const logSummaryBucketDuration = "10m";

    const allLogGroups = [
      // execution log group
      service.logging.logGroup.logGroupName,
      // workflow orchestrator
      service.workflows.orchestrator.logGroup.logGroupName,
      // activities worker
      service.activities.worker.logGroup.logGroupName,
      // user APIS - default and bundled
      ...service.api.handlers.map((api) => api.logGroup.logGroupName),
      // internal APIs
      ...Object.values(service.api.internalRoutes).map(
        (api) => api.logGroup.logGroupName
      ),
      // event handlers - default and bundled
      ...service.events.handlers.map((f) => f.logGroup.logGroupName),
      // scheduler/timer handler and forwarder
      service.scheduler.handler.logGroup.logGroupName,
      service.scheduler.forwarder.logGroup.logGroupName,
    ];

    this.dashboard = new Dashboard(this, "Dashboard", {
      dashboardName: `Service-${service.serviceName.replace(
        /[^A-Za-z0-9_-]/g,
        ""
      )}-debug`,
      widgets: [
        [
          new LogQueryWidget({
            title: "Workflow Information",
            logGroupNames: allLogGroups,
            queryLines: [
              `filter NOT isempty(${MetricsCommon.WorkflowName})`,
              `sort @timestamp desc`,
              `stats count(${OrchestratorMetrics.ExecutionStarted}) as started, count(${OrchestratorMetrics.ExecutionCompleted}) as completed, ` +
                ` avg(${OrchestratorMetrics.ExecutionTotalDuration}) as avg_execution_duration, max(${OrchestratorMetrics.ExecutionTotalDuration}) as max_execution_duration,` +
                ` avg(${OrchestratorMetrics.ExecutionResultBytes}) / 1024 as avg_result_kb, max(${OrchestratorMetrics.ExecutionResultBytes}) / 1024 as max_result_kb` +
                ` by ${MetricsCommon.WorkflowName}`,
            ],
            width: 24,
            height: 6,
          }),
        ],
        [
          new LogQueryWidget({
            title: "All Lambda Errors",
            logGroupNames: allLogGroups,
            queryLines: [
              `fields @timestamp, @log, @message`,
              `filter @message like /ERROR/`,
              `sort @timestamp desc`,
            ],
            width: 24,
            height: 6,
          }),
        ],
        [
          new LogQueryWidget({
            title: "Orchestrator Summary",
            logGroupNames: [
              service.workflows.orchestrator.logGroup.logGroupName,
            ],
            queryLines: [
              `filter @type="REPORT" OR ${OrchestratorMetrics.LoadHistoryDuration} > 0`,
              `sort @timestamp desc`,
              `stats avg(@duration) as duration, avg(@initDuration) as coldDuration, avg(@maxMemoryUsed) / 1024 as memKB, avg(${OrchestratorMetrics.LoadHistoryDuration}) as historyLoad, avg(${OrchestratorMetrics.SaveHistoryDuration}) as historySave by bin(${logSummaryBucketDuration})`,
            ],
            width: 12,
            height: 6,
          }),
          new LogQueryWidget({
            title: "Activity Worker Summary",
            logGroupNames: [service.activities.worker.logGroup.logGroupName],
            queryLines: [
              `filter @type="REPORT" OR ${ActivityMetrics.OperationDuration} > 0`,
              `sort @timestamp desc`,
              `stats avg(@duration) as duration, avg(@initDuration) as coldDuration, avg(@maxMemoryUsed) / 1024 as memKB, avg(${ActivityMetrics.OperationDuration}) as operationDuration by bin(${logSummaryBucketDuration})`,
            ],
            width: 12,
            height: 6,
          }),
          new LogQueryWidget({
            title: "API Handlers Summary",
            logGroupNames: service.api.handlers.map(
              (api) => api.logGroup.logGroupName
            ),
            queryLines: [
              `filter @type="REPORT"`,
              `sort @timestamp desc`,
              // group by log name as well
              `stats avg(@duration) as duration, avg(@initDuration) as coldDuration, avg(@maxMemoryUsed) / 1024 as memKB by bin(${logSummaryBucketDuration}), @log`,
            ],
            width: 12,
            height: 6,
          }),
          new LogQueryWidget({
            title: "Event Handler Summary",
            logGroupNames: service.events.handlers.map(
              (f) => f.logGroup.logGroupName
            ),
            queryLines: [
              `filter @type="REPORT"`,
              `sort @timestamp desc`,
              // group by log name as well
              `stats avg(@duration) as duration, avg(@initDuration) as coldDuration, avg(@maxMemoryUsed) / 1024 as memKB by bin(${logSummaryBucketDuration})`,
            ],
            width: 12,
            height: 6,
          }),
        ],
      ],
    });
  }
}