import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import chalk from "chalk";
import { sessionStore } from "../sessionStore.js";
import type { SessionMetadata } from "../sessionStore.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { formatWebSocketHost, readDevToolsActivePortInfo } from "../browser/detect.js";
import { browserPromptFingerprint } from "../browser/promptFingerprint.js";
import {
  collectChatGptTabs,
  DEFAULT_REMOTE_CHROME_HOST,
  DEFAULT_REMOTE_CHROME_PORT,
  formatBrowserTabState,
  harvestChatGptTab,
  sessionMatchesTab,
  type ChatGptTabSummary,
  type LiveChromeEndpoint,
} from "../browser/liveTabs.js";
import {
  isRecoveredConversationHarvestReady,
  recoverConversationTab,
} from "../browser/recoverConversation.js";
import { isAnswerNowPlaceholderText } from "../browser/actions/assistantResponse.js";
import { isImageOnlyUiChromeText } from "../browser/index.js";
import { promptAppearsInText } from "../browser/promptMatch.js";
import { resolveOutputPath } from "./writeOutputPath.js";
import { persistBrowserHarvest } from "./harvestIntegrity.js";
import { completeOwnedBrowserHarvest } from "./recoveredBrowserHarvest.js";
import { releaseHarvestSlot, takeHarvestSlot } from "./harvestChromeRelease.js";
import type { BrowserHarvestIntegrity } from "../sessionManager.js";

const LIVE_POLL_MS = 2000;
const DEFAULT_STALL_THRESHOLD_MS = 60_000;
const HARVEST_FRESHNESS_POLL_MS = 250;
// Per poll, how long the normal capture's terminal proof may take on this session's turn. It
// needs four samples about 400 ms apart with the text stable for 1.2 s, so a finished turn is
// proven in about two seconds; 10 s leaves room for a slow renderer. An unproven turn is polled
// again by the caller, so this only spaces the polls.
const TURN_COMPLETE_PROOF_MS = 10_000;

function isRecoverableMissingTabError(message: string): boolean {
  return (
    message.includes("No ChatGPT tab matched") ||
    message.includes("No live ChatGPT tabs found") ||
    message.includes("ECONNREFUSED") ||
    message.includes("Could not connect")
  );
}

/**
 * How this session's submitted user turn is recognized: its fingerprint (committed text and stable
 * message id), or, when no fingerprint was recorded for a sent prompt, the prompt's text.
 * Undefined: a legacy session or an explicit tab, where only the pairing is checked.
 */
type SessionTurnIdentity = { fingerprint: string } | { promptText: string };

/** Whether the latest user turn on the page is the one this session submitted. */
function latestUserIsSessionTurn(
  harvested: ChatGptTabSummary,
  identity: SessionTurnIdentity | undefined,
): boolean {
  if (identity === undefined) return true;
  if ("promptText" in identity) {
    // The same match the run's commit check uses on the latest user turn.
    return [harvested.lastUserTextRaw, harvested.lastUserText, harvested.lastUserContentText].some(
      (text) => typeof text === "string" && promptAppearsInText(identity.promptText, text),
    );
  }
  const fingerprint = identity.fingerprint;
  return (
    (typeof harvested.lastUserMessageId === "string" &&
      harvested.lastUserMessageId.trim().length > 0 &&
      // ChatGPT can append transient status text outside the user's content after submission.
      // Keep legacy full-container hashes valid and require an exact match for either form.
      [harvested.lastUserTextRaw ?? harvested.lastUserText, harvested.lastUserContentText].some(
        (text) =>
          typeof text === "string" &&
          browserPromptFingerprint(text, harvested.lastUserMessageId!) === fingerprint,
      ))
  );
}

/**
 * Where this session's turn stands on the page. Only an assistant answer that follows this
 * session's own user turn is its answer: the last assistant message on the page can belong to an
 * earlier turn while this one is still being generated (a Pro turn shows no assistant message
 * until late). Placeholders and UI chrome ("ChatGPT said:", "Pro thinking Answer now", "Stopped
 * thinking Edit") are never an answer. With `requireFinished`, only text the normal capture's
 * terminal proof confirmed is the answer (`lastAssistantFinished`): a preamble can show without
 * the stop button for a moment.
 */
type SessionTurnState = "answer" | "generating" | "no-answer" | "other-turn";

