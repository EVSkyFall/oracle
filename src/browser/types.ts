import type { ProviderNativeCaptureSummary } from "./chatgptConversation.js";
import type CDP from "chrome-remote-interface";
import type Protocol from "devtools-protocol";
import type {
  BrowserModelPickerEvidence,
  BrowserModelSelectionEvidence,
  BrowserThinkingCapEvidence,
  BrowserThinkingSelectionEvidence,
  BrowserRunWarning,
  BrowserRuntimeMetadata,
} from "../sessionStore.js";
import type { SessionArtifact } from "../sessionStore.js";
import type { ThinkingTimeLevel } from "../oracle/types.js";

export type ChromeClient = Awaited<ReturnType<typeof CDP>>;
export type CookieParam = Protocol.Network.CookieParam;
export type BrowserModelStrategy = "select" | "current" | "ignore";
export type BrowserResearchMode = "off" | "search" | "deep";
export type BrowserArchiveMode = "auto" | "always" | "never";

export interface BrowserResearchPlanMetadata {
  title: string;
  steps: string[];
  /** Whether ChatGPT is still presenting the plan or has started executing it. */
  phase: "planning" | "researching";
  /** Visible plan action, for example Edit or Update. */
  actionText?: string;
  capturedAt: string;
}

export type BrowserLogger = ((message: string) => void) & {
  verbose?: boolean;
  sessionLog?: (message: string) => void;
};

/** One tool-permission prompt Oracle approved because its app was in allowApps. */
export interface BrowserAppApprovalRecord {
  app: string;
  /** Label of the clicked button, e.g. "Always allow". */
  button: string;
  /** The card's text without its buttons: what ChatGPT asked to run. */
  toolText: string;
  approvedAt: string;
  /**
   * How the button was clicked: a trusted (CDP) click, a synthetic event sequence where no
   * input domain exists, or click() from inside the page after trusted clicks kept missing.
   */
  method?: "trusted-click" | "synthetic" | "in-page-click";
}

/** A ChatGPT app/connector to mention in each prompt (for example CODEXish). */
export interface BrowserAppMention {
  /** Display name as ChatGPT shows it; matched case-insensitively. */
  name: string;
  /** Mention chip HTML copied from ChatGPT; pasted instead of using the "@" picker. */
  chipHtml?: string;
}

export interface BrowserAttachment {
  path: string;
  displayPath: string;
  sizeBytes?: number;
  generatedBundle?: boolean;
}

export interface BrowserGeneratedImage {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  fileId?: string;
}

export interface BrowserDownloadableFile {
  url: string;
  /** Position within the assistant turn for a linkless browser download button. */
  candidateId?: string;
  downloadUrl?: string;
  sandboxUrl?: string;
  filename?: string;
  label?: string;
  mimeType?: string;
}

export interface SavedBrowserImage extends SessionArtifact {
  kind: "image";
  url: string;
  finalUrl?: string;
  alt?: string;
  width?: number;
  height?: number;
  fileId?: string;
}

export interface SavedBrowserFile extends SessionArtifact {
  kind: "file";
  url: string;
  finalUrl?: string;
  sandboxUrl?: string;
  filename?: string;
}

export interface BrowserAutomationConfig {
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  browserTabRef?: string | null;
  url?: string;
  chatgptUrl?: string | null;
  timeoutMs?: number;
  debugPort?: number | null;
  inputTimeoutMs?: number;
  /** Time budget for each Chrome remote-debugging approval prompt. */
  approvalWaitMs?: number;
  /** Time budget for attachment upload/readiness before clicking send. */
  attachmentTimeoutMs?: number;
  /** Delay before rechecking the conversation after an assistant timeout. */
  assistantRecheckDelayMs?: number;
  /** Time budget for the delayed recheck attempt. */
  assistantRecheckTimeoutMs?: number;
  /** Wait for an existing shared Chrome to appear before launching a new one. */
  reuseChromeWaitMs?: number;
  /** Max time to wait for a shared manual-login profile lock (serializes parallel runs). */
  profileLockTimeoutMs?: number;
  /** Soft limit for concurrent ChatGPT tabs sharing one manual-login profile. */
  maxConcurrentTabs?: number;
  /** Delay before starting periodic auto-reattach attempts after a timeout. */
  autoReattachDelayMs?: number;
  /** Interval between auto-reattach attempts (0 disables). */
  autoReattachIntervalMs?: number;
  /** Time budget for each auto-reattach attempt. */
  autoReattachTimeoutMs?: number;
  cookieSync?: boolean;
  cookieNames?: string[] | null;
  cookieSyncWaitMs?: number;
  inlineCookies?: CookieParam[] | null;
  inlineCookiesSource?: string | null;
  headless?: boolean;
  keepBrowser?: boolean;
  hideWindow?: boolean;
  /**
   * Skip Chrome activation during ordinary runs: launch without a startup window, open run
   * tabs in background windows, and skip Page.bringToFront before trusted clicks while focus
   * emulation keeps the page rendering. Session recovery and harvest honor it too; a reattach
   * that falls back to relaunching Chrome uses a startup window and can still activate it.
   */
  noFocus?: boolean;
  desiredModel?: string | null;
  modelIsImplicitDefault?: boolean;
  modelStrategy?: BrowserModelStrategy;
  debug?: boolean;
  allowCookieErrors?: boolean;
  remoteChrome?: { host: string; port: number } | null;
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  /** Copy this signed-in Chrome user-data dir to a throwaway profile and run against it (login-free). */
  copyProfileSource?: string | null;
  /** Thinking time intensity level for Thinking/Pro models: light, standard, extended, heavy */
  thinkingTime?: ThinkingTimeLevel;
  /**
   * Highest effort tier a prompt may be sent with. Right before every submission the picker is
   * read; a higher tier is lowered to this one, and a tier still above it stops the submission.
   */
  maxThinkingTime?: ThinkingTimeLevel;
  /** Browser-only research mode. "deep" activates ChatGPT Deep Research. */
  researchMode?: BrowserResearchMode;
  /** Archive completed ChatGPT conversations after local artifacts are saved. */
  archiveConversations?: BrowserArchiveMode;
  /** Existing ChatGPT conversation URL to open before submitting the prompt. */
  resumeConversationUrl?: string | null;
  /** Capture ChatGPT's own conversation document plus independent per-turn digests. */
  captureProviderNative?: boolean;
  /**
   * Apps to mention in every submitted prompt (records, or plain names from config files);
   * a mention that cannot be verified stops the send.
   */
  apps?: Array<BrowserAppMention | string>;
  /**
   * Apps whose tool-permission prompts Oracle approves while it waits for a response
   * (Always allow > Allow once > Allow). Off unless listed; other prompts are left alone.
   */
  allowApps?: string[];
  /**
   * Select and verify the model and thinking time as a real run would, then restore the
   * previous selection and stop: no prompt is staged or sent.
   */
  selectOnly?: boolean;
}

