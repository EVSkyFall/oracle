import type { ChromeClient, BrowserLogger, BrowserResearchPlanMetadata } from "../types.js";
import {
  DEEP_RESEARCH_DROPDOWN_ITEM_TEXT,
  DEEP_RESEARCH_POLL_INTERVAL_MS,
  DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
  DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
  FINISHED_ACTIONS_SELECTOR,
  INPUT_SELECTORS,
  STOP_BUTTON_SELECTOR,
} from "../constants.js";
import { buildConversationTurnListExpression } from "../conversationTurns.js";
import { delay } from "../utils.js";
import { isDeepResearchIncompleteText } from "../deepResearchResult.js";
import {
  captureAssistantMarkdown,
  readAssistantSnapshot,
  throwIfAssistantUiError,
} from "./assistantResponse.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { captureComposerNavigationUrl } from "./attachmentContext.js";
import {
  type ComposerPanelRow,
  clickComposerPanelRow,
  closeComposerPlusPanel,
  composerRowTitleEquals,
  openComposerPlusPanel,
} from "./composerTools.js";

const DEEP_RESEARCH_STAGE = "deep-research-activate";
const DEEP_RESEARCH_ROW_TITLES = [DEEP_RESEARCH_DROPDOWN_ITEM_TEXT, "深度研究"];
const DEEP_RESEARCH_ROW_DESCRIPTIONS = ["Get a detailed report", "获取详细报告"];

/**
 * Deep Research is an app mention inside the editor. Only this element proves it is active:
 * suggestion chips and other composer buttons can carry the same "Deep research" text.
 */
export const DEEP_RESEARCH_MENTION_SELECTOR = [
  '[app-mention-name="deep-research"]',
  '[app-mention-path="app://connector_openai_deep_research"]',
  '[data-prompt-link-href="app://connector_openai_deep_research"]',
  '[data-prompt-link-label="$deep-research"]',
].join(", ");

export function buildDeepResearchMentionExpression(): string {
  return `(() => {
    const visible = node => Boolean(node) && typeof node.getBoundingClientRect === 'function' &&
      node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const editors = ${JSON.stringify(INPUT_SELECTORS)}.flatMap(selector => Array.from(document.querySelectorAll(selector))).filter(visible);
    return editors.some(editor => Boolean(editor.querySelector(${JSON.stringify(DEEP_RESEARCH_MENTION_SELECTOR)})));
  })()`;
}

export async function hasDeepResearchMention(Runtime: ChromeClient["Runtime"]): Promise<boolean> {
  const { result } = await Runtime.evaluate({
    expression: buildDeepResearchMentionExpression(),
    returnByValue: true,
  });
  return result?.value === true;
}

/** The "+" panel row for Deep Research: its app id, its title, or the legacy combined label. */
export function findDeepResearchPanelRow(rows: readonly ComposerPanelRow[]): number {
  const byApp = rows.findIndex((row) => /deep[_-]?research/i.test(row.impression ?? ""));
  if (byApp >= 0) return byApp;
  const byTitle = rows.findIndex((row) => composerRowTitleEquals(row, DEEP_RESEARCH_ROW_TITLES));
  if (byTitle >= 0) return byTitle;
  const compact = (value: string) => value.replace(/\s+/g, "").toLowerCase();
  return rows.findIndex(
    (row) =>
      DEEP_RESEARCH_ROW_TITLES.some((title) => compact(row.text).startsWith(compact(title))) &&
      DEEP_RESEARCH_ROW_DESCRIPTIONS.some((label) => compact(row.text).includes(compact(label))),
  );
}

/**
 * Activates Deep Research through the composer "+" panel and verifies its mention in the
 * editor before prompt submission.
 */
export async function activateDeepResearch(
  Runtime: ChromeClient["Runtime"],
  Input: ChromeClient["Input"],
  logger: BrowserLogger,
): Promise<void> {
  if (await hasDeepResearchMention(Runtime)) {
    logger("Deep Research mode already active (Deep research mention in the composer)");
    return;
  }
  const navigationUrl = await captureComposerNavigationUrl(Runtime);
  const opened = await openComposerPlusPanel(Runtime, Input, {
    navigationUrl,
    stage: DEEP_RESEARCH_STAGE,
  });
  if (opened.status === "unavailable" || opened.status === "not-needed") {
    throw new BrowserAutomationError(
      `Could not open the composer plus button menu to activate Deep Research (${opened.reason ?? "not available"}).`,
      { stage: DEEP_RESEARCH_STAGE, code: "plus-button-missing" },
    );
  }
  try {
    const choice = await clickComposerPanelRow(Runtime, Input, {
      pick: findDeepResearchPanelRow,
      navigationUrl,
      stage: DEEP_RESEARCH_STAGE,
      target: "The Deep research row",
    });
    if (choice.status !== "clicked") {
      const available = choice.rows.map((row) => row.title || row.text).filter(Boolean);
      const hint = available.length ? ` Available options: ${available.join(", ")}` : "";
      throw new BrowserAutomationError(
        `"Deep research" option not found in composer dropdown.${hint} ` +
          "This feature may require a ChatGPT Plus or Pro subscription.",
        { stage: DEEP_RESEARCH_STAGE, code: "dropdown-item-missing", available },
      );
    }
    // About five seconds of 200 ms polls for the mention to render.
    for (let poll = 0; poll < 25; poll += 1) {
      if (await hasDeepResearchMention(Runtime)) {
        logger("Deep Research mode activated");
        return;
      }
      await delay(200);
    }
  } finally {
    await closeComposerPlusPanel(Runtime, Input).catch(() => false);
  }
  throw new BrowserAutomationError(
    "Deep Research mention did not appear in the composer after selection. The UI may have changed.",
    { stage: DEEP_RESEARCH_STAGE, code: "pill-not-confirmed" },
  );
}

