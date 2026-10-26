import type { BrowserAppMention, BrowserLogger, ChromeClient } from "../types.js";
import type { ProviderDomAdapter, ProviderDomFlowContext } from "../providerDomFlow.js";
import { ensurePromptReady } from "../actions/navigation.js";
import { submitPrompt, type AttachmentReadyExpectation } from "../actions/promptComposer.js";
import { waitForAssistantResponse } from "../actions/assistantResponse.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import type { PageUserTurn } from "../promptFingerprint.js";

interface ChatgptDomProviderState {
  runtime: ChromeClient["Runtime"];
  input: ChromeClient["Input"];
  page?: ChromeClient["Page"];
  activateBeforeTrustedInput?: boolean;
  logger: BrowserLogger;
  timeoutMs: number;
  inputTimeoutMs?: number;
  attachmentTimeoutMs?: number;
  baselineTurns?: number | null;
  attachmentNames?: AttachmentReadyExpectation[];
  attachmentNavigationUrl?: string;
  committedTurns?: number | null;
  onPromptSubmitted?: () => Promise<void> | void;
  webSearch?: boolean;
  deepResearch?: boolean;
  apps?: BrowserAppMention[];
  maxThinkingTime?: ThinkingTimeLevel;
  /** The user turn identities rendered before the send (the run's readUserMessageIds). */
  previousUserMessageIds?: readonly string[];
  /** The send's commit was not proven; the run went on (see submitPrompt's onCommitUnproven). */
  commitUnproven?: boolean;
  /** With commitUnproven: the latest user turn standing for the sent one, if any. */
  unprovenCommitTurn?: PageUserTurn | null;
  /** The sent user turn that proved the commit. */
  committedTurn?: PageUserTurn | null;
}

function requireState(ctx: ProviderDomFlowContext): ChatgptDomProviderState {
  const state = ctx.state as ChatgptDomProviderState | undefined;
  if (!state?.runtime || !state?.input || !state?.logger) {
    throw new Error("chatgptDomProvider requires runtime/input/logger in context.state.");
  }
  return state;
}

async function waitForUi(ctx: ProviderDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  await ensurePromptReady(state.runtime, state.inputTimeoutMs ?? 30_000, state.logger);
}

async function typePrompt(_ctx: ProviderDomFlowContext): Promise<void> {
  // submitPrompt() handles typing + send for ChatGPT.
}

async function submitPromptViaAdapter(ctx: ProviderDomFlowContext): Promise<void> {
  const state = requireState(ctx);
  const committedTurns = await submitPrompt(
    {
      runtime: state.runtime,
      input: state.input,
      page: state.page,
      activateBeforeTrustedInput: state.activateBeforeTrustedInput,
      attachmentNames: state.attachmentNames ?? [],
      attachmentNavigationUrl: state.attachmentNavigationUrl,
      baselineTurns: state.baselineTurns ?? undefined,
      inputTimeoutMs: state.inputTimeoutMs ?? undefined,
      attachmentTimeoutMs: state.attachmentTimeoutMs ?? undefined,
      onPromptSubmitted: state.onPromptSubmitted,
      webSearch: state.webSearch,
      deepResearch: state.deepResearch,
      apps: state.apps,
      maxThinkingTime: state.maxThinkingTime,
      baselineUserIds: state.previousUserMessageIds,
      onCommitUnproven: (turn) => {
        state.commitUnproven = true;
        state.unprovenCommitTurn = turn;
      },
      onCommitted: (turn) => {
        state.committedTurn = turn;
      },
    },
    ctx.prompt,
    state.logger,
  );
  state.committedTurns =
    typeof committedTurns === "number" && Number.isFinite(committedTurns) ? committedTurns : null;
  // The committed count ends at the sent user turn, so the answer wait starts there. It can be
  // lower than the count before the send: a long conversation unmounts old turns for new ones.
  if (state.committedTurns != null) {
    state.baselineTurns = Math.max(0, state.committedTurns - 1);
  }
}

async function waitForResponse(ctx: ProviderDomFlowContext): Promise<{
  text: string;
  html?: string;
  meta?: { turnId?: string | null; messageId?: string | null };
}> {
  const state = requireState(ctx);
  const answer = await waitForAssistantResponse(
    state.runtime,
    state.timeoutMs,
    state.logger,
    state.baselineTurns ?? undefined,
  );
  return {
    text: answer.text,
    html: answer.html,
    meta: answer.meta,
  };
}

export const chatgptDomProvider: ProviderDomAdapter = {
  providerName: "chatgpt-web",
  waitForUi,
  typePrompt,
  submitPrompt: submitPromptViaAdapter,
  waitForResponse,
};
