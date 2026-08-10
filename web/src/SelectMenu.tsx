import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

export type SelectOption = {
  value: string;
  label: string;
  /** 選択肢の意味。開いたときだけ出す。閉じている間は場所を取らない。 */
  description?: string;
};

type SelectMenuProps = {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
};

/** OSごとに選択肢だけ外観が変わるのを避け、入力欄と同じ面として表示する。 */
export function SelectMenu({ label, value, options, onChange }: SelectMenuProps) {
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const [highlightedIndex, setHighlightedIndex] = useState(Math.max(selectedIndex, 0));
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listbox = useRef<HTMLUListElement>(null);
  const listboxId = useId();
  const selected = options[selectedIndex] ?? options[0];

  useEffect(() => {
    if (!open) return;

    setHighlightedIndex(Math.max(selectedIndex, 0));
    const frame = window.requestAnimationFrame(() => listbox.current?.focus());
    const closeFromOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeFromOutside);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeFromOutside);
    };
  }, [open, selectedIndex]);

  function select(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    window.requestAnimationFrame(() => trigger.current?.focus());
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setOpen(true);
  }

  function handleListboxKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(highlightedIndex);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    event.preventDefault();
    if (event.key === "Home") setHighlightedIndex(0);
    else if (event.key === "End") setHighlightedIndex(options.length - 1);
    else {
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlightedIndex((current) => (current + direction + options.length) % options.length);
    }
  }

  return (
    <div className="select-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="select-menu-trigger"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selected?.label}</span>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="m5.5 7.5 4.5 4.5 4.5-4.5" />
        </svg>
      </button>
      {open && (
        <ul
          ref={listbox}
          id={listboxId}
          className="select-menu-options"
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${listboxId}-option-${highlightedIndex}`}
          onKeyDown={handleListboxKeyDown}
        >
          {options.map((option, index) => (
            <li
              id={`${listboxId}-option-${index}`}
              key={option.value}
              role="option"
              aria-selected={option.value === value}
              className={index === highlightedIndex ? "highlighted" : undefined}
              onClick={() => select(index)}
              onPointerEnter={() => setHighlightedIndex(index)}
            >
              <span className="select-menu-check" aria-hidden="true">
                {option.value === value ? "✓" : ""}
              </span>
              <span className="select-menu-text">
                <span>{option.label}</span>
                {option.description && (
                  <span className="select-menu-description">{option.description}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
