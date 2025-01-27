import SentryCli from "@sentry/cli";
import { transformAsync } from "@babel/core";
import componentNameAnnotatePlugin from "@sentry/babel-plugin-component-annotate";
import * as fs from "fs";
import * as path from "path";
import MagicString from "magic-string";
import { createUnplugin, TransformResult, UnpluginOptions } from "unplugin";
import { normalizeUserOptions, validateOptions } from "./options-mapping";
import { createDebugIdUploadFunction } from "./debug-id-upload";
import { releaseManagementPlugin } from "./plugins/release-management";
import { telemetryPlugin } from "./plugins/telemetry";
import { createLogger, Logger } from "./sentry/logger";
import { allowedToSendTelemetry, createSentryInstance } from "./sentry/telemetry";
import { Options, SentrySDKBuildFlags } from "./types";
import {
  generateGlobalInjectorCode,
  generateModuleMetadataInjectorCode,
  getDependencies,
  getPackageJson,
  parseMajorVersion,
  replaceBooleanFlagsInCode,
  stringToUUID,
  stripQueryAndHashFromPath,
} from "./utils";
import * as dotenv from "dotenv";
import { glob } from "glob";
import { logger } from "@sentry/utils";
import { fileDeletionPlugin } from "./plugins/sourcemap-deletion";
import { closeSession, DEFAULT_ENVIRONMENT, makeSession } from "@sentry/core";

interface SentryUnpluginFactoryOptions {
  releaseInjectionPlugin: (injectionCode: string) => UnpluginOptions;
  componentNameAnnotatePlugin?: (ignoredComponents?: string[]) => UnpluginOptions;
  moduleMetadataInjectionPlugin: (injectionCode: string) => UnpluginOptions;
  debugIdInjectionPlugin: (logger: Logger) => UnpluginOptions;
  debugIdUploadPlugin: (
    upload: (buildArtifacts: string[]) => Promise<void>,
    logger: Logger,
    webpack_forceExitOnBuildComplete?: boolean
  ) => UnpluginOptions;
  bundleSizeOptimizationsPlugin: (buildFlags: SentrySDKBuildFlags) => UnpluginOptions;
}

/**
 * The sentry bundler plugin concerns itself with two things:
 * - Release injection
 * - Sourcemaps upload
 *
 * Release injection:
 * Per default the sentry bundler plugin will inject a global `SENTRY_RELEASE` into each JavaScript/TypeScript module
 * that is part of the bundle. On a technical level this is done by appending an import (`import "sentry-release-injector";`)
 * to all entrypoint files of the user code (see `transformInclude` and `transform` hooks). This import is then resolved
 * by the sentry plugin to a virtual module that sets the global variable (see `resolveId` and `load` hooks).
 * If a user wants to inject the release into a particular set of modules they can use the `releaseInjectionTargets` option.
 *
 * Source maps upload:
 *
 * The sentry bundler plugin will also take care of uploading source maps to Sentry. This
 * is all done in the `writeBundle` hook. In this hook the sentry plugin will execute the
 * release creation pipeline:
 *
 * 1. Create a new release
 * 2. Upload sourcemaps based on `include` and source-map-specific options
 * 3. Associate a range of commits with the release (if `setCommits` is specified)
 * 4. Finalize the release (unless `finalize` is disabled)
 * 5. Add deploy information to the release (if `deploy` is specified)
 *
 * This release creation pipeline relies on Sentry CLI to execute the different steps.
 */