function sessionTurnState(
  harvested: ChatGptTabSummary,
  identity: SessionTurnIdentity | undefined,
  requireFinished: boolean,
): SessionTurnState {
  if (!latestUserIsSessionTurn(harvested, identity)) return "other-turn";
  const answer = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
  if (
    harvested.assistantFollowsLatestUser !== true ||
    !answer.trim() ||
    isAnswerNowPlaceholderText(answer) ||
    isImageOnlyUiChromeText(answer)
  ) {
    return harvested.stopExists ? "generating" : "no-answer";
  }
  if (!requireFinished) return "answer";
  return harvested.lastAssistantFinished === true ? "answer" : "generating";
}

function describeSessionTurn(state: SessionTurnState): string {
  switch (state) {
    case "generating":
      return "This session's turn is still being generated (its answer is not finished yet)";
    case "no-answer":
      return "This session's turn has no assistant answer on the page";
    case "other-turn":
      return "The latest turn on the page is not the one this session submitted";
    default:
      return "This session's turn has its answer";
  }
}

/** The text of the last prompt this session sends: its last in-run follow-up, else its prompt. */
function sessionLastPromptText(meta: SessionMetadata): string | undefined {
  const options = (meta.options ?? {}) as { prompt?: unknown; browserFollowUps?: unknown };
  const followUps = Array.isArray(options.browserFollowUps)
    ? options.browserFollowUps.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
  const prompt = followUps.at(-1) ?? options.prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt : undefined;
}

/** How this session's submitted turn is recognized (undefined: legacy session or an explicit tab). */
function sessionTurnIdentity(
  meta: SessionMetadata,
  requireSessionPrompt: boolean,
): SessionTurnIdentity | undefined {
  if (!requireSessionPrompt) return undefined;
  const runtime = meta.browser?.runtime;
  const fingerprint = runtime?.submittedPromptHash;
  if (typeof fingerprint === "string") return { fingerprint };
  if (fingerprint === null) {
    // The prompt was sent but its commit was not proven, so no fingerprint was recorded.
    const promptText = runtime?.promptSubmitted === true ? sessionLastPromptText(meta) : undefined;
    if (promptText) {
      console.log(
        "[reattach] No submitted-turn fingerprint was recorded for this session; its turn is identified by its prompt text.",
      );
      return { promptText };
    }
    throw new Error(
      "This browser session has no confirmed submitted user turn; retry after submission or use --browser-tab to inspect a specific tab.",
    );
  }
  console.warn(
    "Legacy browser session: submitted-turn identity is unavailable; verifying only latest user/assistant pairing.",
  );
  return undefined;
}

async function harvestSessionPrompt(
  meta: SessionMetadata,
  options: Parameters<typeof harvestChatGptTab>[0],
  requireSessionPrompt = true,
): Promise<ChatGptTabSummary> {
  const identity = sessionTurnIdentity(meta, requireSessionPrompt);
  // This session's turn is saved only once it has finished; an explicit tab is a snapshot.
  const requireFinished = requireSessionPrompt;
  const harvestOptions = requireFinished
    ? { ...options, confirmTurnComplete: { timeoutMs: TURN_COMPLETE_PROOF_MS } }
    : options;
  const freshnessTimeoutMs = resolveBrowserConfig(meta.browser?.config).inputTimeoutMs;
  const deadline = Date.now() + freshnessTimeoutMs;
  let harvested = await harvestChatGptTab(harvestOptions);
  let state = sessionTurnState(harvested, identity, requireFinished);
  while (state !== "answer" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, HARVEST_FRESHNESS_POLL_MS));
    harvested = await harvestChatGptTab(harvestOptions);
    state = sessionTurnState(harvested, identity, requireFinished);
  }
  if (state !== "answer") {
    throw new Error(
      `${describeSessionTurn(state)} after ${Math.ceil(freshnessTimeoutMs / 1000)}s; nothing was saved (refusing to harvest stale output).${state === "generating" ? " Use --live to wait for the answer." : ""}`,
    );
  }
  return harvested;
}