/**
 * After prompt submission, waits for the research plan to appear and
 * auto-confirm (~60s countdown + 10s safety margin).
 */
export async function waitForResearchPlanAutoConfirm(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  autoConfirmWaitMs: number = DEEP_RESEARCH_AUTO_CONFIRM_WAIT_MS,
  options?: {
    Page?: ChromeClient["Page"];
    client?: ChromeClient;
    ignoredTargetKeys?: readonly string[];
    targetBaselineCaptured?: boolean;
    minTurnIndex?: number | null;
    onPlan?: (plan: BrowserResearchPlanMetadata) => void | Promise<void>;
  },
): Promise<BrowserResearchPlanMetadata | null> {
  const ignoredTargetKeys = new Set(options?.ignoredTargetKeys ?? []);
  const minTurnIndex =
    typeof options?.minTurnIndex === "number" && Number.isFinite(options.minTurnIndex)
      ? Math.floor(options.minTurnIndex)
      : -1;
  let capturedPlan: BrowserResearchPlanMetadata | null = null;
  let loggedPlan = false;
  const targetOwnerMinTurnIndex =
    minTurnIndex >= 0 && options?.targetBaselineCaptured !== true ? minTurnIndex : -1;

  const readPlanStatus = async (): Promise<DeepResearchFrameStatus | null> => {
    const targetRead = options?.client
      ? ((
          await readDeepResearchTargetResult(
            options.client,
            ignoredTargetKeys,
            targetOwnerMinTurnIndex,
          ).catch(() => null)
        )?.read ?? null)
      : null;
    if (targetRead?.planTitle || targetRead?.researchStarted) {
      return targetRead;
    }
    const inPageRead = options?.Page
      ? await readDeepResearchFrameResult(
          Runtime,
          options.Page,
          options.client,
          minTurnIndex,
        ).catch(() => null)
      : null;
    return inPageRead?.read ?? targetRead;
  };

  const capturePlan = async (
    status: DeepResearchFrameStatus,
  ): Promise<BrowserResearchPlanMetadata | null> => {
    if (!status.planTitle || !status.planSteps || status.planSteps.length === 0) {
      return capturedPlan;
    }
    const next: BrowserResearchPlanMetadata = {
      title: status.planTitle,
      steps: status.planSteps,
      phase: status.researchStarted ? "researching" : "planning",
      ...(status.planActionText ? { actionText: status.planActionText } : {}),
      capturedAt: capturedPlan?.capturedAt ?? new Date().toISOString(),
    };
    const changed =
      !capturedPlan ||
      capturedPlan.phase !== next.phase ||
      capturedPlan.title !== next.title ||
      capturedPlan.steps.join("\n") !== next.steps.join("\n") ||
      capturedPlan.actionText !== next.actionText;
    capturedPlan = next;
    if (!loggedPlan) {
      logger(
        `[browser] Deep Research plan detected:\n${[next.title, ...next.steps.map((step, index) => `${index + 1}. ${step}`)].join("\n")}`,
      );
      loggedPlan = true;
    }
    if (changed) {
      await options?.onPlan?.(next);
    }
    return next;
  };

  const reportResearchStarted = async (): Promise<BrowserResearchPlanMetadata | null> => {
    if (capturedPlan?.phase === "planning") {
      capturedPlan = { ...capturedPlan, phase: "researching" };
      await options?.onPlan?.(capturedPlan);
    }
    logger("[browser] Deep Research execution started; plan countdown is complete.");
    return capturedPlan;
  };

  // Phase A: Detect research plan appearance (up to 60s)
  const planDeadline = Date.now() + 60_000;
  let planDetected = false;

  while (Date.now() < planDeadline) {
    const frameStatus = await readPlanStatus();
    if (frameStatus) {
      await capturePlan(frameStatus);
      if (frameStatus.researchStarted) {
        return reportResearchStarted();
      }
      if (capturedPlan) {
        planDetected = true;
        break;
      }
    }

    // Legacy/inline fallback. Do not treat an arbitrary large iframe as a plan:
    // ChatGPT projects, attachments, and other tools also render large iframes.
    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const turns = Array.from(document.querySelectorAll(':is([data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"])'));
        const assistantText = String(turns.at(-1)?.textContent || '').toLowerCase();
        const hasResearchText = assistantText.includes('researching') ||
          assistantText.includes('research plan') ||
          assistantText.includes('正在研究') ||
          assistantText.includes('研究计划');
        return { hasResearchText };
      })()`,
      returnByValue: true,
    });

    const val = result?.value as { hasResearchText?: boolean } | undefined;
    if (val?.hasResearchText) {
      planDetected = true;
      logger("[browser] Deep Research activity detected; waiting for plan auto-confirm...");
      break;
    }
    await delay(2_000);
  }

  if (!planDetected) {
    logger(
      "Warning: Research plan not detected within 60s; continuing (may have auto-confirmed already)",
    );
    return capturedPlan;
  }

  // Phase B: Wait for the OOPIF's real execution state instead of sleeping for
  // the full countdown. The main page cannot see this sandboxed iframe's text.
  const confirmStart = Date.now();
  while (Date.now() - confirmStart < autoConfirmWaitMs) {
    const frameStatus = await readPlanStatus();
    if (frameStatus) {
      await capturePlan(frameStatus);
      if (frameStatus.researchStarted) {
        return reportResearchStarted();
      }
    }

    const { result } = await Runtime.evaluate({
      expression: `(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        const isResearching = text.includes('researching...') ||
          text.includes('reading sources') ||
          text.includes('正在研究') ||
          text.includes('正在阅读来源');
        return { isResearching };
      })()`,
      returnByValue: true,
    });
    const val = result?.value as { isResearching?: boolean } | undefined;

    if (val?.isResearching) {
      return reportResearchStarted();
    }

    await delay(2_000);
  }

  logger("[browser] Deep Research plan wait elapsed; proceeding to monitor research progress.");
  return capturedPlan;
}

/**
 * Polls for Deep Research completion over 5-30+ minutes.
 * Returns the full response text, optional HTML, and turn metadata.
 */
export async function waitForDeepResearchCompletion(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  timeoutMs: number = DEEP_RESEARCH_DEFAULT_TIMEOUT_MS,
  minTurnIndex?: number | null,
  Page?: ChromeClient["Page"],
  client?: ChromeClient,
  options?: {
    ignoredTargetKeys?: readonly string[];
    requireScopedTargetOwner?: boolean;
    targetBaselineCaptured?: boolean;
  },
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const start = Date.now();
  let lastLogTime = start;
  let lastTextLength = 0;
  const minTurnLiteral =
    typeof minTurnIndex === "number" && Number.isFinite(minTurnIndex) && minTurnIndex >= 0
      ? Math.floor(minTurnIndex)
      : -1;
  const scopedToNewTurns = minTurnLiteral >= 0;
  const ignoredTargetKeys = new Set(options?.ignoredTargetKeys ?? []);
  const requireScopedTargetOwner =
    options?.requireScopedTargetOwner === true ||
    (scopedToNewTurns && options?.targetBaselineCaptured !== true);
  let observedResearchEvidence = false;
  let loggedIncompleteResult = false;

  logger(`Monitoring Deep Research (timeout: ${Math.round(timeoutMs / 60_000)}min)...`);

  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: buildDeepResearchCompletionPollExpression(minTurnLiteral),
      returnByValue: true,
    });

    const val = result?.value as
      | {
          finished?: boolean;
          stopVisible?: boolean;
          textLength?: number;
          hasIframe?: boolean;
          hasActiveScopedResearch?: boolean;
          incompleteResult?: boolean;
          researchActivity?: boolean;
          accountBlocked?: boolean;
        }
      | undefined;

    if (val?.accountBlocked) {
      throw new BrowserAutomationError(
        "ChatGPT account security block detected during Deep Research. Open chatgpt.com in Chrome, secure the account, then rerun Oracle.",
        { stage: "chatgpt-account-blocked", code: "chatgpt-account-blocked" },
      );
    }
    // ChatGPT renders the Deep Research report inside an out-of-process,
    // sandboxed iframe (connector_openai_deep_research.*.oaiusercontent.com),
    // doubly nested and same-origin. That OOPIF does NOT appear in the main
    // page's frame tree, so the in-page isolated-world path
    // (readDeepResearchFrameResult) can never see it. The target-attach path
    // (readDeepResearchTargetResult) attaches to the iframe's own CDP target and
    // walks its nested frames, so it CAN read the report. Prefer the target path
    // and fall back to the in-page frame path for legacy/inline rendering.
    const rawTargetResult = client
      ? ((
          await readDeepResearchTargetResult(
            client,
            ignoredTargetKeys,
            requireScopedTargetOwner ? minTurnLiteral : -1,
            {
              // Reattach sets the owner flag even when the turn index could not
              // be read. -1 would skip the owner filter and accept any finished
              // iframe, including a report from another run.
              rejectCompletedWhenOwnerUnknown: requireScopedTargetOwner && minTurnLiteral < 0,
            },
          ).catch(() => null)
        )?.read ?? null)
      : null;
    const targetResult = filterIncompleteDeepResearchRead(rawTargetResult);
    // A completed target read is authoritative. If the target read is missing or
    // only in-progress, still try the in-page frame path so an incomplete target
    // read does not suppress a completed report there (legacy/inline rendering).
    const inPageScan =
      !targetResult?.completed && Page
        ? await readDeepResearchFrameResult(
            Runtime,
            Page,
            client,
            scopedToNewTurns ? minTurnLiteral : -1,
          ).catch(() => null)
        : null;
    const rawInPageResult = inPageScan?.read ?? null;
    const inPageResult = filterIncompleteDeepResearchRead(rawInPageResult);
    const read = pickPreferredDeepResearchRead(targetResult, inPageResult);
    // Target keys captured before submission are ignored, so a target result is
    // tied to this run. Main-page iframes are not: old reports can remain in the
    // conversation and must never authorize a new normal-response fallback.
    observedResearchEvidence ||= Boolean(
      rawTargetResult ||
      (scopedToNewTurns && rawInPageResult) ||
      val?.researchActivity ||
      val?.hasActiveScopedResearch,
    );
    if (read?.completed && read.text) {
      logger(`Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      return {
        text: read.text,
        html: read.html,
        meta: { turnId: null, messageId: null },
      };
    }

    // Completion detected
    if (val?.finished) {
      if (!observedResearchEvidence) {
        throw new BrowserAutomationError(
          "ChatGPT returned a completed response without starting Deep Research. The Deep Research selection may have silently fallen back to a normal response.",
          { stage: "deep-research-not-started", code: "deep-research-not-started" },
        );
      }
      logger(`Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
      return await extractDeepResearchResult(Runtime, logger, minTurnIndex ?? undefined);
    }

    const incompleteFrameResult = Boolean(
      (rawTargetResult?.completed && !targetResult?.completed) ||
      (rawInPageResult?.completed && !inPageResult?.completed),
    );
    if ((val?.incompleteResult || incompleteFrameResult) && !loggedIncompleteResult) {
      logger("Deep Research interim status detected; waiting for the final report");
      loggedIncompleteResult = true;
    }

    // Progress logging every 60 seconds
    const now = Date.now();
    if (now - lastLogTime >= 60_000) {
      const elapsed = Math.round((now - start) / 1000);
      const chars = Math.max(val?.textLength ?? 0, read?.textLength ?? 0);
      const phase =
        read?.inProgress || val?.hasIframe
          ? "researching"
          : val?.stopVisible
            ? "generating"
            : "waiting";
      logger(`Deep Research ${phase}... ${elapsed}s elapsed, ~${chars} chars`);
      lastLogTime = now;
    }

    lastTextLength = Math.max(val?.textLength ?? 0, read?.textLength ?? 0, lastTextLength);
    await delay(DEEP_RESEARCH_POLL_INTERVAL_MS);
  }

  // Timeout — throw with metadata for potential reattach
  const elapsed = Math.round((Date.now() - start) / 1000);
  throw new BrowserAutomationError(
    `Deep Research did not complete within ${Math.round(timeoutMs / 60_000)} minutes (${elapsed}s elapsed). ` +
      "Use 'oracle session <id>' to reattach later, or increase --timeout.",
    {
      stage: "deep-research-timeout",
      code: "deep-research-timeout",
      elapsedMs: Date.now() - start,
      lastTextLength,
    },
  );
}

/**
 * Extracts the Deep Research result using existing assistant response
 * extraction logic (readAssistantSnapshot + captureAssistantMarkdown).
 */
export async function extractDeepResearchResult(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  minTurnIndex?: number,
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const snapshot = await readAssistantSnapshot(Runtime, minTurnIndex);
  throwIfAssistantUiError(snapshot);
  const meta = {
    turnId: snapshot?.turnId ?? null,
    messageId: snapshot?.messageId ?? null,
  };

  // Try the copy-button approach first for clean markdown
  const markdown = await captureAssistantMarkdown(Runtime, meta, logger);
  if (markdown && !isDeepResearchIncompleteText(markdown)) {
    return { text: markdown, html: snapshot?.html ?? undefined, meta };
  }

  // Fall back to snapshot text
  if (snapshot?.text && !isDeepResearchIncompleteText(snapshot.text)) {
    return { text: snapshot.text, html: snapshot.html ?? undefined, meta };
  }

  throw new BrowserAutomationError(
    "Deep Research completed but failed to extract the response text.",
    { stage: "deep-research-extract", code: "extraction-failed" },
  );
}

export function isDeepResearchPlaceholderTextForTest(text: string): boolean {
  return isDeepResearchIncompleteText(text);
}

interface DeepResearchFrameTree {
  frame?: { id?: string; url?: string; name?: string };
  childFrames?: DeepResearchFrameTree[];
}

interface DeepResearchFrameStatus {
  completed: boolean;
  inProgress: boolean;
  researchStarted?: boolean;
  planTitle?: string;
  planSteps?: string[];
  planActionText?: string;
  textLength: number;
  text?: string;
  html?: string;
}

interface DeepResearchTargetScanResult {
  read: DeepResearchFrameStatus | null;
  targetKeys: string[];
}

interface DeepResearchTargetSessionResult {
  confirmed: boolean;
  read: DeepResearchFrameStatus | null;
  frameId?: string;
}

interface DeepResearchFrameReadResult {
  read: DeepResearchFrameStatus;
  ownerTurnIndex: number | null;
}

function filterIncompleteDeepResearchRead(
  result: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  if (!result?.completed || !result.text || !isDeepResearchIncompleteText(result.text)) {
    return result;
  }
  return { ...result, completed: false, inProgress: true };
}

export function filterIncompleteDeepResearchReadForTest(
  result: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  return filterIncompleteDeepResearchRead(result);
}

/**
 * Choose the authoritative Deep Research read between the target-attach result
 * and the in-page frame result. A completed read wins (target preferred, since
 * it reads the live OOPIF directly); otherwise the best in-progress/text-bearing
 * read is kept so progress logging still advances. This preserves the legacy
 * Page-first inline behaviour: when the target read is missing or incomplete,
 * a completed in-page result is still returned.
 */
function pickPreferredDeepResearchRead(
  targetResult: DeepResearchFrameStatus | null,
  inPageResult: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  if (targetResult?.completed) {
    return targetResult;
  }
  if (inPageResult?.completed) {
    return inPageResult;
  }
  return targetResult ?? inPageResult;
}

export function pickPreferredDeepResearchReadForTest(
  targetResult: DeepResearchFrameStatus | null,
  inPageResult: DeepResearchFrameStatus | null,
): DeepResearchFrameStatus | null {
  return pickPreferredDeepResearchRead(targetResult, inPageResult);
}

async function readDeepResearchFrameResult(
  Runtime: ChromeClient["Runtime"],
  Page: ChromeClient["Page"],
  client?: ChromeClient,
  minTurnIndex = -1,
): Promise<DeepResearchFrameReadResult | null> {
  const pageWithFrames = Page as ChromeClient["Page"] & {
    getFrameTree?: () => Promise<{ frameTree?: DeepResearchFrameTree }>;
    createIsolatedWorld?: (params: {
      frameId: string;
      worldName?: string;
      grantUniveralAccess?: boolean;
    }) => Promise<{ executionContextId?: number }>;
  };
  if (
    typeof pageWithFrames.getFrameTree !== "function" ||
    typeof pageWithFrames.createIsolatedWorld !== "function"
  ) {
    return null;
  }
  const frameTree = (await pageWithFrames.getFrameTree())?.frameTree;
  const frameIds = collectPageDeepResearchFrameIds(frameTree);
  if (frameIds.length === 0) {
    return null;
  }
  const rawClient = client as
    | (ChromeClient & {
        send?: (
          method: string,
          params?: Record<string, unknown>,
          sessionId?: string,
        ) => Promise<unknown>;
        oraclePageSessionId?: string;
      })
    | undefined;
  if (minTurnIndex >= 0) {
    if (typeof rawClient?.send !== "function") {
      return null;
    }
  }
  let best: DeepResearchFrameReadResult | null = null;
  for (const frameId of frameIds) {
    let ownerTurnIndex: number | null = null;
    if (minTurnIndex >= 0 && rawClient?.send) {
      ownerTurnIndex = await readDeepResearchTargetOwnerTurnIndex(
        rawClient as ChromeClient & { send: NonNullable<typeof rawClient.send> },
        frameId,
        rawClient.oraclePageSessionId,
      );
      if (ownerTurnIndex === null || ownerTurnIndex < minTurnIndex) {
        continue;
      }
    }
    const world = await pageWithFrames.createIsolatedWorld({
      frameId,
      worldName: "oracle-deep-research",
      grantUniveralAccess: true,
    });
    if (typeof world.executionContextId !== "number") {
      continue;
    }
    const { result } = await Runtime.evaluate({
      expression: buildDeepResearchFrameStatusExpression(),
      contextId: world.executionContextId,
      returnByValue: true,
    });
    const read = (result?.value as DeepResearchFrameStatus | undefined) ?? null;
    if (!read) {
      continue;
    }
    best = { read, ownerTurnIndex };
    if (read.completed) {
      return best;
    }
  }
  return best;
}

async function readDeepResearchTargetResult(
  client: ChromeClient,
  ignoredTargetKeys: ReadonlySet<string> = new Set(),
  minTurnIndex = -1,
  options?: {
    rejectCompletedWhenOwnerUnknown?: boolean;
  },
): Promise<DeepResearchTargetScanResult | null> {
  const rawClient = client as ChromeClient & {
    send?: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
    oraclePageSessionId?: string;
  };
  if (typeof rawClient.send !== "function") {
    return null;
  }
  if (typeof client.on !== "function") {
    return null;
  }

  // On the browser-WSEndpoint path, `client` is a session-bound wrapper whose
  // domain methods target the page session but whose raw `send` is the
  // browser-level send. We must therefore pass the page session id explicitly so
  // Target.setAutoAttach binds to THIS page (not the whole browser). For a direct
  // tab client this is undefined and `send` already defaults to the page session.
  const pageSessionId = rawClient.oraclePageSessionId;

  const sessions = new Map<string, { targetId?: string; url: string }>();
  const ownedSessionIds = new Set<string>();
  const onAttached = (params: unknown, parentSessionId?: string) => {
    // chrome-remote-interface emits flattened target events both on the
    // session-specific event name and on the shared base event. The second
    // callback argument identifies the parent page session; ignore events from
    // other tabs when this client wraps a shared browser WebSocket.
    if (pageSessionId && parentSessionId !== pageSessionId) {
      return;
    }
    const targetInfo = (
      params as { targetInfo?: { targetId?: string; url?: string; type?: string } } | undefined
    )?.targetInfo;
    const eventSessionId =
      (params as { sessionId?: string } | undefined)?.sessionId ?? parentSessionId;
    const url = targetInfo?.url ?? "";
    const type = targetInfo?.type ?? "";
    if (eventSessionId && isDeepResearchTarget(url, type)) {
      sessions.set(eventSessionId, { targetId: targetInfo?.targetId, url });
      ownedSessionIds.add(eventSessionId);
    }
  };

  client.on("Target.attachedToTarget", onAttached as never);
  try {
    // Scope discovery to the current Oracle-controlled page. `client` is
    // connected to the conversation page target, so enabling auto-attach on this
    // session only attaches THIS page's related targets (its Deep Research OOPIF
    // subframe) and emits Target.attachedToTarget for them.
    //
    // We deliberately do NOT enumerate Target.getTargets / attachToTarget here:
    // that scan is browser-wide, and in a shared/persistent Chrome profile it
    // would surface another tab's completed Deep Research report and let it be
    // saved into the current session (cross-tab leak). Only auto-attached,
    // page-scoped sessions are treated as belonging to this run.
    const autoAttachEnabled = await rawClient
      .send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
        pageSessionId,
      )
      .then(
        () => true,
        () => false,
      );
    if (!autoAttachEnabled) {
      return null;
    }
    await delay(100);

    if (minTurnIndex >= 0) {
      await rawClient.send("DOM.enable", {}, pageSessionId).catch(() => undefined);
      await rawClient.send("Runtime.enable", {}, pageSessionId).catch(() => undefined);
    }

    // Baseline targets and owner turns before the submitted prompt are removed
    // first. Among remaining targets, a completed report is authoritative;
    // otherwise retain the newest meaningful progress read for status logging.
    let completed: DeepResearchFrameStatus | null = null;
    let latestProgress: DeepResearchFrameStatus | null = null;
    const targetKeys: string[] = [];
    for (const [sessionId, target] of sessions) {
      const sessionResult = await readDeepResearchTargetSession(rawClient, sessionId, target.url);
      if (!sessionResult.confirmed) {
        continue;
      }
      if (target.targetId) {
        targetKeys.push(target.targetId);
      }
      if (target.targetId && ignoredTargetKeys.has(target.targetId)) {
        continue;
      }
      if (minTurnIndex >= 0) {
        const ownerTurnIndex = sessionResult.frameId
          ? await readDeepResearchTargetOwnerTurnIndex(
              rawClient,
              sessionResult.frameId,
              pageSessionId,
            )
          : null;
        if (ownerTurnIndex === null || ownerTurnIndex < minTurnIndex) {
          continue;
        }
      }
      const value = sessionResult.read;
      if (
        options?.rejectCompletedWhenOwnerUnknown === true &&
        minTurnIndex < 0 &&
        value?.completed
      ) {
        continue;
      }
      if (value?.completed) {
        completed = value;
      } else if (value && (value.inProgress || value.textLength > 0)) {
        latestProgress = value;
      }
    }
    return {
      read: completed ?? latestProgress,
      targetKeys,
    };
  } finally {
    await rawClient
      .send(
        "Target.setAutoAttach",
        {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        },
        pageSessionId,
      )
      .catch(() => undefined);
    await Promise.all(
      Array.from(ownedSessionIds, (sessionId) =>
        rawClient.send("Target.detachFromTarget", { sessionId }).catch(() => undefined),
      ),
    );
    (
      client as ChromeClient & { removeListener?: (event: string, listener: unknown) => void }
    ).removeListener?.("Target.attachedToTarget", onAttached);
  }
}

export async function captureDeepResearchTargetKeys(client: ChromeClient): Promise<string[]> {
  const scan = await readDeepResearchTargetResult(client);
  if (!scan) {
    throw new Error("Deep Research target baseline capture unavailable");
  }
  return scan.targetKeys;
}

async function readDeepResearchTargetOwnerTurnIndex(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  frameId: string,
  pageSessionId?: string,
): Promise<number | null> {
  const owner = (await rawClient
    .send("DOM.getFrameOwner", { frameId }, pageSessionId)
    .catch(() => null)) as { backendNodeId?: number } | null;
  if (typeof owner?.backendNodeId !== "number") {
    return null;
  }
  const resolved = (await rawClient
    .send("DOM.resolveNode", { backendNodeId: owner.backendNodeId }, pageSessionId)
    .catch(() => null)) as { object?: { objectId?: string } } | null;
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    return null;
  }
  try {
    const response = (await rawClient
      .send(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
            const turns = ${buildConversationTurnListExpression()};
            const index = turns.findIndex((turn) => turn === this || turn.contains?.(this));
            return index >= 0 ? index : null;
          }`,
          returnByValue: true,
        },
        pageSessionId,
      )
      .catch(() => null)) as { result?: { value?: unknown } } | null;
    const value = response?.result?.value;
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : null;
  } finally {
    await rawClient
      .send("Runtime.releaseObject", { objectId }, pageSessionId)
      .catch(() => undefined);
  }
}

