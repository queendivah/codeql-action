import * as core from "@actions/core";

import {
  createStatusReportBase,
  getOptionalInput,
  getRequiredEnvParam,
  getRequiredInput,
  getTemporaryDirectory,
  getToolCacheDirectory,
  Mode,
  prepareLocalRunEnvironment,
  sendStatusReport,
  setMode,
  StatusReportBase,
  validateWorkflow,
} from "./actions-util";
import { CodeQL } from "./codeql";
import * as configUtils from "./config-utils";
import {
  initCodeQL,
  initConfig,
  injectWindowsTracer,
  installPythonDeps,
  runInit,
} from "./init";
import { Language } from "./languages";
import { getActionsLogger } from "./logging";
import { parseRepositoryNwo } from "./repository";
import { checkGitHubVersionInRange, getGitHubVersion } from "./util";

interface InitSuccessStatusReport extends StatusReportBase {
  // Comma-separated list of languages that analysis was run for
  // This may be from the workflow file or may be calculated from repository contents
  languages: string;
  // Comma-separated list of languages specified explicitly in the workflow file
  workflow_languages: string;
  // Comma-separated list of paths, from the 'paths' config field
  paths: string;
  // Comma-separated list of paths, from the 'paths-ignore' config field
  paths_ignore: string;
  // Commas-separated list of languages where the default queries are disabled
  disable_default_queries: string;
  // Comma-separated list of queries sources, from the 'queries' config field or workflow input
  queries: string;
  // Value given by the user as the "tools" input
  tools_input: string;
  // Version of the bundle used
  tools_resolved_version: string;
}

async function sendSuccessStatusReport(
  startedAt: Date,
  config: configUtils.Config,
  toolsVersion: string
) {
  const statusReportBase = await createStatusReportBase(
    "init",
    "success",
    startedAt
  );

  const languages = config.languages.join(",");
  const workflowLanguages = getOptionalInput("languages");
  const paths = (config.originalUserInput.paths || []).join(",");
  const pathsIgnore = (config.originalUserInput["paths-ignore"] || []).join(
    ","
  );
  const disableDefaultQueries = config.originalUserInput[
    "disable-default-queries"
  ]
    ? languages
    : "";

  const queries: string[] = [];
  let queriesInput = getOptionalInput("queries")?.trim();
  if (queriesInput === undefined || queriesInput.startsWith("+")) {
    queries.push(
      ...(config.originalUserInput.queries || []).map((q) => q.uses)
    );
  }
  if (queriesInput !== undefined) {
    queriesInput = queriesInput.startsWith("+")
      ? queriesInput.substr(1)
      : queriesInput;
    queries.push(...queriesInput.split(","));
  }

  const statusReport: InitSuccessStatusReport = {
    ...statusReportBase,
    languages,
    workflow_languages: workflowLanguages || "",
    paths,
    paths_ignore: pathsIgnore,
    disable_default_queries: disableDefaultQueries,
    queries: queries.join(","),
    tools_input: getOptionalInput("tools") || "",
    tools_resolved_version: toolsVersion,
  };

  await sendStatusReport(statusReport);
}

async function run() {
  const startedAt = new Date();
  const logger = getActionsLogger();
  setMode(Mode.actions);

  let config: configUtils.Config;
  let codeql: CodeQL;
  let toolsVersion: string;

  const apiDetails = {
    auth: getRequiredInput("token"),
    externalRepoAuth: getOptionalInput("external-repository-token"),
    url: getRequiredEnvParam("GITHUB_SERVER_URL"),
  };

  const gitHubVersion = await getGitHubVersion(apiDetails);
  checkGitHubVersionInRange(gitHubVersion, logger, Mode.actions);

  try {
    prepareLocalRunEnvironment();

    const workflowErrors = await validateWorkflow();

    if (
      !(await sendStatusReport(
        await createStatusReportBase(
          "init",
          "starting",
          startedAt,
          workflowErrors
        )
      ))
    ) {
      return;
    }

    const initCodeQLResult = await initCodeQL(
      getOptionalInput("tools"),
      apiDetails,
      getTemporaryDirectory(),
      getToolCacheDirectory(),
      gitHubVersion.type,
      logger
    );
    codeql = initCodeQLResult.codeql;
    toolsVersion = initCodeQLResult.toolsVersion;

    config = await initConfig(
      getOptionalInput("languages"),
      getOptionalInput("queries"),
      getOptionalInput("config-file"),
      getOptionalInput("db-location"),
      parseRepositoryNwo(getRequiredEnvParam("GITHUB_REPOSITORY")),
      getTemporaryDirectory(),
      getRequiredEnvParam("RUNNER_TOOL_CACHE"),
      codeql,
      getRequiredEnvParam("GITHUB_WORKSPACE"),
      gitHubVersion,
      apiDetails,
      logger
    );

    if (
      config.languages.includes(Language.python) &&
      getRequiredInput("setup-python-dependencies") === "true"
    ) {
      try {
        await installPythonDeps(codeql, logger);
      } catch (err) {
        logger.warning(
          `${err.message} You can call this action with 'setup-python-dependencies: false' to disable this process`
        );
      }
    }
  } catch (e) {
    core.setFailed(e.message);
    console.log(e);
    await sendStatusReport(
      await createStatusReportBase("init", "aborted", startedAt, e.message)
    );
    return;
  }

  try {
    // Forward Go flags
    const goFlags = process.env["GOFLAGS"];
    if (goFlags) {
      core.exportVariable("GOFLAGS", goFlags);
      core.warning(
        "Passing the GOFLAGS env parameter to the init action is deprecated. Please move this to the analyze action."
      );
    }

    // Setup CODEQL_RAM flag (todo improve this https://github.com/github/dsp-code-scanning/issues/935)
    const codeqlRam = process.env["CODEQL_RAM"] || "6500";
    core.exportVariable("CODEQL_RAM", codeqlRam);

    const tracerConfig = await runInit(codeql, config);
    if (tracerConfig !== undefined) {
      for (const [key, value] of Object.entries(tracerConfig.env)) {
        core.exportVariable(key, value);
      }

      if (process.platform === "win32") {
        await injectWindowsTracer(
          "Runner.Worker.exe",
          undefined,
          config,
          codeql,
          tracerConfig
        );
      }
    }

    core.setOutput("codeql-path", config.codeQLCmd);
  } catch (error) {
    core.setFailed(error.message);
    console.log(error);
    await sendStatusReport(
      await createStatusReportBase(
        "init",
        "failure",
        startedAt,
        error.message,
        error.stack
      )
    );
    return;
  }
  await sendSuccessStatusReport(startedAt, config, toolsVersion);
}

async function runWrapper() {
  try {
    await run();
  } catch (error) {
    core.setFailed(`init action failed: ${error}`);
    console.log(error);
  }
}

void runWrapper();