/** What ChatGPT's model picker shows: the model radio, the effort tier and its slider. */
export interface BrowserModelPickerState {
  /** Text of the picker button, e.g. "Thinking effort Medium". */
  pickerLabel: string | null;
  /** Label of the checked model radio, e.g. "GPT-6". */
  modelLabel: string | null;
  modelOptions: string[];
  /** Effort tier shown at the top of the menu, e.g. "Medium" or "Pro". */
  tierLabel: string | null;
  sliderValue: number | null;
  sliderMin: number | null;
  sliderMax: number | null;
  /** Latest live-region announcement, e.g. "Medium, 2 of 5." */
  announcement: string | null;
  /**
   * Where `tierLabel` was read: the tier header, the slider's aria-valuetext, or only a live
   * announcement (which can be stale, so it never counts as the current tier).
   */
  tierSource?: "header" | "valuetext" | "announcement" | null;
  /**
   * Every current source that names a known tier (the tier header, the slider's aria-valuetext).
   * They can disagree right after a change; the maximum-thinking-time check uses the highest.
   */
  currentTiers?: BrowserModelPickerTierReading[];
  /** Whether the menu has an effort slider at all (mounted or not). */
  sliderPresent?: boolean;
}

export interface BrowserModelPickerTierReading {
  label: string;
  source: "header" | "valuetext";
}

/** Outcome of a select-only check. */
export interface BrowserSelectOnlyReport {
  /** The requested model and thinking time were selected and verified. */
  verified: boolean;
  reason?: string;
  requestedModel: string | null;
  requestedThinkingTime: string | null;
  /** The run's maximum thinking time, when set; its check ran as it would before a submit. */
  maxThinkingTime?: string;
  thinkingCap?: BrowserThinkingCapEvidence;
  before: BrowserModelPickerState | null;
  selected: BrowserModelPickerState | null;
  restored: BrowserModelPickerState | null;
  /** The picker shows the pre-check model and slider value again. */
  restoreVerified: boolean;
  restoreDetail?: string;
}

export interface BrowserRunOptions {
  prompt: string;
  /** Canonical model key, separate from a provider-specific picker label. */
  model?: string;
  /**
   * Abort the run when the caller no longer wants it.
   *
   * A browser run outlives the request that asked for it: the model keeps
   * thinking, the tab stays open, and the shared-profile slot stays taken. A
   * caller that has disconnected has no way to say so without this, so the run
   * continues to completion and its capacity is only returned by accident of
   * finishing.
   */
  signal?: AbortSignal;
  attachments?: BrowserAttachment[];
  /**
   * Optional secondary submission to try if the initial prompt is rejected by ChatGPT
   * (e.g. inline file paste exceeds composer limits). Intended for auto inline->upload fallback.
   */
  fallbackSubmission?: {
    prompt: string;
    attachments: BrowserAttachment[];
    prepare?: () => Promise<void>;
    pendingBundle?: {
      format: "text" | "zip";
      scope: "text-only" | "all";
    };
  };
  config?: BrowserAutomationConfig;
  log?: BrowserLogger;
  heartbeatIntervalMs?: number;
  verbose?: boolean;
  /** Session id used for cross-process browser slot diagnostics. */
  sessionId?: string;
  /** Browser-only image generation output path. */
  generateImagePath?: string;
  /** Optional output path for image operations. */
  outputPath?: string;
  /** Additional prompts to submit in the same browser conversation after the initial answer. */
  followUpPrompts?: string[];
  /**
   * Close a newly-created completed run tab even when the owning Chrome process
   * must remain alive. Used by long-lived shared browser services; incomplete
   * and attached-existing tabs are still preserved for recovery/user ownership.
   */
  closeOwnedTabOnComplete?: boolean;
  /** Close a cancelled run's owned target while keeping a shared browser process. */
  closeOwnedTabOnCancel?: boolean;
  /** Optional hook to persist runtime info and current model evidence as soon as Chrome is ready. */
  runtimeHintCb?: (
    hint: BrowserRuntimeMetadata,
    modelSelection?: BrowserModelSelectionEvidence,
    pickerEvidence?: BrowserPickerEvidenceHint,
  ) => void | Promise<void>;
}

