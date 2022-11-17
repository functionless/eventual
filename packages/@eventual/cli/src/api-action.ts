import { HTTPError } from "ky";
import ora, { Ora } from "ora";
import { Arguments } from "yargs";
import { apiKy } from "./api-ky.js";
import { styledConsole } from "./styled-console.js";
import type { KyInstance } from "./types.js";

export type ApiAction<T> = (
  spinner: Ora,
  ky: KyInstance,
  args: Arguments<T>
) => Promise<void>;

/**
 * Designed to be used in command.action. Injects a usable api ky instance and wraps errors nicely
 * @param action Callback to perform for the action
 */
export const apiAction =
  <T>(action: ApiAction<T>, _onError?: (error: any) => Promise<void> | void) =>
  async (args: Arguments<{ region?: string } & T>) => {
    const spinner = ora().start("Preparing");
    try {
      const ky = await apiKy(args.region);
      return await action(spinner, ky, args);
    } catch (e: any) {
      spinner.fail(e.message);
    }
  };

/**
 * Catch api errors and print the messages nicely
 * @param req promise to catch
 */
export async function styledCatchApiRequestError<T>(
  req: Promise<T>,
  onError: (e: any) => Promise<T> | T
): Promise<T> {
  return req.catch(async (e) => {
    if (e instanceof HTTPError) {
      styledConsole.error(await e.response.json());
    } else {
      console.log(e);
    }
    return await onError(e);
  });
}

/**
 * Wrapper for Command constructor, adding region necessary for api calls
 * @param name command name
 * @returns the command
 */
export const apiOptions = {
  region: { alias: "r", string: true },
} as const;