export interface BrowserHarvestOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  stallWindowMs?: number;
  quietOutput?: boolean;
  /**
   * When the live tab cannot be found, relaunch Chrome with the session's
   * persistent profile and navigate to the saved tab URL, then retry harvest.
   * Default: true.
   */
  recoverIfMissing?: boolean;
  /**
   * After a successful recovery harvest, close the relaunched Chrome.
   * Defaults to the saved keepBrowser setting; borrowed Chrome is never closed.
   */
  closeAfterRecover?: boolean;
}

export interface BrowserLiveTailOptions {
  writeOutputPath?: string;
  browserTabRef?: string;
  /** How long a relaunched conversation may take to show its content. */
  stallThresholdMs?: number;
  /**
   * How long to wait for this session's answer (default: the session's browser timeout). While
   * ChatGPT still generates this session's turn, the tail keeps waiting; it never saves an
   * earlier turn's answer.
   */
  waitMs?: number;
  /**
   * When no live tab matches the session's stored target, relaunch Chrome with
   * the persistent profile and navigate to the saved tab URL before tailing.
   * Default: true.
   */
  recoverIfMissing?: boolean;
  /**
   * After completion, close the relaunched Chrome.
   * Defaults to the saved keepBrowser setting; borrowed Chrome is never closed.
   */
  closeAfterRecover?: boolean;
}