/** Picker evidence gathered so far, persisted with the runtime hint so failed runs keep it. */
export interface BrowserPickerEvidenceHint {
  modelPicker?: BrowserModelPickerEvidence;
  thinkingCap?: BrowserThinkingCapEvidence[];
}

export interface BrowserArchiveResult {
  mode: BrowserArchiveMode;
  attempted: boolean;
  archived: boolean;
  reason?: string;
  conversationUrl?: string;
  error?: string;
}

export interface BrowserRunResult {
  /**
   * The no-focus setting a remote host actually ran with. Informational only: the caller records
   * it in the session, and a host never accepts it back as a client setting.
   */
  noFocus?: boolean;
  answerText: string;
  answerMarkdown: string;
  answerHtml?: string;
  artifacts?: SessionArtifact[];
  generatedImages?: BrowserGeneratedImage[];
  savedImages?: SavedBrowserImage[];
  downloadableFiles?: BrowserDownloadableFile[];
  savedFiles?: SavedBrowserFile[];
  archive?: BrowserArchiveResult;
  modelSelection?: BrowserModelSelectionEvidence;
  thinkingSelection?: BrowserThinkingSelectionEvidence;
  modelPicker?: BrowserModelPickerEvidence;
  thinkingCap?: BrowserThinkingCapEvidence[];
  providerNativeCapture?: ProviderNativeCaptureSummary;
  warnings?: BrowserRunWarning[];
  tookMs: number;
  answerTokens: number;
  answerChars: number;
  browserTransport?: "cdp";
  chromePid?: number;
  chromePort?: number;
  chromeHost?: string;
  chromeBrowserWSEndpoint?: string;
  chromeProfileRoot?: string;
  userDataDir?: string;
  chromeTargetId?: string;
  ownedRecoveryTarget?: BrowserRuntimeMetadata["ownedRecoveryTarget"];
  tabUrl?: string;
  conversationId?: string;
  promptSubmitted?: boolean;
  submittedPromptHash?: string | null;
  /** User turn identities rendered before the latest send; a turn among them is never its turn. */
  presendUserTurnIds?: string[] | null;
  /** Which prompt the latest send was: 0 the prompt, n the n-th in-run follow-up. */
  submittedPromptIndex?: number | null;
  researchPlan?: BrowserResearchPlanMetadata;
  controllerPid?: number;
  /** Tool-permission prompts approved through allowApps during this run. */
  appApprovals?: BrowserAppApprovalRecord[];
  /** Set on a select-only run, which sends nothing. */
  selectOnly?: BrowserSelectOnlyReport;
}

export type ResolvedBrowserConfig = Required<
  Omit<
    BrowserAutomationConfig,
    | "chromeProfile"
    | "chromePath"
    | "chromeCookiePath"
    | "desiredModel"
    | "modelIsImplicitDefault"
    | "remoteChrome"
    | "remoteChromeBrowserWSEndpoint"
    | "remoteChromeProfileRoot"
    | "thinkingTime"
    | "maxThinkingTime"
    | "modelStrategy"
    | "maxConcurrentTabs"
    | "researchMode"
    | "copyProfileSource"
    | "apps"
  >
> & {
  apps: BrowserAppMention[];
  chromeProfile?: string | null;
  chromePath?: string | null;
  chromeCookiePath?: string | null;
  attachRunning?: boolean;
  browserTabRef?: string | null;
  desiredModel?: string | null;
  modelIsImplicitDefault?: boolean;
  modelStrategy?: BrowserModelStrategy;
  thinkingTime?: ThinkingTimeLevel;
  maxThinkingTime?: ThinkingTimeLevel;
  debugPort?: number | null;
  inlineCookiesSource?: string | null;
  remoteChrome?: { host: string; port: number } | null;
  remoteChromeBrowserWSEndpoint?: string | null;
  remoteChromeProfileRoot?: string | null;
  manualLogin?: boolean;
  manualLoginProfileDir?: string | null;
  manualLoginCookieSync?: boolean;
  copyProfileSource?: string | null;
  maxConcurrentTabs: number;
  researchMode: BrowserResearchMode;
  archiveConversations: BrowserArchiveMode;
};
