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
  window.actions = [];
  const list = document.getElementById('list');
  for (const id of rows) {
    const item = document.createElement('div');
    item.setAttribute('role', 'listitem');
    item.innerHTML = '<div role="group" class="row" aria-label="Chat ' + id + '"><div><a href="/c/' + id + '">Chat ' + id + '</a></div>' +
      (mode === 'legacy' ? '' : '<div class="actions"><div role="presentation"><button type="button" id="trigger-' + id + '" aria-label="Chat actions" aria-haspopup="menu" aria-expanded="false">⋯</button></div><button type="button" aria-label="Pin chat">p</button></div>') +
      '</div>';
    list.append(item);
  }
  const currentChat = () => (location.pathname.match(/\\/c\\/([^/]+)/) || [])[1] || null;
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
        window.actions.push({ item: label, chat });
        closeMenu();
        if (label !== 'Archive' || mode === 'stuck') return;
        document.querySelector('a[href="/c/' + chat + '"]')?.closest('[role="listitem"]')?.remove();
        if (mode === 'legacy') {
          const toast = document.createElement('div');
          toast.setAttribute('role', 'status');
          toast.textContent = 'Chat archived';
          document.body.append(toast);
        } else if (currentChat() === chat) {
          history.pushState({}, '', '/');
        }
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
      openMenu(trigger, mode === 'legacy' ? ['Pin', 'Archive', 'View files in chat'] : ['Pin', 'Plugins', 'View files in chat'], currentChat());
    } else {
      openMenu(trigger, ['Rename', 'Pin', 'Share', 'Archive', 'Delete', 'Move to project'], trigger.id.slice('trigger-'.length));
    }
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(); });
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