async function sessionBrowserEndpoint(
  meta: SessionMetadata | null | undefined,
): Promise<(LiveChromeEndpoint & { host: string; port: number }) | null> {
  const runtime = meta?.browser?.runtime ?? {};
  const remote: { host?: string; port?: number } = meta?.browser?.config?.remoteChrome ?? {};
  const host = runtime.chromeHost ?? remote.host;
  const port = runtime.chromePort ?? remote.port;
  if (!host || !port) {
    return null;
  }
  let browserWSEndpoint = runtime.chromeBrowserWSEndpoint;
  let livePort = port;
  if (browserWSEndpoint) {
    const active = runtime.chromeProfileRoot
      ? await readDevToolsActivePortInfo(runtime.chromeProfileRoot, { host }).catch(() => null)
      : null;
    if (active) {
      browserWSEndpoint = active.browserWSEndpoint;
      livePort = active.port;
    } else {
      // A restarted Chrome can keep its port while changing its browser socket ID.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1000);
      try {
        const response = await fetch(`http://${formatWebSocketHost(host)}:${port}/json/version`, {
          signal: controller.signal,
        });
        if (response.ok) {
          const version = (await response.json()) as { webSocketDebuggerUrl?: string };
          const advertised = new URL(version.webSocketDebuggerUrl ?? "");
          if (advertised.pathname.startsWith("/devtools/browser/")) {
            const refreshed = new URL(browserWSEndpoint);
            refreshed.pathname = advertised.pathname;
            browserWSEndpoint = refreshed.toString();
          }
        }
      } catch {
        // Attach-running Chrome may disable HTTP discovery; keep its saved socket.
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    }
  }
  return {
    host,
    port: livePort,
    ...(browserWSEndpoint
      ? {
          browserWSEndpoint,
          approvalWaitMs: resolveBrowserConfig(meta?.browser?.config).approvalWaitMs,
        }
      : {}),
  };
}

async function collectUniqueEndpoints(
  metas: SessionMetadata[],
): Promise<Array<LiveChromeEndpoint & { host: string; port: number }>> {
  const entries = new Map<string, LiveChromeEndpoint & { host: string; port: number }>();
  entries.set(`${DEFAULT_REMOTE_CHROME_HOST}:${DEFAULT_REMOTE_CHROME_PORT}:http`, {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  });
  for (const endpoint of await Promise.all(metas.map(sessionBrowserEndpoint))) {
    if (!endpoint) {
      continue;
    }
    entries.set(
      `${endpoint.host}:${endpoint.port}:${endpoint.browserWSEndpoint ?? "http"}`,
      endpoint,
    );
  }
  return Array.from(entries.values());
}

function buildSessionIndex(metas: SessionMetadata[]): SessionMetadata[] {
  return metas
    .filter((meta) => meta?.mode === "browser")
    .sort((left, right) =>
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")),
    );
}

function resolveLinkedSession(
  tab: ChatGptTabSummary,
  metas: SessionMetadata[],
): SessionMetadata | null {
  return buildSessionIndex(metas).find((meta) => sessionMatchesTab(meta, tab)) ?? null;
}

function snippet(text: string, max = 120): string {
  const normalized = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function resolveSessionTabRef(meta: SessionMetadata): string {
  const runtime = meta?.browser?.runtime ?? {};
  const harvest = meta?.browser?.harvest ?? {};
  return (
    harvest.url ??
    runtime.tabUrl ??
    harvest.conversationId ??
    runtime.conversationId ??
    harvest.targetId ??
    runtime.chromeTargetId ??
    "current"
  );
}

export function resolveSessionTabRefForTest(meta: SessionMetadata): string {
  return resolveSessionTabRef(meta);
}

function printHarvestSummary(
  sessionId: string,
  harvested: ChatGptTabSummary,
  integrity: BrowserHarvestIntegrity,
): void {
  console.log(chalk.bold(`Session: ${sessionId}`));
  console.log(`Target: ${harvested.targetId}`);
  console.log(`State: ${formatBrowserTabState(harvested)}`);
  console.log(`Model: ${harvested.currentModelLabel || "(unknown)"}`);
  console.log(`URL: ${harvested.url}`);
  console.log(`Assistant turns: ${harvested.assistantCount}`);
  console.log(
    `Capture identity: ${integrity.status}${integrity.explicitTarget ? " (explicit target)" : ""}`,
  );
  if (integrity.status === "mismatch") {
    console.log(
      chalk.yellow(
        "Explicit harvest target differs from the saved capture; original artifacts are unchanged.",
      ),
    );
  }
  console.log(
    `Signals: stop=${harvested.stopExists ? "yes" : "no"} send=${harvested.sendExists ? "yes" : "no"}`,
  );
  if (harvested.lastUserSnippet) {
    console.log(`Last user: ${harvested.lastUserSnippet}`);
  }
  console.log(chalk.dim("---"));
}

async function maybeWriteHarvestOutput(
  pathInput: string | undefined,
  cwd: string,
  content: string,
): Promise<void> {
  const resolved = resolveOutputPath(pathInput, cwd);
  if (!resolved) {
    return;
  }
  const payload = content ?? "";
  if (resolved === "-" || resolved === "/dev/stdout") {
    process.stdout.write(`${payload}${payload.endsWith("\n") ? "" : "\n"}`);
    return;
  }
  await fs.writeFile(resolved, payload, "utf8");
  console.log(chalk.dim(`Wrote harvested assistant output to ${resolved}`));
}

export async function showBrowserTabsStatus(): Promise<void> {
  const metas = await sessionStore.listSessions().catch(() => [] as SessionMetadata[]);
  const endpoints = await collectUniqueEndpoints(metas);
  let printedAny = false;
  for (const endpoint of endpoints) {
    let tabs: ChatGptTabSummary[];
    try {
      tabs = await collectChatGptTabs(endpoint);
    } catch {
      continue;
    }
    if (tabs.length === 0) {
      continue;
    }
    printedAny = true;
    console.log(chalk.bold(`Browser Tabs ${endpoint.host}:${endpoint.port}`));
    for (const tab of tabs) {
      const linkedSession = resolveLinkedSession(
        { ...tab, host: endpoint.host, port: endpoint.port },
        metas,
      );
      console.log(
        `- ${tab.targetId} ${formatBrowserTabState(tab)} model=${tab.currentModelLabel || "(unknown)"} turns=${tab.assistantCount} stop=${tab.stopExists ? "yes" : "no"} send=${tab.sendExists ? "yes" : "no"}`,
      );
      console.log(`  title=${tab.title || "(untitled)"}`);
      console.log(`  url=${tab.url}`);
      if (linkedSession) {
        console.log(`  session=${linkedSession.id}`);
      }
      if (tab.lastAssistantSnippet) {
        console.log(`  last=${snippet(tab.lastAssistantSnippet)}`);
      }
    }
  }
  if (!printedAny) {
    console.log("No live ChatGPT tabs found on known Chrome DevTools endpoints.");
  }
}

export async function harvestSessionBrowserOutput(
  sessionId: string,
  options: BrowserHarvestOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  const recordedEndpoint = await sessionBrowserEndpoint(meta);
  const initialEndpoint = recordedEndpoint ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  const ref = options.browserTabRef ?? resolveSessionTabRef(meta);
  const recoverIfMissing = options.recoverIfMissing !== false && !options.browserTabRef;
  const log = (line: string) => console.log(line);

  let releaseRecoveredChrome: ((close?: boolean) => Promise<void>) | null = null;
  // Reading the session's tab uses its Chrome like a run does: hold a slot on the profile.
  let slot = options.browserTabRef ? null : await takeHarvestSlot(meta, log);
  let saved = false;
  try {
    let harvested: ChatGptTabSummary;
    try {
      harvested = await harvestSessionPrompt(
        meta,
        {
          ...initialEndpoint,
          ref,
          stallWindowMs: options.stallWindowMs,
        },
        !options.browserTabRef,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRecoverableMissingTabError(message) || !recoverIfMissing) {
        throw error;
      }
      console.log(
        chalk.yellow(
          `No live ChatGPT tab matched session "${sessionId}". Attempting recovery by reopening the saved conversation URL.`,
        ),
      );
      // Recovery reuses this command's slot (a second one on the same profile could wait for this
      // one) and gives it back with the recovery, so it is no longer released here.
      const heldSlot = slot;
      slot = null;
      const recovered = await recoverConversationTab(meta, (line) => console.log(line), {
        existingEndpoint: recordedEndpoint ?? undefined,
        ...(heldSlot ? { heldLease: heldSlot.lease } : {}),
      });
      releaseRecoveredChrome = recovered.release;
      harvested = await harvestSessionPrompt(meta, {
        host: recovered.host,
        port: recovered.port,
        browserWSEndpoint: recovered.browserWSEndpoint,
        approvalWaitMs: recovered.approvalWaitMs,
        ref: recovered.ref,
        stallWindowMs: options.stallWindowMs,
      });
    }

    const integrity = await persistBrowserHarvest(
      sessionId,
      harvested,
      Boolean(options.browserTabRef),
    );
    printHarvestSummary(sessionId, harvested, integrity);
    const output = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
    if (options.writeOutputPath) {
      await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
    }
    if (!options.quietOutput && output) {
      process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
    }
    await completeOwnedBrowserHarvest(sessionId, harvested, integrity, log);
    saved = true;
    return harvested;
  } finally {
    // A relaunched Chrome follows closeAfterRecover; the session's own Chrome is released only
    // after its answer was saved, and only like its run's end would (harvestChromeRelease.ts).
    await releaseHarvestSlot(slot, sessionId, saved && !releaseRecoveredChrome, log).catch(
      () => false,
    );
    await releaseRecoveredChrome?.(options.closeAfterRecover).catch(() => undefined);
  }
}

export async function liveTailSessionBrowserOutput(
  sessionId: string,
  options: BrowserLiveTailOptions = {},
): Promise<ChatGptTabSummary> {
  const meta = await sessionStore.readSession(sessionId);
  if (!meta) {
    throw new Error(`No session found with ID ${sessionId}.`);
  }
  const recordedEndpoint = await sessionBrowserEndpoint(meta);
  let endpoint = recordedEndpoint ?? {
    host: DEFAULT_REMOTE_CHROME_HOST,
    port: DEFAULT_REMOTE_CHROME_PORT,
  };
  let browserTabRef = options.browserTabRef ?? resolveSessionTabRef(meta);
  const recoverIfMissing = options.recoverIfMissing !== false && !options.browserTabRef;
  let releaseRecoveredChrome: ((close?: boolean) => Promise<void>) | null = null;
  const stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
  const identity = sessionTurnIdentity(meta, !options.browserTabRef);
  // The live tail waits for this session's answer as long as the run itself would have.
  const waitMs = options.waitMs ?? resolveBrowserConfig(meta.browser?.config).timeoutMs;
  const waitUntil = Date.now() + waitMs;
  let lastHash: string | null = null;
  let lastTurnState: SessionTurnState | null = null;
  let requireRecoveredContent = false;
  let recoveredContentDeadlineMs = 0;
  const log = (line: string) => console.log(line);
  // Tailing the session's tab uses its Chrome like a run does: hold a slot on the profile.
  let slot = options.browserTabRef ? null : await takeHarvestSlot(meta, log);
  let saved = false;

  try {
    // Probe once to see if the live tab is still alive; recover if not.
    try {
      await harvestChatGptTab({
        ...endpoint,
        ref: browserTabRef,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isRecoverableMissingTabError(message) || !recoverIfMissing) {
        throw error;
      }
      console.log(
        chalk.yellow(
          `No live ChatGPT tab matched session "${sessionId}". Attempting recovery by reopening the saved conversation URL.`,
        ),
      );
      // Recovery reuses this command's slot (a second one on the same profile could wait for this
      // one) and gives it back with the recovery, so it is no longer released here.
      const heldSlot = slot;
      slot = null;
      const recovered = await recoverConversationTab(meta, (line) => console.log(line), {
        existingEndpoint: recordedEndpoint ?? undefined,
        waitForReady: false,
        ...(heldSlot ? { heldLease: heldSlot.lease } : {}),
      });
      releaseRecoveredChrome = recovered.release;
      endpoint = {
        host: recovered.host,
        port: recovered.port,
        browserWSEndpoint: recovered.browserWSEndpoint,
        approvalWaitMs: recovered.approvalWaitMs,
      };
      browserTabRef = recovered.ref;
      requireRecoveredContent = true;
      recoveredContentDeadlineMs = Date.now() + stallThresholdMs;
    }

    while (true) {
      const harvested = await harvestChatGptTab({
        ...endpoint,
        ref: browserTabRef,
        confirmTurnComplete: { timeoutMs: TURN_COMPLETE_PROOF_MS },
      });
      const fullText = harvested.lastAssistantMarkdown ?? harvested.lastAssistantText ?? "";
      if (requireRecoveredContent && !isRecoveredConversationHarvestReady(harvested)) {
        if (Date.now() < recoveredContentDeadlineMs) {
          await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
          continue;
        }
        throw new Error("Recovered ChatGPT conversation did not become ready in time.");
      }
      requireRecoveredContent = false;
      // Only an answer after this session's own user turn counts; the page's last assistant
      // message can be an earlier turn's while this one is still being generated.
      const turnState = sessionTurnState(harvested, identity, true);
      // While this turn is generating, the text is its own only once its answer follows it.
      const ownText =
        turnState === "answer" ||
        (turnState === "generating" && harvested.assistantFollowsLatestUser === true)
          ? fullText
          : "";
      const hash = createHash("sha1").update(`${turnState}|${ownText}`).digest("hex");
      if (hash !== lastHash) {
        lastHash = hash;
        const statusLine =
          `[${new Date().toISOString()}] state=${harvested.state} stop=${harvested.stopExists ? "yes" : "no"} ` +
          `send=${harvested.sendExists ? "yes" : "no"} model=${harvested.currentModelLabel || "(unknown)"} ` +
          `turn=${turnState}${ownText ? ` snippet=${snippet(harvested.lastAssistantSnippet || ownText, 160)}` : ""}`;
        // Progress is only shown; the session saves nothing until its answer is finished.
        console.log(statusLine);
      }
      if (turnState !== lastTurnState) {
        if (turnState !== "answer") {
          console.log(chalk.dim(`${describeSessionTurn(turnState)}; waiting.`));
        }
        lastTurnState = turnState;
      }

      if (turnState !== "answer" || !harvested.authenticated) {
        if (Date.now() >= waitUntil) {
          throw new Error(
            `${describeSessionTurn(turnState)} after ${Math.round(waitMs / 1000)}s of --live; nothing was saved.`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
        continue;
      }
      const finalHarvest: ChatGptTabSummary = { ...harvested, state: "completed" };
      const integrity = await persistBrowserHarvest(
        sessionId,
        finalHarvest,
        Boolean(options.browserTabRef),
      );
      printHarvestSummary(sessionId, finalHarvest, integrity);
      const output = finalHarvest.lastAssistantMarkdown ?? finalHarvest.lastAssistantText ?? "";
      if (options.writeOutputPath) {
        await maybeWriteHarvestOutput(options.writeOutputPath, meta.cwd ?? process.cwd(), output);
      }
      if (output) {
        process.stdout.write(`${output}${output.endsWith("\n") ? "" : "\n"}`);
      }
      await completeOwnedBrowserHarvest(sessionId, finalHarvest, integrity, log);
      saved = true;
      return finalHarvest;
    }
  } finally {
    await releaseHarvestSlot(slot, sessionId, saved && !releaseRecoveredChrome, log).catch(
      () => false,
    );
    await releaseRecoveredChrome?.(options.closeAfterRecover).catch(() => undefined);
  }
}