async function readDeepResearchTargetSession(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  sessionId: string,
  targetUrl: string,
): Promise<DeepResearchTargetSessionResult> {
  await rawClient.send("Runtime.enable", {}, sessionId).catch(() => undefined);
  await rawClient.send("Page.enable", {}, sessionId).catch(() => undefined);

  const frameTree = (await rawClient
    .send("Page.getFrameTree", {}, sessionId)
    .catch(() => null)) as { frameTree?: DeepResearchFrameTree } | null;
  const ownerFrameId = frameTree?.frameTree?.frame?.id;
  if (!isConfirmedDeepResearchTarget(targetUrl, frameTree?.frameTree)) {
    return { confirmed: false, read: null };
  }
  const frameIds = collectDeepResearchFrameIds(frameTree?.frameTree);
  let best: DeepResearchFrameStatus | null = null;

  for (const frameId of frameIds) {
    const world = (await rawClient
      .send(
        "Page.createIsolatedWorld",
        {
          frameId,
          worldName: "oracle-deep-research",
          grantUniveralAccess: true,
        },
        sessionId,
      )
      .catch(() => null)) as { executionContextId?: number } | null;
    if (typeof world?.executionContextId !== "number") {
      continue;
    }
    const value = await evaluateDeepResearchFrameStatus(
      rawClient,
      sessionId,
      world.executionContextId,
    );
    if (value?.completed) {
      return { confirmed: true, read: value, frameId: ownerFrameId };
    }
    if ((value?.textLength ?? 0) > (best?.textLength ?? 0) || value?.inProgress) {
      best = value;
    }
  }

  const topFrameValue = await evaluateDeepResearchFrameStatus(rawClient, sessionId);
  if (topFrameValue?.completed) {
    return { confirmed: true, read: topFrameValue, frameId: ownerFrameId };
  }
  if ((topFrameValue?.textLength ?? 0) > (best?.textLength ?? 0) || topFrameValue?.inProgress) {
    best = topFrameValue;
  }

  return { confirmed: true, read: best, frameId: ownerFrameId };
}

