import { Handler } from "aws-lambda";
import { AwsHttpServiceClient } from "@eventual/aws-client";

const serviceClient = new AwsHttpServiceClient({
  serviceUrl: process.env.TEST_SERVICE_URL ?? "",
  region: "us-east-1",
});

export interface AsyncWriterTestEvent {
  type: "complete" | "fail";
  token: string;
  ingestionTime: string;
}

export const handle: Handler<AsyncWriterTestEvent[], void> = async (event) => {
  console.log(event);
  console.log(
    await Promise.allSettled(
      event.map(async (e) => {
        if (e.type === "complete") {
          await serviceClient.sendActivitySuccess({
            activityToken: e.token,
            result: "hello from the async writer!",
          });
        } else {
          await serviceClient.sendActivityFailure({
            activityToken: e.token,
            error: "AsyncWriterError",
            message: "I was told to fail this activity, sorry.",
          });
        }
      })
    )
  );
};
