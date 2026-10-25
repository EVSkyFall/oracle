// Real-Chrome fixture of ChatGPT's model picker: it reacts only to trusted pointer and key events,
// like chatgpt.com. Shared by the picker snapshot/restore tests and the thinking-time cap tests.
export type PickerFixtureVariant = "default" | "localized-header" | "no-effort" | "stuck-slider";

export function pickerFixture(
  keys: "horizontal" | "vertical",
  rtl: boolean,
  layered: boolean,
  sliderDelayMs = 0,
  variant: PickerFixtureVariant = "default",
  // The slider names its tier in aria-valuetext. window.freezeHeader = true keeps the header on
  // the tier it shows, so the header can trail the slider as it may right after a change.
  // headerLabel: the header shows this text instead of the tier (a localized word Oracle does
  // not know), so only the slider names the tier.
  options: { valueText?: boolean; headerLabel?: string } = {},
): string {
  // Layered mirrors chatgpt.com (2026-10-25): the model radios sit under the effort panel and
  // its "Select model" header brings them to the front.
  const layer = layered ? "position: absolute; inset: 0; background: #fff;" : "";
  return `<!doctype html><html dir="${rtl ? "rtl" : "ltr"}"><head><meta charset="utf-8"><style>
  body { font: 14px sans-serif; margin: 0; } #menu { position: absolute; top: 60px; left: 20px; border: 1px solid #888; width: 260px; height: ${layered ? "90px" : "auto"}; }
  #menu [role] { display: block; padding: 4px; } #slider { width: 200px; height: 12px; background: #ccc; }
  #models { ${layer} z-index: 1; } #effort { ${layer} z-index: 2; }
</style></head><body>
<form><div contenteditable="true" role="textbox">composer</div>
  <button type="button" id="picker" aria-label="Select ChatGPT model" aria-haspopup="menu" aria-controls="menu">Thinking effort Medium</button></form>
<div id="menu" role="menu" style="display:none">
  <div id="models">
    <div role="menuitemradio" data-model="GPT-6" aria-checked="true">GPT-6</div>
    <div role="menuitemradio" data-model="GPT-5.6 Sol" aria-checked="false">GPT-5.6 Sol</div>
  </div>
  <div id="effort">${
    variant === "no-effort"
      ? ""
      : variant === "localized-header"
        ? `<div role="menuitem" id="temp">임시 채팅</div>
    <div role="menuitem" id="tier" aria-label="모델 선택" aria-haspopup="menu">Medium</div>`
        : `<div role="menuitem" id="tier" aria-label="Select model">Medium</div>`
  }${
    variant === "no-effort"
      ? ""
      : `<div role="menuitem" aria-label="Power"><span id="slider" role="slider" tabindex="0" aria-valuemin="0" aria-valuemax="4" aria-valuenow="1"></span></div>`
  }
  </div>
</div>
<div aria-live="polite" id="live"></div>
<script>
  const tiers = ['Instant', 'Medium', 'High', 'Extra High', 'Pro'];
  const state = { open: false, model: 'GPT-6', value: 1, view: 'effort' };
  window.untrusted = 0;
  const $ = (id) => document.getElementById(id);
  const render = () => {
    $('picker').textContent = 'Thinking effort ' + tiers[state.value];
    $('picker').setAttribute('aria-expanded', String(state.open));
    $('menu').style.display = state.open ? 'block' : 'none';
    $('models').style.zIndex = state.view === 'models' ? '3' : '1';
    if ($('tier') && !window.freezeHeader) $('tier').textContent = ${JSON.stringify(options.headerLabel ?? null)} ?? tiers[state.value];
    $('slider')?.setAttribute('aria-valuenow', String(state.value));
    if (${options.valueText === true}) $('slider')?.setAttribute('aria-valuetext', tiers[state.value]);
    for (const radio of document.querySelectorAll('[role="menuitemradio"]')) radio.setAttribute('aria-checked', String(radio.dataset.model === state.model));
    // no-effort: the live region keeps an old announcement.
    if (${variant === "no-effort"} && $('live').textContent) return;
    $('live').textContent = tiers[state.value] + ', ' + (state.value + 1) + ' of 5.';
  };
  window.setPicker = (model, value) => { state.model = model; state.value = value; render(); };
  window.pickerState = () => ({ open: state.open, model: state.model, value: state.value });
  // The slider mounts a beat after the menu opens, as on chatgpt.com.
  const mountSlider = () => { if (!$('slider')) return; $('slider').style.display = 'none'; setTimeout(() => { $('slider').style.display = ''; }, ${sliderDelayMs}); };
  $('picker').addEventListener('pointerdown', (event) => { if (!event.isTrusted) { window.untrusted++; return; } state.open = !state.open; state.view = 'effort'; render(); if (state.open) mountSlider(); });
  $('tier')?.addEventListener('click', (event) => { if (!event.isTrusted) { window.untrusted++; return; } state.view = 'models'; render(); });
  for (const radio of document.querySelectorAll('[role="menuitemradio"]')) radio.addEventListener('click', (event) => {
    if (!event.isTrusted) { window.untrusted++; return; }
    state.model = radio.dataset.model; state.open = false; state.view = 'effort'; render();
  });
  const KEYS = ${JSON.stringify(keys)} === 'horizontal'
    ? { ArrowRight: ${rtl ? -1 : 1}, ArrowLeft: ${rtl ? 1 : -1} }
    : { ArrowUp: 1, ArrowDown: -1 };
  $('slider')?.addEventListener('keydown', (event) => {
    if (!event.isTrusted) { window.untrusted++; return; }
    if (state.view !== 'effort') return;
    // stuck-slider: the effort cannot be changed from this tab (for example a locked account).
    if (${variant === "stuck-slider"}) return;
    const delta = KEYS[event.key];
    if (!delta) return;
    event.preventDefault();
    state.value = Math.max(0, Math.min(4, state.value + delta)); render();
  });
  // window.ignoreEscape = true: a menu that Escape does not close (its button still toggles it).
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && event.isTrusted && !window.ignoreEscape) { state.open = false; state.view = 'effort'; render(); } });
  render();
</script></body></html>`;
}