async function evaluateDeepResearchFrameStatus(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  sessionId: string,
  contextId?: number,
): Promise<DeepResearchFrameStatus | null> {
  const response = (await rawClient
    .send(
      "Runtime.evaluate",
      {
        expression: buildDeepResearchFrameStatusExpression(),
        returnByValue: true,
        ...(typeof contextId === "number" ? { contextId } : {}),
      },
      sessionId,
    )
    .catch(() => null)) as { result?: { value?: DeepResearchFrameStatus } } | null;
  return response?.result?.value ?? null;
}

function isDeepResearchTarget(url: string, type: string): boolean {
  return type.toLowerCase() === "iframe" || isDeepResearchFrameDescriptor(url);
}

function isConfirmedDeepResearchTarget(
  targetUrl: string,
  tree: DeepResearchFrameTree | undefined,
): boolean {
  return isDeepResearchFrameDescriptor(targetUrl) || Boolean(findDeepResearchFrameId(tree));
}

function isDeepResearchFrameDescriptor(url: string, name = ""): boolean {
  const descriptor = `${url}\n${name}`.toLowerCase();
  return (
    descriptor.includes("connector_openai_deep_research") || descriptor.includes("deep-research")
  );
}

function findDeepResearchFrameId(tree: DeepResearchFrameTree | undefined): string | null {
  return collectPageDeepResearchFrameIds(tree)[0] ?? null;
}