export function sentryUnpluginFactory({
  releaseInjectionPlugin,
  componentNameAnnotatePlugin,
  moduleMetadataInjectionPlugin,
  debugIdInjectionPlugin,
  debugIdUploadPlugin,
  bundleSizeOptimizationsPlugin,
}: SentryUnpluginFactoryOptions) {
  return createUnplugin<Options | undefined, true>((userOptions = {}, unpluginMetaContext) => {
    const logger = createLogger({
      prefix:
        userOptions._metaOptions?.loggerPrefixOverride ??
        `[sentry-${unpluginMetaContext.framework}-plugin]`,
      silent: userOptions.silent ?? false,
      debug: userOptions.debug ?? false,
    });

    // Not a bulletproof check but should be good enough to at least sometimes determine
    // if the plugin is called in dev/watch mode or for a  prod build. The important part
    // here is to avoid a false positive. False negatives are okay.
    const isDevMode = process.env["NODE_ENV"] === "development";

    try {
      const dotenvFile = fs.readFileSync(
        path.join(process.cwd(), ".env.sentry-build-plugin"),
        "utf-8"
      );
      // NOTE: Do not use the dotenv.config API directly to read the dotenv file! For some ungodly reason, it falls back to reading `${process.cwd()}/.env` which is absolutely not what we want.
      const dotenvResult = dotenv.parse(dotenvFile);

      // Vite has a bug/behaviour where spreading into process.env will cause it to crash
      // https://github.com/vitest-dev/vitest/issues/1870#issuecomment-1501140251
      Object.assign(process.env, dotenvResult);

      logger.info('Using environment variables configured in ".env.sentry-build-plugin".');
    } catch (e: unknown) {
      // Ignore "file not found" errors but throw all others
      if (typeof e === "object" && e && "code" in e && e.code !== "ENOENT") {
        throw e;
      }
    }

    const options = normalizeUserOptions(userOptions);

    if (isDevMode || options.disable) {
      return [
        {
          name: "sentry-noop-plugin",
        },
      ];
    }

    const shouldSendTelemetry = allowedToSendTelemetry(options);
    const { sentryScope, sentryClient } = createSentryInstance(
      options,
      shouldSendTelemetry,
      unpluginMetaContext.framework
    );

    const { release, environment = DEFAULT_ENVIRONMENT } = sentryClient.getOptions();

    const sentrySession = makeSession({ release, environment });
    sentryScope.setSession(sentrySession);
    // Send the start of the session
    sentryClient.captureSession(sentrySession);

    let sessionHasEnded = false; // Just to prevent infinite loops with beforeExit, which is called whenever the event loop empties out

    function endSession() {
      if (sessionHasEnded) {
        return;
      }

      closeSession(sentrySession);
      sentryClient.captureSession(sentrySession);
      sessionHasEnded = true;
    }

    // We also need to manually end sessions on errors because beforeExit is not called on crashes
    process.on("beforeExit", () => {
      endSession();
    });

    // Set the User-Agent that Sentry CLI will use when interacting with Sentry
    process.env[
      "SENTRY_PIPELINE"
    ] = `${unpluginMetaContext.framework}-plugin/${__PACKAGE_VERSION__}`;

    function handleRecoverableError(unknownError: unknown) {
      sentrySession.status = "abnormal";
      try {
        if (options.errorHandler) {
          try {
            if (unknownError instanceof Error) {
              options.errorHandler(unknownError);
            } else {
              options.errorHandler(new Error("An unknown error occured"));
            }
          } catch (e) {
            sentrySession.status = "crashed";
            throw e;
          }
        } else {
          sentrySession.status = "crashed";
          throw unknownError;
        }
      } finally {
        endSession();
      }
    }

    if (!validateOptions(options, logger)) {
      handleRecoverableError(
        new Error("Options were not set correctly. See output above for more details.")
      );
    }

    if (process.cwd().match(/\\node_modules\\|\/node_modules\//)) {
      logger.warn(
        "Running Sentry plugin from within a `node_modules` folder. Some features may not work."
      );
    }

    const plugins: UnpluginOptions[] = [];

    plugins.push(
      telemetryPlugin({
        sentryClient,
        sentryScope,
        logger,
        shouldSendTelemetry,
      })
    );

    // We have multiple plugins depending on generated source map files. (debug ID upload, legacy upload)
    // Additionally, we also want to have the functionality to delete files after uploading sourcemaps.
    // All of these plugins and the delete functionality need to run in the same hook (`writeBundle`).
    // Since the plugins among themselves are not aware of when they run and finish, we need a system to
    // track their dependencies on the generated files, so that we can initiate the file deletion only after
    // nothing depends on the files anymore.
    const dependenciesOnSourcemapFiles = new Set<symbol>();
    const sourcemapFileDependencySubscribers: (() => void)[] = [];

    function notifySourcemapFileDependencySubscribers() {
      sourcemapFileDependencySubscribers.forEach((subscriber) => {
        subscriber();
      });
    }

    function createDependencyOnSourcemapFiles() {
      const dependencyIdentifier = Symbol();
      dependenciesOnSourcemapFiles.add(dependencyIdentifier);

      return function freeDependencyOnSourcemapFiles() {
        dependenciesOnSourcemapFiles.delete(dependencyIdentifier);
        notifySourcemapFileDependencySubscribers();
      };
    }

    /**
     * Returns a Promise that resolves when all the currently active dependencies are freed again.
     *
     * It is very important that this function is called as late as possible before wanting to await the Promise to give
     * the dependency producers as much time as possible to register themselves.
     */
    function waitUntilSourcemapFileDependenciesAreFreed() {
      return new Promise<void>((resolve) => {
        sourcemapFileDependencySubscribers.push(() => {
          if (dependenciesOnSourcemapFiles.size === 0) {
            resolve();
          }
        });

        if (dependenciesOnSourcemapFiles.size === 0) {
          resolve();
        }
      });
    }

    if (options.bundleSizeOptimizations) {
      const { bundleSizeOptimizations } = options;
      const replacementValues: SentrySDKBuildFlags = {};

      if (bundleSizeOptimizations.excludeDebugStatements) {
        replacementValues["__SENTRY_DEBUG__"] = false;
      }
      if (bundleSizeOptimizations.excludeTracing) {
        replacementValues["__SENTRY_TRACING__"] = false;
      }
      if (bundleSizeOptimizations.excludeReplayCanvas) {
        replacementValues["__RRWEB_EXCLUDE_CANVAS__"] = true;
      }
      if (bundleSizeOptimizations.excludeReplayIframe) {
        replacementValues["__RRWEB_EXCLUDE_IFRAME__"] = true;
      }
      if (bundleSizeOptimizations.excludeReplayShadowDom) {
        replacementValues["__RRWEB_EXCLUDE_SHADOW_DOM__"] = true;
      }
      if (bundleSizeOptimizations.excludeReplayWorker) {
        replacementValues["__SENTRY_EXCLUDE_REPLAY_WORKER__"] = true;
      }

      if (Object.keys(replacementValues).length > 0) {
        plugins.push(bundleSizeOptimizationsPlugin(replacementValues));
      }
    }

    if (!options.release.inject) {
      logger.debug(
        "Release injection disabled via `release.inject` option. Will not inject release."
      );
    } else if (!options.release.name) {
      logger.debug(
        "No release name provided. Will not inject release. Please set the `release.name` option to identify your release."
      );
    } else {
      const injectionCode = generateGlobalInjectorCode({
        release: options.release.name,
        injectBuildInformation: options._experiments.injectBuildInformation || false,
      });
      plugins.push(releaseInjectionPlugin(injectionCode));
    }

    if (options.moduleMetadata || options.applicationKey) {
      let metadata: Record<string, unknown> = {};

      if (options.applicationKey) {
        // We use different keys so that if user-code receives multiple bundling passes, we will store the application keys of all the passes.
        // It is a bit unfortunate that we have to inject the metadata snippet at the top, because after multiple
        // injections, the first injection will always "win" because it comes last in the code. We would generally be
        // fine with making the last bundling pass win. But because it cannot win, we have to use a workaround of storing
        // the app keys in different object keys.
        // We can simply use the `_sentryBundlerPluginAppKey:` to filter for app keys in the SDK.
        metadata[`_sentryBundlerPluginAppKey:${options.applicationKey}`] = true;
      }

      if (typeof options.moduleMetadata === "function") {
        const args = {
          org: options.org,
          project: options.project,
          release: options.release.name,
        };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        metadata = { ...metadata, ...options.moduleMetadata(args) };
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        metadata = { ...metadata, ...options.moduleMetadata };
      }

      const injectionCode = generateModuleMetadataInjectorCode(metadata);
      plugins.push(moduleMetadataInjectionPlugin(injectionCode));
    }

    if (!options.release.name) {
      logger.debug(
        "No release name provided. Will not create release. Please set the `release.name` option to identify your release."
      );
    } else if (!options.authToken) {
      logger.warn(
        "No auth token provided. Will not create release. Please set the `authToken` option. You can find information on how to generate a Sentry auth token here: https://docs.sentry.io/api/auth/"
      );
    } else if (!options.org && !options.authToken.startsWith("sntrys_")) {
      logger.warn(
        "No organization slug provided. Will not create release. Please set the `org` option to your Sentry organization slug."
      );
    } else if (!options.project) {
      logger.warn(
        "No project provided. Will not create release. Please set the `project` option to your Sentry project slug."
      );
    } else {
      plugins.push(
        releaseManagementPlugin({
          logger,
          releaseName: options.release.name,
          shouldCreateRelease: options.release.create,
          shouldFinalizeRelease: options.release.finalize,
          include: options.release.uploadLegacySourcemaps,
          setCommitsOption: options.release.setCommits,
          deployOptions: options.release.deploy,
          dist: options.release.dist,
          handleRecoverableError: handleRecoverableError,
          sentryScope,
          sentryClient,
          sentryCliOptions: {
            authToken: options.authToken,
            org: options.org,
            project: options.project,
            silent: options.silent,
            url: options.url,
            vcsRemote: options.release.vcsRemote,
            headers: options.headers,
          },
          createDependencyOnSourcemapFiles,
        })
      );
    }

    if (!options.sourcemaps?.disable) {
      plugins.push(debugIdInjectionPlugin(logger));
    }

    if (options.sourcemaps?.disable) {
      logger.debug(
        "Source map upload was disabled. Will not upload sourcemaps using debug ID process."
      );
    } else if (!options.authToken) {
      logger.warn(
        "No auth token provided. Will not upload source maps. Please set the `authToken` option. You can find information on how to generate a Sentry auth token here: https://docs.sentry.io/api/auth/"
      );
    } else if (!options.org && !options.authToken.startsWith("sntrys_")) {
      logger.warn(
        "No org provided. Will not upload source maps. Please set the `org` option to your Sentry organization slug."
      );
    } else if (!options.project) {
      logger.warn(
        "No project provided. Will not upload source maps. Please set the `project` option to your Sentry project slug."
      );
    } else {
      // This option is only strongly typed for the webpack plugin, where it is used. It has no effect on other plugins
      const webpack_forceExitOnBuildComplete =
        typeof options._experiments["forceExitOnBuildCompletion"] === "boolean"
          ? options._experiments["forceExitOnBuildCompletion"]
          : undefined;

      plugins.push(
        debugIdUploadPlugin(
          createDebugIdUploadFunction({
            assets: options.sourcemaps?.assets,
            ignore: options.sourcemaps?.ignore,
            createDependencyOnSourcemapFiles,
            dist: options.release.dist,
            releaseName: options.release.name,
            logger: logger,
            handleRecoverableError: handleRecoverableError,
            rewriteSourcesHook: options.sourcemaps?.rewriteSources,
            sentryScope,
            sentryClient,
            sentryCliOptions: {
              authToken: options.authToken,
              org: options.org,
              project: options.project,
              silent: options.silent,
              url: options.url,
              vcsRemote: options.release.vcsRemote,
              headers: options.headers,
            },
          }),
          logger,
          webpack_forceExitOnBuildComplete
        )
      );
    }

    if (options.reactComponentAnnotation) {
      if (!options.reactComponentAnnotation.enabled) {
        logger.debug(
          "The component name annotate plugin is currently disabled. Skipping component name annotations."
        );
      } else if (options.reactComponentAnnotation.enabled && !componentNameAnnotatePlugin) {
        logger.warn(
          "The component name annotate plugin is currently not supported by '@sentry/esbuild-plugin'"
        );
      } else {
        componentNameAnnotatePlugin &&
          plugins.push(
            componentNameAnnotatePlugin(options.reactComponentAnnotation.ignoredComponents)
          );
      }
    }

    plugins.push(
      fileDeletionPlugin({
        waitUntilSourcemapFileDependenciesAreFreed,
        filesToDeleteAfterUpload: options.sourcemaps?.filesToDeleteAfterUpload,
        logger,
        handleRecoverableError,
        sentryScope,
        sentryClient,
      })
    );

    return plugins;
  });
}

export function getBuildInformation() {
  const packageJson = getPackageJson();

  const { deps, depsVersions } = packageJson
    ? getDependencies(packageJson)
    : { deps: [], depsVersions: {} };

  return {
    deps,
    depsVersions,
    nodeVersion: parseMajorVersion(process.version),
  };
}

/**
 * Determines whether the Sentry CLI binary is in its expected location.
 * This function is useful since `@sentry/cli` installs the binary via a post-install
 * script and post-install scripts may not always run. E.g. with `npm i --ignore-scripts`.
 */
export function sentryCliBinaryExists(): boolean {
  return fs.existsSync(SentryCli.getPath());
}

export function createRollupReleaseInjectionHooks(injectionCode: string) {
  const virtualReleaseInjectionFileId = "\0sentry-release-injection-file";
  return {
    resolveId(id: string) {
      if (id === virtualReleaseInjectionFileId) {
        return {
          id: virtualReleaseInjectionFileId,
          external: false,
          moduleSideEffects: true,
        };
      } else {
        return null;
      }
    },

    load(id: string) {
      if (id === virtualReleaseInjectionFileId) {
        return injectionCode;
      } else {
        return null;
      }
    },

    transform(code: string, id: string) {
      if (id === virtualReleaseInjectionFileId) {
        return null;
      }

      // id may contain query and hash which will trip up our file extension logic below
      const idWithoutQueryAndHash = stripQueryAndHashFromPath(id);

      if (idWithoutQueryAndHash.match(/\\node_modules\\|\/node_modules\//)) {
        return null;
      }

      if (
        ![".js", ".ts", ".jsx", ".tsx", ".mjs"].some((ending) =>
          idWithoutQueryAndHash.endsWith(ending)
        )
      ) {
        return null;
      }

      const ms = new MagicString(code);

      // Appending instead of prepending has less probability of mucking with user's source maps.
      // Luckily import statements get hoisted to the top anyways.
      ms.append(`\n\n;import "${virtualReleaseInjectionFileId}";`);

      return {
        code: ms.toString(),
        map: ms.generateMap({ hires: "boundary" }),
      };
    },
  };
}

export function createRollupBundleSizeOptimizationHooks(replacementValues: SentrySDKBuildFlags) {
  return {
    transform(code: string) {
      return replaceBooleanFlagsInCode(code, replacementValues);
    },
  };
}

// We need to be careful not to inject the snippet before any `"use strict";`s.
// As an additional complication `"use strict";`s may come after any number of comments.
const COMMENT_USE_STRICT_REGEX =
  // Note: CodeQL complains that this regex potentially has n^2 runtime. This likely won't affect realistic files.
  /^(?:\s*|\/\*(?:.|\r|\n)*?\*\/|\/\/.*[\n\r])*(?:"[^"]*";|'[^']*';)?/;

export function createRollupDebugIdInjectionHooks() {
  return {
    renderChunk(code: string, chunk: { fileName: string }) {
      if (
        // chunks could be any file (html, md, ...)
        [".js", ".mjs", ".cjs"].some((ending) =>
          stripQueryAndHashFromPath(chunk.fileName).endsWith(ending)
        )
      ) {
        const debugId = stringToUUID(code); // generate a deterministic debug ID
        const codeToInject = getDebugIdSnippet(debugId);

        const ms = new MagicString(code, { filename: chunk.fileName });

        const match = code.match(COMMENT_USE_STRICT_REGEX)?.[0];

        if (match) {
          // Add injected code after any comments or "use strict" at the beginning of the bundle.
          ms.appendLeft(match.length, codeToInject);
        } else {
          // ms.replace() doesn't work when there is an empty string match (which happens if
          // there is neither, a comment, nor a "use strict" at the top of the chunk) so we
          // need this special case here.
          ms.prepend(codeToInject);
        }

        return {
          code: ms.toString(),
          map: ms.generateMap({ file: chunk.fileName, hires: "boundary" }),
        };
      } else {
        return null; // returning null means not modifying the chunk at all
      }
    },
  };
}

export function createRollupModuleMetadataInjectionHooks(injectionCode: string) {
  return {
    renderChunk(code: string, chunk: { fileName: string }) {
      if (
        // chunks could be any file (html, md, ...)
        [".js", ".mjs", ".cjs"].some((ending) =>
          stripQueryAndHashFromPath(chunk.fileName).endsWith(ending)
        )
      ) {
        const ms = new MagicString(code, { filename: chunk.fileName });

        const match = code.match(COMMENT_USE_STRICT_REGEX)?.[0];

        if (match) {
          // Add injected code after any comments or "use strict" at the beginning of the bundle.
          ms.appendLeft(match.length, injectionCode);
        } else {
          // ms.replace() doesn't work when there is an empty string match (which happens if
          // there is neither, a comment, nor a "use strict" at the top of the chunk) so we
          // need this special case here.
          ms.prepend(injectionCode);
        }

        return {
          code: ms.toString(),
          map: ms.generateMap({ file: chunk.fileName, hires: "boundary" }),
        };
      } else {
        return null; // returning null means not modifying the chunk at all
      }
    },
  };
}

export function createRollupDebugIdUploadHooks(
  upload: (buildArtifacts: string[]) => Promise<void>
) {
  return {
    async writeBundle(
      outputOptions: { dir?: string; file?: string },
      bundle: { [fileName: string]: unknown }
    ) {
      if (outputOptions.dir) {
        const outputDir = outputOptions.dir;
        const buildArtifacts = await glob(
          [
            "/**/*.js",
            "/**/*.mjs",
            "/**/*.cjs",
            "/**/*.js.map",
            "/**/*.mjs.map",
            "/**/*.cjs.map",
          ].map((q) => `${q}?(\\?*)?(#*)`), // We want to allow query and hashes strings at the end of files
          {
            root: outputDir,
            absolute: true,
            nodir: true,
          }
        );
        await upload(buildArtifacts);
      } else if (outputOptions.file) {
        await upload([outputOptions.file]);
      } else {
        const buildArtifacts = Object.keys(bundle).map((asset) => path.join(path.resolve(), asset));
        await upload(buildArtifacts);
      }
    },
  };
}

export function createComponentNameAnnotateHooks(ignoredComponents?: string[]) {
  type ParserPlugins = NonNullable<
    NonNullable<Parameters<typeof transformAsync>[1]>["parserOpts"]
  >["plugins"];

  return {
    async transform(this: void, code: string, id: string): Promise<TransformResult> {
      // id may contain query and hash which will trip up our file extension logic below
      const idWithoutQueryAndHash = stripQueryAndHashFromPath(id);

      if (idWithoutQueryAndHash.match(/\\node_modules\\|\/node_modules\//)) {
        return null;
      }

      // We will only apply this plugin on jsx and tsx files
      if (![".jsx", ".tsx"].some((ending) => idWithoutQueryAndHash.endsWith(ending))) {
        return null;
      }

      const parserPlugins: ParserPlugins = [];
      if (idWithoutQueryAndHash.endsWith(".jsx")) {
        parserPlugins.push("jsx");
      } else if (idWithoutQueryAndHash.endsWith(".tsx")) {
        parserPlugins.push("jsx", "typescript");
      }

      try {
        const result = await transformAsync(code, {
          plugins: [[componentNameAnnotatePlugin, { ignoredComponents }]],
          filename: id,
          parserOpts: {
            sourceType: "module",
            allowAwaitOutsideFunction: true,
            plugins: parserPlugins,
          },
          generatorOpts: {
            decoratorsBeforeExport: true,
          },
          sourceMaps: true,
        });

        return {
          code: result?.code ?? code,
          map: result?.map,
        };
      } catch (e) {
        logger.error(`Failed to apply react annotate plugin`, e);
      }

      return { code };
    },
  };
}

export function getDebugIdSnippet(debugId: string): string {
  return `;{try{let e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[n]="${debugId}",e._sentryDebugIdIdentifier="sentry-dbid-${debugId}")}catch(e){}};`;
}

export { stringToUUID, replaceBooleanFlagsInCode } from "./utils";

export type { Options, SentrySDKBuildFlags } from "./types";
export type { Logger } from "./sentry/logger";
