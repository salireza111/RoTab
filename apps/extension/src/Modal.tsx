import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
export function Modal({
  children,
  close,
  label,
  confirm,
  confirmDisabled = false,
}: {
  children: ReactNode;
  close: () => void;
  label: string;
  confirm?: () => void | Promise<void>;
  confirmDisabled?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null),
    previousFocus = useRef(document.activeElement as HTMLElement | null),
    dismiss = useRef(close);
  dismiss.current = close;
  useEffect(() => {
    const root = host.current!,
      previous = previousFocus.current;
    const targets = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ),
      ).filter((e) => e.getClientRects().length > 0);
    if (!root.contains(document.activeElement)) targets()[0]?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss.current();
      }
      if (event.key === "Tab") {
        const list = targets(),
          first = list[0],
          last = list.at(-1);
        if (!first) {
          event.preventDefault();
          root.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    root.addEventListener("keydown", key);
    return () => {
      root.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      ref={host}
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
    >
      {Children.map(children, (child) =>
        confirm && isValidElement<{ children?: ReactNode }>(child)
          ? cloneElement(
              child,
              {},
              child.props.children,
              <footer className="modal-confirm">
                <button
                  type="button"
                  className="primary"
                  disabled={confirmDisabled}
                  onClick={() => void confirm()}
                >
                  OK
                </button>
              </footer>,
            )
          : child,
      )}
    </div>
  );
}