function collectPageDeepResearchFrameIds(tree: DeepResearchFrameTree | undefined): string[] {
  if (!tree?.frame) {
    return [];
  }
  const ids: string[] = [];
  if (tree.frame.id && isDeepResearchFrameDescriptor(tree.frame.url ?? "", tree.frame.name ?? "")) {
    ids.push(tree.frame.id);
  }
  for (const child of tree.childFrames ?? []) {
    ids.push(...collectPageDeepResearchFrameIds(child));
  }
  return ids;
}

function collectDeepResearchFrameIds(tree: DeepResearchFrameTree | undefined): string[] {
  if (!tree?.frame) {
    return [];
  }
  const ids: string[] = [];
  const url = tree.frame.url ?? "";
  const name = tree.frame.name ?? "";
  if (
    url.includes("connector_openai_deep_research") ||
    url.includes("deep-research") ||
    name.includes("deep-research") ||
    name === "root"
  ) {
    if (tree.frame.id) {
      ids.push(tree.frame.id);
    }
  }
  for (const child of tree.childFrames ?? []) {
    ids.push(...collectDeepResearchFrameIds(child));
  }
  return ids;
}

function buildDeepResearchFrameStatusExpression(): string {
  return `(() => {
    const rawText = document.body?.innerText || '';
    const html = document.body?.innerHTML || '';
    const cleanText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const sections = typeof document.querySelectorAll === 'function'
      ? Array.from(document.querySelectorAll('section'))
      : [];
    const planSection = sections.find((section) => {
      if (typeof section.querySelector !== 'function' ||
          typeof section.querySelectorAll !== 'function' ||
          !cleanText(section.querySelector('h2')?.textContent) ||
          section.querySelectorAll('ul li').length === 0) {
        return false;
      }
      const buttons = Array.from(section.querySelectorAll('button'));
      const hasPlanAction = buttons.some((button) =>
        /^(edit|update|编辑|更新)$/i.test(cleanText(button.textContent))
      );
      const hasResearchStatus = Boolean(section.querySelector('p.loading-shimmer')) ||
        buttons.some((button) =>
          /stop research|停止研究/i.test(cleanText(button.getAttribute?.('aria-label')))
        );
      return hasPlanAction || hasResearchStatus;
    });
    const planTitle = cleanText(planSection?.querySelector?.('h2')?.textContent);
    const planSteps = planSection && typeof planSection.querySelectorAll === 'function'
      ? Array.from(planSection.querySelectorAll('ul li'))
          .map((item) => cleanText(item.textContent))
          .filter(Boolean)
      : [];
    const planActionText = planSection && typeof planSection.querySelectorAll === 'function'
      ? Array.from(planSection.querySelectorAll('button'))
          .map((button) => cleanText(button.textContent))
          .find((text) => /^(edit|update|编辑|更新)$/i.test(text)) || ''
      : '';
    const hasResearchShimmer = Boolean(planSection?.querySelector?.('p.loading-shimmer'));
    const hasStopResearchControl = typeof planSection?.querySelectorAll === 'function' &&
      Array.from(planSection.querySelectorAll('button')).some((button) =>
        /stop research|停止研究/i.test(cleanText(button.getAttribute?.('aria-label')))
      );
    const researchStarted = planSteps.length > 0 && (hasResearchShimmer || hasStopResearchControl);
    const isPlaceholder = (line) => /^(called tool|used tool|użyto narzędzia|narzędzie wywołane)$/i.test(line);
    const isCompletionLine = (line) =>
      /^(research completed|badanie ukończone)\\b/i.test(line);
    const isCounterLine = (line) =>
      /^(\\d+\\s+)?(citation|citations|source|sources|search|searches|cytat|cytaty|cytatów|źródło|źródła|wyszukiwanie|wyszukiwania|wyszukiwań)\\b/i.test(line);
    const normalizeReport = (text) => {
      const lines = String(text || '')
        .split(/\\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^\\d+$/.test(line));
      const reportIndex = lines.findIndex((line) => /deep research report/i.test(line));
      const candidates = reportIndex >= 0 ? lines.slice(reportIndex + 1) : lines;
      let started = false;
      const reportLines = candidates.filter((line) => {
        if (!started) {
          if (
            /deep research report/i.test(line) ||
            isCompletionLine(line) ||
            isCounterLine(line) ||
            isPlaceholder(line)
          ) {
            return false;
          }
          started = true;
        }
        return true;
      });
      if (reportLines.length > 1 && reportLines[0] === reportLines[1]) {
        reportLines.shift();
      }
      return reportLines.join('\\n').trim();
    };
    const reportText = normalizeReport(rawText);
    const completed = /research completed|badanie ukończone/i.test(rawText) &&
      reportText.length >= 40 &&
      !isPlaceholder(reportText);
    const inProgress = /researching|badanie|searching|searches|wyszukiwa|citation|cytat|source|źród|reading|completed|ukończone/i.test(rawText);
    return {
      completed,
      inProgress,
      researchStarted,
      planTitle: planTitle || undefined,
      planSteps: planSteps.length > 0 ? planSteps : undefined,
      planActionText: planActionText || undefined,
      textLength: reportText.length || rawText.trim().length,
      text: completed ? reportText : undefined,
      html: completed ? html : undefined,
    };
  })()`;
}

