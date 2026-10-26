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
import { RunTimeExpiredError } from "../runClient.js";
import { isDeepResearchIncompleteText } from "../deepResearchResult.js";
import {
  captureTurnMarkdown,
  readAssistantSnapshot,
  throwIfAssistantUiError,
} from "./assistantResponse.js";
import { BrowserAutomationError } from "../../oracle/errors.js";
import { captureComposerNavigationUrl } from "./attachmentContext.js";
import {
  COMPOSER_TOKEN_SELECTOR,
  type ComposerPanelRow,
  clickComposerPanelRow,
  closeComposerPlusPanel,
  composerRowTitleEquals,
  isDeepResearchMention,
  openComposerPlusPanel,
} from "./composerTools.js";

const DEEP_RESEARCH_STAGE = "deep-research-activate";
// Polls (5 s apart) a frame report without a known completion banner must stay unchanged.
const DEEP_RESEARCH_STRUCTURAL_STABLE_POLLS = 3;
const DEEP_RESEARCH_ROW_TITLES = [DEEP_RESEARCH_DROPDOWN_ITEM_TEXT, "深度研究"];
/**
 * Titles of the iframe that hosts the research (today an MCP app frame), lower-case. The app name
 * follows the UI language; besides this list any title with "deep research" wording counts.
 */
const DEEP_RESEARCH_FRAME_TITLES = [
  ...DEEP_RESEARCH_ROW_TITLES,
  "심층 리서치",
  "딥 리서치",
  "심층 연구",
  "ディープリサーチ",
  "詳細なリサーチ",
  "recherche approfondie",
  "investigación profunda",
].map((title) => title.toLowerCase());

/**
 * Page function: whether an iframe hosts Deep Research: its title names it, its URL names the
 * connector, or (untitled only) its host is one already seen hosting it. The URL itself is the
 * generic app runtime that other apps share, so a titled iframe of another app on that host is
 * never taken for the research.
 */
