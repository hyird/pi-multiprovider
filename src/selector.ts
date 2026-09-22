import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, getKeybindings, matchesKey, truncateToWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";

export type Choice = { id: string; label: string };

/** Bounded viewport: the selected row is always visible, including after resize. */
export class AccountSelector {
  private input = new Input({ placeholder: "Type to search..." });
  private filtered: Choice[];
  private selected = 0;
  private start = 0;
  private visible = 8;
  focused = true;
  constructor(private title: string, private choices: Choice[], private theme: Pick<Theme, "fg">, private height: () => number, private done: (id: string | undefined) => void) {
    this.filtered = choices;
  }
  invalidate() { this.input.invalidate(); }
  render(width: number): string[] {
    this.visible = Math.max(1, Math.min(10, this.height() - 6));
    this.start = Math.max(0, Math.min(this.selected - Math.floor(this.visible / 2), this.filtered.length - this.visible));
    this.input.focused = this.focused;
    const rows = this.filtered.slice(this.start, this.start + this.visible).map((item, i) => {
      const selected = this.start + i === this.selected;
      const text = truncateToWidth(`${selected ? "→ " : "  "}${item.label}`, width);
      return this.theme.fg(selected ? "accent" : "text", text);
    });
    return [
      this.theme.fg("accent", truncateToWidth(this.title.replace(/\n/g, " · "), width)),
      ...this.input.render(width),
      ...(rows.length ? rows : [this.theme.fg("dim", "No matches")]),
      this.theme.fg("dim", truncateToWidth(`${this.filtered.length ? this.selected + 1 : 0}/${this.filtered.length} · ↑↓ move · PgUp/PgDn page · Enter select · Esc back`, width)),
    ];
  }
  handleInput(data: string) {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) return this.done(undefined);
    if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selected];
      if (selected) this.done(selected.id);
      return;
    }
    if (kb.matches(data, "tui.select.up")) this.move(-1);
    else if (kb.matches(data, "tui.select.down")) this.move(1);
    else if (matchesKey(data, "pageUp")) this.move(-this.visible);
    else if (matchesKey(data, "pageDown")) this.move(this.visible);
    else if (matchesKey(data, "home")) this.selected = 0;
    else if (matchesKey(data, "end")) this.selected = Math.max(0, this.filtered.length - 1);
    else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (previous !== this.input.getValue()) {
        const terms = this.input.getValue().toLowerCase().trim().split(/\s+/);
        this.filtered = this.choices.filter(item => terms.every(term => `${item.label} ${item.id}`.toLowerCase().includes(term)));
        this.selected = 0;
      }
    }
  }
  private move(delta: number) { this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + delta)); }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "wheel" && event.wheelDelta) {
      this.move(event.wheelDelta < 0 ? -1 : 1);
      return { handled: true, render: true };
    }
    if (event.button === "left" && (event.type === "press" || event.type === "click")) {
      const row = event.y - 2;
      const index = this.start + row;
      if (row >= 0 && row < this.visible && index < this.filtered.length) {
        this.selected = index;
        if (event.type === "click") this.done(this.filtered[index]!.id);
        return { handled: true, render: true };
      }
    }
    return undefined;
  }
}

export async function selectMenu(ctx: ExtensionCommandContext, title: string, choices: Choice[] | string[]): Promise<string | undefined> {
  const items = choices.map(item => typeof item === "string" ? { id: item, label: item } : item);
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => new AccountSelector(title, items, theme, () => tui.terminal.rows, done));
}

export function providerChoices(ctx: ExtensionCommandContext, ids: string[]): Choice[] {
  return ids.map(id => ({ id, label: ctx.modelRegistry.getProviderDisplayName(id) })).sort((a, b) => a.label.localeCompare(b.label));
}