export function findDeepResearchFrameIdForTest(
  tree: DeepResearchFrameTree | undefined,
): string | null {
  return findDeepResearchFrameId(tree);
}

export function isConfirmedDeepResearchTargetForTest(
  targetUrl: string,
  tree: DeepResearchFrameTree | undefined,
): boolean {
  return isConfirmedDeepResearchTarget(targetUrl, tree);
}

export function buildDeepResearchFrameStatusExpressionForTest(): string {
  return buildDeepResearchFrameStatusExpression();
}

/**
 * Quick status check for Deep Research — used during reattach to determine
 * whether research has completed, is still in progress, or is in an unknown state.
 */
export async function checkDeepResearchStatus(
  Runtime: ChromeClient["Runtime"],
  _logger: BrowserLogger,
): Promise<{
  completed: boolean;
  inProgress: boolean;
  hasIframe: boolean;
  textLength: number;
  placeholderOnly: boolean;
}> {
  const { result } = await Runtime.evaluate({
    expression: buildDeepResearchStatusExpression(),
    returnByValue: true,
  });

  const val = result?.value as
    | {
        completed?: boolean;
        inProgress?: boolean;
        hasIframe?: boolean;
        textLength?: number;
        placeholderOnly?: boolean;
      }
    | undefined;

  return {
    completed: val?.completed ?? false,
    inProgress: val?.inProgress ?? false,
    hasIframe: val?.hasIframe ?? false,
    textLength: val?.textLength ?? 0,
    placeholderOnly: val?.placeholderOnly ?? false,
  };
}

