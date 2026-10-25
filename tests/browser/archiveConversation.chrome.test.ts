import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import CDP from "chrome-remote-interface";
import * as chromeLauncher from "chrome-launcher";
import { archiveChatGptConversation } from "../../src/browser/actions/archiveConversation.js";

// Real-Chrome fixture of today's ChatGPT archive path (2026-10): the header "More" menu has no
// Archive; each sidebar row has a "Chat actions" menu with Archive next to Delete. Menus open on
// pointerdown like Radix. `legacy` adds Archive to the header menu (earlier UIs); `stuck` makes
// Archive do nothing. Run with ORACLE_CHROME_FIXTURES=1.
const enabled = process.env.ORACLE_CHROME_FIXTURES === "1";

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; margin: 0; }
  nav { position: absolute; left: 0; top: 0; width: 330px; bottom: 0; background: #eee; }
  header { position: absolute; left: 340px; right: 0; top: 0; height: 52px; }
  main { position: absolute; left: 340px; right: 0; top: 60px; }
  .row { position: relative; display: flex; height: 36px; align-items: center; }
  .row a { flex: 1; }
  .row .actions { display: flex; gap: 8px; opacity: 0; }
  .row:hover .actions { opacity: 1; }
  button { width: 20px; height: 20px; padding: 0; }
  #more { position: absolute; right: 100px; top: 16px; }
  [role="menu"] { position: fixed; background: #fff; border: 1px solid #888; width: 170px; }
  [role="menuitem"] { display: block; height: 28px; line-height: 28px; padding: 0 8px; }
  [role="status"] { position: fixed; bottom: 10px; left: 400px; }
</style></head><body>
<nav><div role="list" id="list"></div></nav>
<header><button id="more" type="button" aria-label="More" aria-haspopup="menu" aria-expanded="false">…</button></header>
<main>conversation</main>
<script>
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') || 'today';
  const rows = (params.get('rows') || '').split(',').filter(Boolean);
  // titles=bbb:Archive,aaa:Plan gives rows their own titles; the default is "Chat <id>".
  const titles = Object.fromEntries((params.get('titles') || '').split(',').filter(Boolean).map((entry) => entry.split(':')));
  const titleOf = (id) => titles[id] || 'Chat ' + id;
  const legacyLayout = mode === 'legacy' || mode === 'spa-switch';
  window.actions = [];
  const list = document.getElementById('list');
  for (const id of rows) {
    const item = document.createElement('div');
    item.setAttribute('role', 'listitem');
    item.innerHTML = '<div role="group" class="row" aria-label="Chat ' + id + '"><div><a href="/c/' + id + '">' + titleOf(id) + '</a></div>' +
      (legacyLayout ? '' : '<div class="actions"><div role="presentation"><button type="button" id="trigger-' + id + '" aria-label="Chat actions" aria-haspopup="menu" aria-expanded="false">⋯</button></div><button type="button" aria-label="Pin chat">p</button></div>') +
      '</div>';
    list.append(item);
  }
  const currentChat = () => (location.pathname.match(/\\/c\\/([^/]+)/) || [])[1] || null;
  const archiveRow = (chat) => {
    document.querySelector('a[href="/c/' + chat + '"]')?.closest('[role="listitem"]')?.remove();
    if (legacyLayout) {
      const toast = document.createElement('div');
      toast.setAttribute('role', 'status');
      toast.textContent = 'Chat archived';
      document.body.append(toast);
    } else if (currentChat() === chat) {
      history.pushState({}, '', '/');
    }
  };
  // A confirmation dialog whose Archive button archives \`chat\`; named = it says which chat (in
  // <strong>, like ChatGPT's delete confirmation). \`dialog.chat\` can be set later.
  const openConfirm = (chat, named) => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.style.cssText = 'position: fixed; left: 450px; top: 200px; width: 320px; height: 120px; background: #fff; border: 1px solid #000;';
    dialog.innerHTML = '<p>' + (named ? 'This will archive <strong>' + titleOf(chat) + '</strong>.' : 'Archive this chat?') + '</p><button type="button" style="width: 90px; height: 24px">Archive</button>';
    dialog.chat = chat;
    dialog.querySelector('button').addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      window.actions.push({ item: 'Confirm', chat: dialog.chat });
      dialog.remove();
      archiveRow(dialog.chat);
    });
    document.body.append(dialog);
    return dialog;
  };
  // A generic confirmation that exists hidden before any click and is shown by Archive.
  const hiddenConfirm = mode === 'hidden-confirm' ? openConfirm(null, false) : null;
  if (hiddenConfirm) hiddenConfirm.style.display = 'none';
  let open = null;
  const closeMenu = () => {
    if (!open) return;
    open.menu.remove();
    open.trigger.setAttribute('aria-expanded', 'false');
    open.trigger.removeAttribute('aria-controls');
    open = null;
  };
  const openMenu = (trigger, labels, chat) => {
    closeMenu();
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.id = 'menu-' + trigger.id;
    menu.setAttribute('aria-labelledby', trigger.id);
    const rect = trigger.getBoundingClientRect();
    menu.style.left = Math.min(rect.left, innerWidth - 180) + 'px';
    menu.style.top = rect.bottom + 4 + 'px';
    for (const label of labels) {
      const item = document.createElement('div');
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
      item.textContent = label;
      item.addEventListener('click', () => {
        // The header menu acts on whatever chat is open when it is clicked.
        chat = chat ?? currentChat();
        window.actions.push({ item: label, chat });
        closeMenu();
        if (label !== 'Archive' || mode === 'stuck' || mode === 'stale-confirm') return;
        if (mode === 'stuck-nav') { history.pushState({}, '', '/c/zzz'); return; }
        if (mode === 'confirm') { openConfirm(chat, true); return; }
        if (mode === 'unnamed-confirm') { openConfirm(chat, false); return; }
        if (mode === 'hidden-confirm') { hiddenConfirm.chat = chat; hiddenConfirm.style.display = 'block'; return; }
        // Another chat's confirmation opens on the same page while we wait for ours.
        if (mode === 'foreign-confirm') { setTimeout(() => openConfirm('bbb', true), 100); return; }
        archiveRow(chat);
      });
      menu.append(item);
    }
    document.body.append(menu);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', menu.id);
    open = { menu, trigger };
  };
  document.addEventListener('pointerdown', (event) => {
    const trigger = event.target.closest?.('button[aria-haspopup="menu"]');
    if (!trigger) {
      if (open && !open.menu.contains(event.target)) closeMenu();
      return;
    }
    if (open && open.trigger === trigger) { closeMenu(); return; }
    if (trigger.id === 'more') {
      openMenu(trigger, legacyLayout ? ['Pin', 'Archive', 'View files in chat'] : ['Pin', 'Plugins', 'View files in chat'], null);
      // The single-page app moves to another chat while the menu is open.
      if (mode === 'spa-switch') setTimeout(() => history.pushState({}, '', '/c/zzz'), 50);
    } else if (trigger.dataset.inert === 'true') {
      return;
    } else {
      openMenu(trigger, ['Rename', 'Pin', 'Share', 'Archive', 'Delete', 'Move to project'], trigger.id.slice('trigger-'.length));
    }
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
  if (mode === 'stale-menu') {
    // Another chat's menu is already open, and this chat's button has no link attributes and
    // opens nothing.
    const own = document.getElementById('trigger-aaa');
    own.removeAttribute('id');
    own.removeAttribute('aria-expanded');
    own.dataset.inert = 'true';
    openMenu(document.getElementById('trigger-bbb'), ['Rename', 'Archive', 'Delete'], 'bbb');
  }
  // A confirmation that was already open before our click (it would archive bbb).
  if (mode === 'stale-confirm') openConfirm('bbb', false);
</script></body></html>`;

describe.runIf(enabled)("conversation archive in real Chrome", () => {
  let chrome: chromeLauncher.LaunchedChrome;
  let client: Awaited<ReturnType<typeof CDP>>;
  let server: http.Server;
  let base = "";
  let userDataDir: string;

  beforeAll(async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(FIXTURE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-archive-fixture-"));
    chrome = await chromeLauncher.launch({
      chromeFlags: ["--headless=new", "--window-size=1200,700", "--no-first-run"],
      userDataDir,
    });
    client = await CDP({ port: chrome.port });
    await Promise.all([client.Page.enable(), client.Runtime.enable()]);
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    chrome?.kill();
    server?.close();
    await fs
      .rm(userDataDir, { recursive: true, force: true, maxRetries: 5 })
      .catch(() => undefined);
  });

  async function load(page: string, query: Record<string, string>) {
    const url = `${base}/c/${page}?${new URLSearchParams(query).toString()}`;
    await client.Page.navigate({ url });
    await client.Page.loadEventFired();
    return url;
  }
  const pageState = async () =>
    (
      await client.Runtime.evaluate({
        expression:
          "({ actions: window.actions, rows: Array.from(document.querySelectorAll('nav a')).map((a) => a.getAttribute('href')), menus: document.querySelectorAll('[role=\"menu\"]').length })",
        returnByValue: true,
      })
    ).result.value as {
      actions: Array<{ item: string; chat: string | null }>;
      rows: string[];
      menus: number;
    };
  const archive = (conversationUrl: string, logger = vi.fn()) =>
    archiveChatGptConversation(client.Runtime, logger as never, {
      mode: "auto",
      conversationUrl,
      Input: client.Input,
    });

  test("archives the chat through its own sidebar row's Chat actions menu", async () => {
    const url = await load("aaa", { rows: "bbb,aaa,ccc" });
    await expect(archive(url)).resolves.toMatchObject({ attempted: true, archived: true });
    const state = await pageState();
    expect(state.actions).toEqual([{ item: "Archive", chat: "aaa" }]);
    expect(state.rows).toEqual(["/c/bbb", "/c/ccc"]);
    expect(state.menus).toBe(0);
  }, 60_000);

  test("archives a chat that is not the open page by its row alone", async () => {
    await load("zzz", { rows: "bbb,aaa" });
    await expect(archive(`${base}/c/aaa`)).resolves.toMatchObject({ archived: true });
    expect((await pageState()).actions).toEqual([{ item: "Archive", chat: "aaa" }]);
  }, 60_000);

  test("without a row for this chat, no other chat's menu is used and the cause is reported", async () => {
    const url = await load("aaa", { rows: "bbb,ccc" });
    const logger = vi.fn();
    await expect(archive(url, logger)).resolves.toMatchObject({
      attempted: true,
      archived: false,
      reason: "archive-menu-item-not-found",
    });
    const state = await pageState();
    expect(state.actions).toEqual([]);
    expect(state.rows).toEqual(["/c/bbb", "/c/ccc"]);
    expect(state.menus).toBe(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("header menu: no Archive item"));
  }, 60_000);

  test("the header menu still archives on earlier UIs", async () => {
    const url = await load("aaa", { rows: "bbb,aaa", mode: "legacy" });
    await expect(archive(url)).resolves.toMatchObject({ archived: true });
    expect((await pageState()).actions).toEqual([{ item: "Archive", chat: "aaa" }]);
  }, 60_000);

  test("the header menu is never used while the page shows another chat", async () => {
    await load("zzz", { rows: "bbb", mode: "legacy" });
    await expect(archive(`${base}/c/aaa`)).resolves.toMatchObject({
      archived: false,
      reason: "conversation-menu-not-found",
    });
    expect((await pageState()).actions).toEqual([]);
  }, 60_000);

  test("the header Archive click is cancelled when the page moves to another chat", async () => {
    const url = await load("aaa", { rows: "bbb", mode: "spa-switch" });
    await expect(archive(url)).resolves.toMatchObject({
      archived: false,
      reason: "conversation-changed",
    });
    expect((await pageState()).actions).toEqual([]);
  }, 60_000);

  test("a menu that another chat's button opened is never used", async () => {
    const url = await load("aaa", { rows: "bbb,aaa", mode: "stale-menu" });
    await expect(archive(url)).resolves.toMatchObject({ archived: false });
    const state = await pageState();
    expect(state.actions).toEqual([]);
    expect(state.rows).toEqual(["/c/bbb", "/c/aaa"]);
  }, 60_000);

  test("moving to another chat after the Archive click is not an archive", async () => {
    const url = await load("aaa", { rows: "aaa", mode: "stuck-nav" });
    await expect(archive(url)).resolves.toMatchObject({ archived: false });
    expect((await pageState()).actions).toEqual([{ item: "Archive", chat: "aaa" }]);
  }, 60_000);

  test.each([
    ["confirm", ""],
    ["unnamed-confirm", ""],
    // A chat titled like the confirm button does not make a generic confirmation foreign.
    ["unnamed-confirm", "bbb:Archive"],
    // Hidden before the Archive click and shown after it: it is new.
    ["hidden-confirm", ""],
  ])(
    "the confirmation that our Archive click opened is confirmed (%s, titles %j)",
    async (mode, titles) => {
      const url = await load("aaa", { rows: "bbb,aaa", mode, titles });
      await expect(archive(url)).resolves.toMatchObject({ archived: true });
      const state = await pageState();
      expect(state.actions).toEqual([
        { item: "Archive", chat: "aaa" },
        { item: "Confirm", chat: "aaa" },
      ]);
      expect(state.rows).toEqual(["/c/bbb"]);
    },
    60_000,
  );

  test.each([
    ["foreign-confirm", ""],
    // Our chat "Plan" is only part of the name the confirmation shows.
    ["foreign-confirm", "aaa:Plan,bbb:Plan review"],
    ["stale-confirm", ""],
  ])(
    "a confirmation that is not ours is never clicked (%s, titles %j)",
    async (mode, titles) => {
      const url = await load("aaa", { rows: "bbb,aaa", mode, titles });
      const logger = vi.fn();
      await expect(archive(url, logger)).resolves.toMatchObject({
        archived: false,
        reason: "archive-not-confirmed",
      });
      const state = await pageState();
      expect(state.actions).toEqual([{ item: "Archive", chat: "aaa" }]);
      expect(state.rows).toEqual(["/c/bbb", "/c/aaa"]);
    },
    60_000,
  );

  test("an Archive click that changes nothing is reported as not confirmed", async () => {
    const url = await load("aaa", { rows: "aaa", mode: "stuck" });
    await expect(archive(url)).resolves.toMatchObject({
      archived: false,
      reason: "archive-not-confirmed",
    });
    const state = await pageState();
    expect(state.actions).toEqual([{ item: "Archive", chat: "aaa" }]);
    expect(state.menus).toBe(0);
  }, 60_000);
});
