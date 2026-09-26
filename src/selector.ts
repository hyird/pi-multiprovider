import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Input, getKeybindings, matchesKey, truncateToWidth, wrapTextWithAnsi, fuzzyFilter, type TuiMouseEvent } from "@earendil-works/pi-tui";

export type Choice = { id: string; label: string; value?: string; description?: string; danger?: boolean; editId?: string };

/** Bounded viewport: the selected row is always visible, including after resize. */
export class AccountSelector {
  private input = new Input({ placeholder: "Type to search..." });
  private filtered: Choice[];
  private selected = 0;
  private start = 0;
  private visible = 8;
  private rowOffset = 2;
  private lineItems: number[] = [];
  focused = true;
  constructor(private title: string, private choices: Choice[], private theme: Pick<Theme, "fg">, private height: () => number, private done: (id: string | undefined) => void) {
    this.filtered = choices;
  }
  invalidate() { this.input.invalidate(); }
  render(width: number): string[] {
    const compact = this.height() < 16;
    this.visible = Math.max(1, Math.min(10, this.height() - (compact ? 6 : 11)));
    this.start = Math.max(0, Math.min(this.selected - Math.floor(this.visible / 2), this.filtered.length - this.visible));
    this.input.focused = this.focused;
    const blocks = this.filtered.slice(this.start, this.start + this.visible).map((item, i) => {
      const index = this.start + i;
      const selected = index === this.selected;
      const text = `${selected ? "→ " : "  "}${item.label}`;
      const value = item.value ? "  " + this.theme.fg("muted", item.value) : "";
      return { index, lines: wrapTextWithAnsi(" " + this.theme.fg(selected ? "accent" : item.danger ? "error" : "text", text) + value, Math.max(1, width)) };
    });
    const budget = Math.max(1, this.height() - (compact ? 3 : 9));
    while (blocks.length > 1 && blocks.reduce((sum, block) => sum + block.lines.length, 0) > budget) {
      if (blocks[0]!.index < this.selected) blocks.shift();
      else blocks.pop();
    }
    this.lineItems = blocks.flatMap(block => block.lines.map(() => block.index));
    const rows = blocks.flatMap(block => block.lines);
    const border = this.theme.fg("border", "─".repeat(Math.max(1, width)));
    const heading = this.theme.fg("accent", truncateToWidth(` ${this.title.replace(/\n/g, " · ")}`, width));
    const header = compact ? [heading, ...this.input.render(width)] : [border, heading, this.theme.fg("muted", " Manage your accounts and API keys"), "", ...this.input.render(width), ""];
    this.rowOffset = header.length;
    return [
      ...header,
      ...(rows.length ? rows : [this.theme.fg("dim", "No matches")]),
      ...(!compact ? ["", this.theme.fg("dim", truncateToWidth(` ${this.filtered[this.selected]?.description ?? "Select an item to continue."}`, width))] : []),
      this.theme.fg("dim", truncateToWidth(`${this.filtered[this.selected]?.editId ? "Ctrl+E rename · " : ""}Enter select · Esc back · ${this.filtered.length ? this.selected + 1 : 0}/${this.filtered.length} · ↑↓ · PgUp/PgDn`, width)),
      ...(!compact ? [border] : []),
    ];
  }
  handleInput(data: string) {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) return this.done(undefined);
    if (matchesKey(data, "ctrl+e") && this.filtered[this.selected]?.editId) {
      this.done(this.filtered[this.selected]!.editId);
      return;
    }
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
        const query = this.input.getValue().trim();
        this.filtered = query ? fuzzyFilter(this.choices, query, item => `${item.label} ${item.id} ${item.value ?? ""}`) : this.choices;
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
      const row = event.y - this.rowOffset;
      const index = this.lineItems[row];
      if (row >= 0 && index !== undefined) {
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