// ---------------------------------------------------------------------------
// DOM expression builder
// ---------------------------------------------------------------------------

function buildDeepResearchStatusExpression(): string {
  const finishedSelector = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  const stopSelector = JSON.stringify(STOP_BUTTON_SELECTOR);

  return `(() => {
    const stopVisible = Boolean(document.querySelector(${stopSelector}));
    const iframes = Array.from(document.querySelectorAll('iframe')).filter(f => {
      const rect = f.getBoundingClientRect();
      return rect.width > 200 && rect.height > 200;
    });
    const turns = document.querySelectorAll(':is([data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"])');
    const lastTurn = turns[turns.length - 1];
    const finished = Boolean(lastTurn?.querySelector?.(${finishedSelector}));
    const text = (lastTurn?.textContent || '').trim();
    const normalized = text.toLowerCase().replace(/\\s+/g, ' ').trim();
    const placeholderOnly = /^(called tool|used tool|użyto narzędzia|narzędzie wywołane)$/.test(normalized);
    const textLength = text.length;
    return {
      completed: finished && !placeholderOnly && textLength >= 40,
      inProgress: stopVisible || iframes.length > 0,
      hasIframe: iframes.length > 0,
      textLength,
      placeholderOnly,
    };
  })()`;
}

function buildDeepResearchCompletionPollExpression(minTurnIndex: number): string {
  const finishedSelector = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  const stopSelector = JSON.stringify(STOP_BUTTON_SELECTOR);
  return `(() => {
    const MIN_TURN_INDEX = ${minTurnIndex};
    const stopVisible = Boolean(document.querySelector(${stopSelector}));
    const scopedToNewTurns = MIN_TURN_INDEX >= 0;
    const pageText = String(document.body?.innerText || '').toLowerCase().replace(/\\s+/g, ' ');
    const accountBlocked = pageText.includes('suspicious activity detected') &&
      pageText.includes('secure your account') &&
      pageText.includes('regain access');
    const isAssistantTurn = (node) => {
      const attr = String(node.getAttribute('data-message-author-role') || (node.getAttribute?.('data-content-search-unit-key') || node.getAttribute?.('data-chatgpt-search-unit-key'))?.split(':').at(-1) || node.getAttribute('data-turn') || node.dataset?.turn || '').toLowerCase();
      return attr === 'assistant' ||
        Boolean(node.querySelector(':is([data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]), [data-turn="assistant"]')) ||
        String(node.getAttribute('data-testid') || '').toLowerCase().includes('conversation-turn') &&
          /chatgpt\\s+said/i.test(node.innerText || node.textContent || '');
    };
    const conversationTurns = ${buildConversationTurnListExpression()};
    const allAssistantTurns = Array.from(document.querySelectorAll(':is([data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"], [data-chatgpt-search-unit-key$=":assistant"]), [data-turn="assistant"]'));
    const scopedTurns = scopedToNewTurns
      ? conversationTurns.slice(MIN_TURN_INDEX).filter(isAssistantTurn)
      : allAssistantTurns;
    const lastTurn = scopedTurns[scopedTurns.length - 1] || (scopedToNewTurns ? null : allAssistantTurns[allAssistantTurns.length - 1]);
    const text = (lastTurn?.textContent || '').trim();
    const normalized = text.toLowerCase().replace(/\\s+/g, ' ').trim();
    const textLength = text.length;
    const lines = text.split(/\\n+/).map(line => line.trim()).filter(Boolean);
    const tailIsPlanningPanel = text.length <= 1500 &&
      lines.length >= 4 &&
      lines.length <= 20 &&
      /^update$/i.test(lines[1] || '') &&
      /^stop research$/i.test(lines[lines.length - 1] || '') &&
      /^determining steps for creating a report(?:\\.\\.\\.)?$/i.test(lines[lines.length - 2] || '');
    const isToolStub = normalized === 'called tool' ||
      normalized === 'used tool' ||
      normalized === 'użyto narzędzia' ||
      normalized === 'narzędzie wywołane';
    const incompleteResult = isToolStub ||
      normalized === 'planning' ||
      normalized === 'researching' ||
      normalized === 'searching the web' ||
      (text.trimStart().startsWith('<system-reminder>') &&
        /<system-reminder>[\\s\\S]*#\\s*plan mode\\b/i.test(text)) ||
      tailIsPlanningPanel;
    // Copy, rate, and share controls can render on the first tokens. Stop
    // still means this report is being written.
    const finished = Boolean(lastTurn?.querySelector(${finishedSelector})) &&
      textLength >= 40 &&
      !incompleteResult &&
      !stopVisible;
    const hasIframe = Array.from(document.querySelectorAll('iframe')).some(f => {
      const rect = f.getBoundingClientRect();
      return rect.width > 200 && rect.height > 200;
    });
    const hasScopedDeepResearchIframe = Array.from(lastTurn?.querySelectorAll?.('iframe') || []).some(f => {
      const rect = f.getBoundingClientRect();
      const descriptor = String(f.getAttribute('src') || '') + ' ' + String(f.getAttribute('name') || '');
      return rect.width > 200 && rect.height > 200 &&
        /connector_openai_deep_research|deep-research/i.test(descriptor);
    });
    const hasActiveScopedResearch = scopedToNewTurns && Boolean(lastTurn) &&
      hasScopedDeepResearchIframe &&
      (textLength < 40 || isToolStub || tailIsPlanningPanel || /chatgpt\\s+said:?$/i.test(text));
    return { finished, stopVisible, textLength, hasIframe, isToolStub, incompleteResult, researchActivity: tailIsPlanningPanel || (isToolStub && hasScopedDeepResearchIframe), hasActiveScopedResearch, accountBlocked };
  })()`;
}

export function buildDeepResearchStatusExpressionForTest(): string {
  return buildDeepResearchStatusExpression();
}

export function buildDeepResearchCompletionPollExpressionForTest(minTurnIndex = -1): string {
  return buildDeepResearchCompletionPollExpression(minTurnIndex);
}
