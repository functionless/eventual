import { Execution } from "@eventual/core";

export class ExecutionStore {
  private executionStore: Record<string, Execution<any>> = {};

  public put(execution: Execution<any>) {
    this.executionStore[execution.id] = execution;
  }

  public get(executionId: string): Execution<any> | undefined {
    return this.executionStore[executionId];
  }

  public list(): Execution<any>[] {
    return Object.values(this.executionStore).sort(
      (a, b) =>
        new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    );
  }
}