export function isDeepResearchFrameElement(
  frame: Element,
  titles: readonly string[],
  knownHosts: readonly string[],
): boolean {
  const title = String(frame.getAttribute("title") ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (title && (titles.includes(title) || /deep\s*-?\s*research/.test(title))) return true;
  const src = String(frame.getAttribute("src") ?? "");
  const name = String(frame.getAttribute("name") ?? "");
  if (/connector_openai_deep_research|deep-research/i.test(`${src} ${name}`)) return true;
  if (title || knownHosts.length === 0 || !src) return false;
  try {
    return knownHosts.includes(new URL(src, frame.ownerDocument?.location?.href).host);
  } catch {
    return false;
  }
}
const DEEP_RESEARCH_ROW_DESCRIPTIONS = ["Get a detailed report", "获取详细报告"];

/**
 * Deep Research is an app mention inside the editor. Only this element proves it is active:
 * suggestion chips and other composer buttons can carry the same "Deep research" text.
 */
export function buildDeepResearchMentionExpression(): string {
  return `(() => {
    const visible = node => Boolean(node) && typeof node.getBoundingClientRect === 'function' &&
      node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0;
    const editors = ${JSON.stringify(INPUT_SELECTORS)}.flatMap(selector => Array.from(document.querySelectorAll(selector))).filter(visible);
    const isDeepResearch = ${isDeepResearchMention.toString()};
    return editors.some(editor => Array.from(editor.querySelectorAll(${JSON.stringify(COMPOSER_TOKEN_SELECTOR)})).some(isDeepResearch));
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

  try {
    return await waitForPlan();
  } catch (error) {
    if (!(error instanceof RunTimeExpiredError)) throw error;
    logger(
      "[browser] Deep Research plan wait: the page did not answer within the plan wait; proceeding to monitor research progress.",
    );
    return capturedPlan;
  }

  async function waitForPlan(): Promise<BrowserResearchPlanMetadata | null> {
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
    /** Ends the wait (the resync aborts it to recover a page that stopped answering). */
    signal?: AbortSignal;
  },
): Promise<{
  text: string;
  html?: string;
  meta: { turnId?: string | null; messageId?: string | null };
}> {
  const signal = options?.signal;
  // An aborted wait stops at once, also while a call to the page has not answered.
  const untilAborted = <T>(promise: Promise<T>): Promise<T> => {
    if (!signal) return promise;
    promise.catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new Error("Deep Research wait aborted"));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };
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
  // Today's Deep Research first posts a short acknowledgement (copy controls, no stop button) and
  // researches afterwards, so a finished reply without research activity is not yet a fallback:
  // what follows it decides.
  let firstReply: { identity: string; textLength: number; text: string } | null = null;
  let sawResearchFrame = false;
  // Hosts seen hosting the research frame; the iframe title may not be readable on every poll.
  const knownFrameHosts = new Set<string>();
  // A frame report without a known completion banner counts once it stops changing.
  let structural = null as { digest: string; polls: number } | null;

  logger(`Monitoring Deep Research (timeout: ${Math.round(timeoutMs / 60_000)}min)...`);

  try {
    while (Date.now() - start < timeoutMs) {
      const { result } = await untilAborted(
        Runtime.evaluate({
          expression: buildDeepResearchCompletionPollExpression(minTurnLiteral, [
            ...knownFrameHosts,
          ]),
          returnByValue: true,
        }),
      );

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
            turnKey?: string;
            turnCount?: number;
            replyText?: string;
            deepResearchFrameInScope?: boolean;
            firstTurnKey?: string;
            firstTurnLength?: number;
            firstTurnText?: string;
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
            await untilAborted(
              readDeepResearchTargetResult(
                client,
                ignoredTargetKeys,
                requireScopedTargetOwner ? minTurnLiteral : -1,
                {
                  // Reattach sets the owner flag even when the turn index could not
                  // be read. -1 would skip the owner filter and accept any finished
                  // iframe, including a report from another run.
                  rejectCompletedWhenOwnerUnknown: requireScopedTargetOwner && minTurnLiteral < 0,
                  frameScopeTurnIndex: minTurnLiteral,
                  knownFrameHosts,
                },
              ).catch(() => null),
            )
          )?.read ?? null)
        : null;
      const targetResult = filterIncompleteDeepResearchRead(rawTargetResult);
      // A completed target read is authoritative. If the target read is missing or
      // only in-progress, still try the in-page frame path so an incomplete target
      // read does not suppress a completed report there (legacy/inline rendering).
      const inPageScan =
        !targetResult?.completed && Page
          ? await untilAborted(
              readDeepResearchFrameResult(
                Runtime,
                Page,
                client,
                scopedToNewTurns ? minTurnLiteral : -1,
              ).catch(() => null),
            )
          : null;
      const rawInPageResult = inPageScan?.read ?? null;
      const inPageResult = filterIncompleteDeepResearchRead(rawInPageResult);
      const read = pickPreferredDeepResearchRead(targetResult, inPageResult);
      // Target keys captured before submission are ignored, so a target result is
      // tied to this run. Main-page iframes are not: old reports can remain in the
      // conversation and must never authorize a new normal-response fallback.
      // The report surface (a frame) decides completion once it is seen: the reply next to it is
      // only the acknowledgement.
      const frameSeen = Boolean(
        rawTargetResult || (scopedToNewTurns && rawInPageResult) || val?.deepResearchFrameInScope,
      );
      if (frameSeen && !sawResearchFrame) {
        logger("[browser] Deep Research report frame found; waiting for the research to complete.");
      }
      sawResearchFrame ||= frameSeen;
      observedResearchEvidence ||= Boolean(
        frameSeen || val?.researchActivity || val?.hasActiveScopedResearch,
      );
      // Scoped to this prompt, the last turn's own key identifies it; unscoped, the turn count
      // tells a newer turn from the same one.
      const turnIdentity = scopedToNewTurns
        ? (val?.turnKey ?? "")
        : `${val?.turnCount ?? ""}:${val?.turnKey ?? ""}`;
      // Scoped to this prompt's turns, a second assistant turn means something followed the first
      // reply (a reattach can arrive after the report did).
      const laterTurnPresent = scopedToNewTurns && (val?.turnCount ?? 0) > 1;
      if (!observedResearchEvidence && laterTurnPresent) observedResearchEvidence = true;
      const textLength = val?.textLength ?? 0;
      // The first reply is the first assistant turn after the prompt: with a later turn already
      // present (a reattach after the report), that is the acknowledgement, not the last turn.
      if (!firstReply && val && laterTurnPresent) {
        firstReply = {
          identity: val.firstTurnKey ?? "",
          textLength: val.firstTurnLength ?? 0,
          text: val.firstTurnText ?? "",
        };
      }
      const movedPastFirstReply =
        firstReply !== null &&
        (laterTurnPresent ||
          turnIdentity !== firstReply.identity ||
          (textLength >= firstReply.textLength * 2 && textLength - firstReply.textLength >= 200));
      if (firstReply && !observedResearchEvidence && val) {
        if (movedPastFirstReply || val.stopVisible) {
          observedResearchEvidence = true;
          logger("[browser] Deep Research activity followed ChatGPT's first reply.");
        }
      }
      if (read?.completed && read.text) {
        logger(`Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
        return {
          text: read.text,
          html: read.html,
          meta: { turnId: null, messageId: null },
        };
      }
      // A frame report without a known banner (localized UI, renamed banner) once it is stable.
      // Stability only counts while nothing shows progress: not the page (its stop button, an
      // active research in this turn) and not the frame.
      const progressShown = Boolean(
        val?.stopVisible || val?.hasActiveScopedResearch || read?.progressActive,
      );
      if (
        read &&
        !read.completed &&
        read.structuralComplete &&
        read.candidateText &&
        !progressShown
      ) {
        const digest = `${read.candidateText.length}:${read.candidateText.slice(-200)}`;
        structural =
          structural?.digest === digest
            ? { digest, polls: structural.polls + 1 }
            : { digest, polls: 1 };
        if (structural.polls >= DEEP_RESEARCH_STRUCTURAL_STABLE_POLLS) {
          logger(
            `Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed; report stable in its frame)`,
          );
          return {
            text: read.candidateText,
            html: read.candidateHtml,
            meta: { turnId: null, messageId: null },
          };
        }
      } else {
        structural = null;
      }

      // The research frame's own state wins: while it reports work in progress, no turn change or
      // finished assistant status is the final report.
      const frameWorking = Boolean(read && !read.completed);
      if (val?.finished && !frameWorking) {
        const extractable =
          observedResearchEvidence &&
          (!sawResearchFrame || (firstReply !== null && movedPastFirstReply));
        if (extractable) {
          logger(`Deep Research completed (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
          return await untilAborted(
            extractDeepResearchResult(Runtime, logger, minTurnIndex ?? undefined),
          );
        }
      }
      if (val?.finished && !firstReply) {
        firstReply = { identity: turnIdentity, textLength, text: val.replyText ?? "" };
        if (!observedResearchEvidence) {
          logger(
            "[browser] ChatGPT replied without visible Deep Research activity yet; Deep Research acknowledges first and researches afterwards, so Oracle keeps waiting for the research.",
          );
        }
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
      await untilAborted(delay(DEEP_RESEARCH_POLL_INTERVAL_MS));
    }
  } catch (error) {
    // The run's time ran out while a call to the page went unanswered (runClient.ts): the wait
    // ends exactly as at its own timeout below.
    if (!(error instanceof RunTimeExpiredError)) throw error;
  }

  if (firstReply && !observedResearchEvidence) {
    const reply = firstReply.text.replace(/\s+/g, " ").trim();
    const quoted = reply.length > 300 ? `${reply.slice(0, 300)}…` : reply;
    throw new BrowserAutomationError(
      "ChatGPT returned a completed response without starting Deep Research: nothing followed its reply " +
        `within ${Math.round(timeoutMs / 60_000)} minutes. The Deep Research selection may have silently fallen back to a normal response.` +
        (quoted ? ` ChatGPT said: "${quoted}"` : ""),
      { stage: "deep-research-not-started", code: "deep-research-not-started", reply },
    );
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
 * extraction logic (readAssistantSnapshot + captureTurnMarkdown).
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

  // Try the copy-button approach first for clean markdown, only from this turn's own button.
  const markdown = await captureTurnMarkdown(Runtime, meta, logger);
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
  /** A report without a known completion banner: report-shaped prose, no progress shown. */
  structuralComplete?: boolean;
  /** The frame shows active progress (shimmer, progress bar, busy region, stop control). */
  progressActive?: boolean;
  candidateText?: string;
  candidateHtml?: string;
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
    /** The prompt's turn: frame hosts are discovered only from iframes after it. */
    frameScopeTurnIndex?: number;
    /** Hosts seen hosting Deep Research earlier in this wait; new ones are added. */
    knownFrameHosts?: Set<string>;
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
    const knownFrameHosts = options?.knownFrameHosts;
    const discoveredHosts =
      sessions.size > 0
        ? await readDeepResearchAppFrameHosts(
            rawClient,
            pageSessionId,
            options?.frameScopeTurnIndex ?? minTurnIndex,
            [...(knownFrameHosts ?? [])],
          )
        : new Set<string>();
    for (const host of discoveredHosts) knownFrameHosts?.add(host);
    const appFrameHosts = new Set([...discoveredHosts, ...(knownFrameHosts ?? [])]);
    for (const [sessionId, target] of sessions) {
      const sessionResult = await readDeepResearchTargetSession(
        rawClient,
        sessionId,
        target.url,
        appFrameHosts,
        pageSessionId,
      );
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

/**
 * Hosts of the page's Deep Research iframes after the prompt's turn (`scopeTurnIndex`, when
 * known). Today the research runs in an MCP app frame whose URL is the generic app runtime
 * (`mcp-app-<hash>.web-sandbox.oaiusercontent.com/?app=skybridge`); the iframe element's title
 * names it, and the host is specific to the app.
 */
async function readDeepResearchAppFrameHosts(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  pageSessionId?: string,
  scopeTurnIndex = -1,
  knownHosts: readonly string[] = [],
): Promise<Set<string>> {
  const response = (await rawClient
    .send(
      "Runtime.evaluate",
      {
        expression: buildDeepResearchAppFrameHostsExpression(scopeTurnIndex, knownHosts),
        returnByValue: true,
      },
      pageSessionId,
    )
    .catch(() => null)) as { result?: { value?: unknown } } | null;
  const value = response?.result?.value;
  return new Set(
    Array.isArray(value) ? value.filter((host) => typeof host === "string" && host) : [],
  );
}

function buildDeepResearchAppFrameHostsExpression(
  scopeTurnIndex: number,
  knownHosts: readonly string[],
): string {
  return `(() => {
    const titles = ${JSON.stringify(DEEP_RESEARCH_FRAME_TITLES)};
    const known = ${JSON.stringify(knownHosts)};
    const isFrame = ${isDeepResearchFrameElement.toString()};
    const scope = ${Math.floor(scopeTurnIndex)};
    const turns = ${buildConversationTurnListExpression()};
    const scopeStart = scope >= 0 ? turns[scope] || null : null;
    if (scope >= 0 && !scopeStart) return [];
    return Array.from(document.querySelectorAll('iframe')).flatMap((frame) => {
      if (!isFrame(frame, titles, known)) return [];
      if (scopeStart && !(scopeStart === frame || scopeStart.contains(frame) ||
        (scopeStart.compareDocumentPosition(frame) & 4))) return [];
      try { return [new URL(frame.getAttribute('src') || '', location.href).host]; } catch { return []; }
    });
  })()`;
}

export function buildDeepResearchAppFrameHostsExpressionForTest(
  scopeTurnIndex: number,
  knownHosts: readonly string[] = [],
): string {
  return buildDeepResearchAppFrameHostsExpression(scopeTurnIndex, knownHosts);
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
          // Today's report frame sits beside the turn units, not inside one: then it belongs to
          // the last turn before it.
          functionDeclaration: `function() {
            const turns = ${buildConversationTurnListExpression()};
            let index = turns.findIndex((turn) => turn === this || turn.contains?.(this));
            for (let i = turns.length - 1; index < 0 && i >= 0; i -= 1) {
              if ((turns[i].compareDocumentPosition?.(this) ?? 0) & 4) index = i;
            }
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

/** The `title` and `name` of the iframe element that hosts `frameId`, or null when unreadable. */
async function readDeepResearchFrameOwnerIdentity(
  rawClient: {
    send: (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  frameId: string,
  pageSessionId?: string,
): Promise<{ title: string | null; name: string | null } | null> {
  const frameOwner = () =>
    rawClient.send("DOM.getFrameOwner", { frameId }, pageSessionId).catch(() => null) as Promise<{
      backendNodeId?: number;
    } | null>;
  let owner = await frameOwner();
  if (typeof owner?.backendNodeId !== "number") {
    // The DOM domain may not be enabled on this page session yet.
    await rawClient.send("DOM.enable", {}, pageSessionId).catch(() => undefined);
    owner = await frameOwner();
  }
  if (typeof owner?.backendNodeId !== "number") return null;
  const resolved = (await rawClient
    .send("DOM.resolveNode", { backendNodeId: owner.backendNodeId }, pageSessionId)
    .catch(() => null)) as { object?: { objectId?: string } } | null;
  const objectId = resolved?.object?.objectId;
  if (!objectId) return null;
  try {
    const response = (await rawClient
      .send(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
            const read = (name) => typeof this.getAttribute === 'function' ? this.getAttribute(name) : null;
            return { oracleFrameOwner: true, title: read('title'), name: read('name') };
          }`,
          returnByValue: true,
        },
        pageSessionId,
      )
      .catch(() => null)) as { result?: { value?: unknown } } | null;
    const value = response?.result?.value as
      | { oracleFrameOwner?: boolean; title?: unknown; name?: unknown }
      | undefined;
    if (value?.oracleFrameOwner !== true) return null;
    return {
      title: typeof value.title === "string" ? value.title : null,
      name: typeof value.name === "string" ? value.name : null,
    };
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
  appFrameHosts: ReadonlySet<string> = new Set(),
  pageSessionId?: string,
): Promise<DeepResearchTargetSessionResult> {
  await rawClient.send("Runtime.enable", {}, sessionId).catch(() => undefined);
  await rawClient.send("Page.enable", {}, sessionId).catch(() => undefined);

  const frameTree = (await rawClient
    .send("Page.getFrameTree", {}, sessionId)
    .catch(() => null)) as { frameTree?: DeepResearchFrameTree } | null;
  const ownerFrameId = frameTree?.frameTree?.frame?.id;
  if (!isConfirmedDeepResearchTarget(targetUrl, frameTree?.frameTree)) {
    if (!appFrameHosts.has(hostOf(targetUrl))) return { confirmed: false, read: null };
    // A known host alone is the generic app runtime: the same rule as the page's iframe check
    // applies, with the iframe element's title and name and the target's own URL. When the
    // element cannot be read, the host decides as before.
    const owner = ownerFrameId
      ? await readDeepResearchFrameOwnerIdentity(rawClient, ownerFrameId, pageSessionId)
      : null;
    const attributes: Record<string, string | null> = {
      title: owner?.title ?? null,
      name: owner?.name ?? null,
      src: targetUrl,
    };
    const element = {
      getAttribute: (attribute: string) => attributes[attribute] ?? null,
    } as unknown as Element;
    if (!isDeepResearchFrameElement(element, DEEP_RESEARCH_FRAME_TITLES, [...appFrameHosts])) {
      return { confirmed: false, read: null };
    }
  }
  const frameIds = collectDeepResearchFrameIds(frameTree?.frameTree);
  let best: DeepResearchFrameStatus | null = null;
  let progressActive = false;
  // A report-shaped candidate is kept over a later progress read; any frame of this target that
  // shows progress keeps it from counting as complete.
  const consider = (value: DeepResearchFrameStatus | null) => {
    if (!value) return;
    progressActive ||= value.progressActive === true;
    if (value.structuralComplete && !best?.structuralComplete) {
      best = value;
    } else if (
      !best?.structuralComplete &&
      ((value.textLength ?? 0) > (best?.textLength ?? 0) || value.inProgress)
    ) {
      best = value;
    }
  };
  const settled = (): DeepResearchFrameStatus | null =>
    best && progressActive ? { ...best, structuralComplete: false, progressActive: true } : best;

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
    consider(value);
  }

  const topFrameValue = await evaluateDeepResearchFrameStatus(rawClient, sessionId);
  if (topFrameValue?.completed) {
    return { confirmed: true, read: topFrameValue, frameId: ownerFrameId };
  }
  consider(topFrameValue);

  return { confirmed: true, read: settled(), frameId: ownerFrameId };
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
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
    // "Stop research" in the UI languages Oracle knows.
    const stopPattern = /stop research|停止研究|리서치 중지|연구 중지|リサーチを停止|arrêter la recherche|detener la investigación|detener investigación|recherche stoppen|recherche beenden|recherche abbrechen|recherche anhalten|parar pesquisa|parar a pesquisa|interromper pesquisa|interromper a pesquisa/i;
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
          stopPattern.test(cleanText(button.getAttribute?.('aria-label')))
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
        stopPattern.test(cleanText(button.getAttribute?.('aria-label')))
      );
    const researchStarted = planSteps.length > 0 && (hasResearchShimmer || hasStopResearchControl);
    const isPlaceholder = (line) => /^(called tool|used tool|użyto narzędzia|narzędzie wywołane)$/i.test(line);
    // The completion banner follows the UI language.
    const completionPattern = /research completed|badanie ukończone|리서치 완료|연구 완료|조사 완료|研究完成|研究已完成|调研完成|リサーチ完了|調査完了|recherche abgeschlossen|recherche terminée|investigación completada|pesquisa concluída/i;
    const isCompletionLine = (line) => completionPattern.test(line) && line.length <= 120;
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
    // Active progress: a shimmer, a progress bar, a busy region or a "Stop research" control.
    const progressIndicator = Boolean(document.querySelector?.('p.loading-shimmer, .loading-shimmer, [role="progressbar"], [aria-busy="true"]')) ||
      Array.from(document.querySelectorAll?.('button') ?? []).some((button) =>
        stopPattern.test(cleanText(button.getAttribute?.('aria-label') || button.textContent))
      );
    // A completion phrase in the text does not count while the frame still shows progress.
    const completed = !progressIndicator && completionPattern.test(rawText) &&
      reportText.length >= 40 &&
      !isPlaceholder(reportText);
    // Structural evidence for a banner Oracle does not know, measured in the report region only
    // (outside the plan panel and every progress or status element): prose blocks, the report's
    // shape, not its length. One progress sentence with a heading or a source link is not a
    // report. Oracle accepts it once it stays the same over several polls.
    const progressUi = '.loading-shimmer, [role="progressbar"], [aria-busy="true"], [role="status"], [aria-live], button, nav';
    const inReport = (node) => !(planSection && planSection.contains?.(node)) &&
      !(typeof node.closest === 'function' && node.closest(progressUi));
    const inRegion = (selector) => Array.from(document.querySelectorAll?.(selector) ?? []).filter(inReport);
    // Leaf blocks only, each text once: one sentence wrapped in li > p (or any other block
    // wrapper) is one block.
    const blockSelector = 'p, li, blockquote, td';
    const blockNodes = inRegion(blockSelector).filter((node) => cleanText(node.textContent).length >= 20);
    const wrappers = new Set();
    for (const node of blockNodes) {
      for (let parent = node.parentElement?.closest?.(blockSelector); parent; parent = parent.parentElement?.closest?.(blockSelector)) {
        wrappers.add(parent);
      }
    }
    const proseBlocks = new Set(
      blockNodes.filter((node) => !wrappers.has(node)).map((node) => cleanText(node.textContent)),
    ).size;
    const citations = inRegion('a[href^="http"]').length;
    const headings = inRegion('h1, h2, h3, h4').length;
    const reportShape = proseBlocks >= 3 || (proseBlocks >= 2 && (citations > 0 || headings > 0));
    const structuralComplete = !completed && !planSection && !progressIndicator &&
      reportText.length >= 40 && !isPlaceholder(reportText) && reportShape;
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
      structuralComplete,
      candidateText: structuralComplete ? reportText : undefined,
      candidateHtml: structuralComplete ? html : undefined,
      progressActive: progressIndicator,
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

function buildDeepResearchCompletionPollExpression(
  minTurnIndex: number,
  knownHosts: readonly string[] = [],
): string {
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
    // Today's Deep Research runs in an MCP app iframe titled "Deep research" next to the
    // acknowledgement, outside the assistant unit; it counts when it sits after this prompt.
    const isDeepResearchFrame = ${isDeepResearchFrameElement.toString()};
    const deepResearchTitles = ${JSON.stringify(DEEP_RESEARCH_FRAME_TITLES)};
    const knownHosts = ${JSON.stringify(knownHosts)};
    const scopeStart = scopedToNewTurns ? conversationTurns[MIN_TURN_INDEX] || null : null;
    const deepResearchFrameInScope = Boolean(scopeStart) && Array.from(document.querySelectorAll('iframe')).some(f => {
      const rect = f.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)) return false;
      if (!isDeepResearchFrame(f, deepResearchTitles, knownHosts)) return false;
      return scopeStart === f || Boolean(scopeStart.contains?.(f)) ||
        Boolean((scopeStart.compareDocumentPosition?.(f) ?? 0) & 4);
    });
    // Which assistant turn this is, so a later turn (the report after an acknowledgement) is seen.
    const attrOf = (node, name) => (node && typeof node.getAttribute === 'function' ? node.getAttribute(name) : null);
    const keyOf = (turn) => {
      const messageNode = attrOf(turn, 'data-message-id') !== null ? turn : turn?.querySelector?.('[data-message-id]');
      return String(attrOf(messageNode, 'data-message-id') || attrOf(turn, 'data-testid') ||
        attrOf(turn, 'data-content-search-unit-key') || attrOf(turn, 'data-chatgpt-search-unit-key') || '');
    };
    const turnKey = keyOf(lastTurn);
    const turnCount = (scopedToNewTurns ? scopedTurns : allAssistantTurns).length;
    // The first assistant turn after the prompt: the acknowledgement that a reattach may find
    // already followed by the report.
    const firstTurn = scopedToNewTurns ? scopedTurns[0] || null : lastTurn;
    const firstText = (firstTurn?.textContent || '').trim();
    return { finished, stopVisible, textLength, hasIframe, isToolStub, incompleteResult, researchActivity: tailIsPlanningPanel || (isToolStub && hasScopedDeepResearchIframe), hasActiveScopedResearch, accountBlocked, turnKey, turnCount, replyText: text.slice(0, 2000), deepResearchFrameInScope,
      firstTurnKey: keyOf(firstTurn), firstTurnLength: firstText.length, firstTurnText: firstText.slice(0, 2000) };
  })()`;
}

export function buildDeepResearchStatusExpressionForTest(): string {
  return buildDeepResearchStatusExpression();
}

export function buildDeepResearchCompletionPollExpressionForTest(
  minTurnIndex = -1,
  knownHosts: readonly string[] = [],
): string {
  return buildDeepResearchCompletionPollExpression(minTurnIndex, knownHosts);
}
