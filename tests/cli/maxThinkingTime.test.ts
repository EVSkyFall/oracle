import { afterEach, beforeEach, describe, expect, test } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBrowserConfig } from "../../src/cli/browserConfig.js";
import {
  applyBrowserDefaultsFromConfig,
  type BrowserDefaultsOptions,
} from "../../src/cli/browserDefaults.js";
import { resolveBrowserConfig } from "../../src/browser/config.js";
import { consultInputSchema } from "../../src/mcp/types.js";
import {
  buildConsultBrowserConfig,
  buildConsultDryRunResolved,
  formatConsultDryRunResolved,
} from "../../src/mcp/tools/consult.js";
import { buildChatGptImageConsultInput } from "../../src/mcp/tools/chatgptImage.js";
import { pickClientBrowserConfig } from "../../src/remote/server.js";
import { loadUserConfig, PROJECT_CONFIG_RELATIVE_PATH } from "../../src/config.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

// --browser-max-thinking-time and its config/MCP equivalents reach the browser run.
describe("maximum thinking time", () => {
  test("the CLI flag lands in the session config and the resolved browser config", async () => {
    const config = await buildBrowserConfig({
      model: "gpt-6-astra",
      browserModelStrategy: "current",
      browserMaxThinkingTime: "extra-high",
    });
    expect(config.maxThinkingTime).toBe("extra-high");
    expect(resolveBrowserConfig(config).maxThinkingTime).toBe("extra-high");
    expect((await buildBrowserConfig({ model: "gpt-6-astra" })).maxThinkingTime).toBeUndefined();
  });

  test("browser.maxThinkingTime in config applies unless the CLI set it", () => {
    const fromConfig: BrowserDefaultsOptions = {};
    applyBrowserDefaultsFromConfig(
      fromConfig,
      { browser: { maxThinkingTime: "Extra High" as never } },
      () => undefined,
    );
    expect(fromConfig.browserMaxThinkingTime).toBe("extra-high");
    const fromCli: BrowserDefaultsOptions = { browserMaxThinkingTime: "standard" };
    applyBrowserDefaultsFromConfig(
      fromCli,
      { browser: { maxThinkingTime: "extra-high" } },
      (key) => (key === "browserMaxThinkingTime" ? "cli" : undefined),
    );
    expect(fromCli.browserMaxThinkingTime).toBe("standard");
  });

  test("MCP consult and image inputs, and the configured default, set the maximum", () => {
    const parsed = consultInputSchema.parse({ prompt: "x", browserMaxThinkingTime: "extra-high" });
    expect(parsed.browserMaxThinkingTime).toBe("extra-high");
    const base = { env: {}, runModel: "gpt-6-astra" };
    expect(
      buildConsultBrowserConfig({
        ...base,
        userConfig: { browser: { maxThinkingTime: "extra-high" } },
      }).maxThinkingTime,
    ).toBe("extra-high");
    expect(
      buildConsultBrowserConfig({
        ...base,
        userConfig: { browser: { maxThinkingTime: "extra-high" } },
        browserMaxThinkingTime: "standard",
      }).maxThinkingTime,
    ).toBe("standard");
    expect(buildConsultBrowserConfig({ ...base, userConfig: {} }).maxThinkingTime).toBeUndefined();
    expect(
      buildChatGptImageConsultInput({
        prompt: "cat",
        files: [],
        browserMaxThinkingTime: "extra-high",
      }).browserMaxThinkingTime,
    ).toBe("extra-high");
  });

  test("an MCP dry run shows the maximum", () => {
    const details = buildConsultDryRunResolved({
      resolvedEngine: "browser",
      runOptions: { prompt: "x", model: "gpt-6-astra" } as never,
      browserConfig: { maxThinkingTime: "extra-high" },
    } as never);
    expect(formatConsultDryRunResolved(details)).toContain(
      "  browser max thinking time: extra-high",
    );
  });

  test("a remote host accepts the client's maximum", () => {
    expect(pickClientBrowserConfig({ maxThinkingTime: "extra-high" })).toEqual({
      maxThinkingTime: "extra-high",
    });
  });

  describe("project config", () => {
    let home: string;
    let repo: string;
    beforeEach(async () => {
      home = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-max-home-"));
      repo = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-max-repo-"));
      setOracleHomeDirOverrideForTest(home);
    });
    afterEach(async () => {
      setOracleHomeDirOverrideForTest(null);
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(repo, { recursive: true, force: true });
    });

    test("a project config may set the maximum, like the thinking time", async () => {
      await fs.mkdir(path.join(repo, ".oracle"));
      await fs.writeFile(
        path.join(repo, PROJECT_CONFIG_RELATIVE_PATH),
        JSON.stringify({ browser: { maxThinkingTime: "extra-high" } }),
      );
      const result = await loadUserConfig({ cwd: repo });
      expect(result.config.browser?.maxThinkingTime).toBe("extra-high");
    });
  });
});
