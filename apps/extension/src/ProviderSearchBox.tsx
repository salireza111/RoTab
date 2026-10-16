import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, Check, ChevronDown, Globe, Search } from "lucide-react";
import { searchWithDefaultProvider } from "./browser-search";
import googleIcon from "./search-icons/google.ico";
import duckduckgoIcon from "./search-icons/duckduckgo.ico";
import braveIcon from "./search-icons/brave.ico";
import bingIcon from "./search-icons/bing.ico";
import {
  SUGGESTION_PROVIDERS,
  SuggestionRequestError,
  fetchSuggestions,
  hasSuggestionAccess,
  requestSuggestionAccess,
  selectedSearchUrl,
  suggestionProvider,
  type SearchProvider,
} from "./search-suggestions";

export interface ProviderSearchBoxProps {
  provider: SearchProvider;
  suggestionsEnabled: boolean;
  change(patch: {
    searchProvider?: SearchProvider;
    searchSuggestionsEnabled?: boolean;
  }): void;
}

function ProviderMark({ provider }: { provider: SearchProvider }) {
  const icons = {
    google: googleIcon,
    duckduckgo: duckduckgoIcon,
    brave: braveIcon,
    bing: bingIcon,
  };
  return provider === "default" ? (
    <Globe size={19} aria-hidden="true" />
  ) : (
    <span
      className={`search-provider-mark search-provider-${provider}`}
      aria-hidden="true"
    >
      <img src={icons[provider]} alt="" width="25" height="25" />
    </span>
  );
}

export function ProviderSearchBox({
  provider,
  suggestionsEnabled,
  change,
}: ProviderSearchBoxProps) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [suggestionStatus, setSuggestionStatus] = useState("");
  const root = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const limitedUntil = useRef<Partial<Record<SearchProvider, number>>>({});
  const identity = useId(),
    menuId = `${identity}-engines`,
    listId = `${identity}-suggestions`;
  const providerName =
    provider === "default"
      ? "Browser default"
      : suggestionProvider(provider).name;

  useEffect(() => {
    if (!menuOpen) return;
    menu.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  useEffect(() => {
    setSuggestions([]);
    setActiveIndex(-1);
    setSuggestionStatus("");
    if (
      !focused ||
      menuOpen ||
      !suggestionsEnabled ||
      provider === "default" ||
      query.trim().length < 2
    )
      return;
    if (Date.now() < (limitedUntil.current[provider] ?? 0)) {
      setSuggestionStatus(
        `${suggestionProvider(provider).name} suggestions are temporarily limited. You can still search.`,
      );
      return;
    }
    let current = true;
    const controller = new AbortController();
    request.current = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const debounce = setTimeout(async () => {
      try {
        if (!(await hasSuggestionAccess(provider))) {
          if (current)
            setSuggestionStatus(
              "Suggestions are blocked. Open the engine menu to enable them.",
            );
          return;
        }
        if (!current) return;
        setSuggestionStatus("Loading suggestions…");
        timeout = setTimeout(() => controller.abort(), 4500);
        const results = await fetchSuggestions(
          provider,
          query,
          controller.signal,
        );
        if (current) {
          setSuggestions(results);
          setSuggestionStatus(
            results.length ? "" : "No suggestions. You can still search.",
          );
        }
      } catch (failure) {
        if (
          failure instanceof SuggestionRequestError &&
          failure.status === 429
        ) {
          limitedUntil.current[provider] = Date.now() + failure.retryAfterMs;
          if (current)
            setSuggestionStatus(
              `${suggestionProvider(provider).name} suggestions are temporarily limited. You can still search.`,
            );
        } else if (current)
          setSuggestionStatus("Suggestions unavailable. You can still search.");
      } finally {
        clearTimeout(timeout);
      }
    }, 280);
    return () => {
      current = false;
      clearTimeout(debounce);
      clearTimeout(timeout);
      controller.abort();
      if (request.current === controller) request.current = null;
    };
  }, [query, provider, suggestionsEnabled, focused, menuOpen]);

  const submit = async (text = query) => {
    if (searching || !text.trim()) return;
    request.current?.abort();
    setFocused(false);
    setSuggestions([]);
    setError("");
    setSearching(true);
    try {
      if (provider === "default") await searchWithDefaultProvider(text);
      else window.location.assign(selectedSearchUrl(provider, text));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Search could not start. Try again.",
      );
    } finally {
      setSearching(false);
    }
  };

  const choose = async (next: SearchProvider) => {
    if (choosing) return;
    request.current?.abort();
    setSuggestions([]);
    setError("");
    if (next === "default") {
      change({ searchProvider: next, searchSuggestionsEnabled: false });
      setMenuOpen(false);
      input.current?.focus();
      return;
    }
    setChoosing(true);
    let allowed = false;
    try {
      allowed = await requestSuggestionAccess(next);
    } catch {
      /* Search remains available without suggestion access. */
    }
    change({ searchProvider: next, searchSuggestionsEnabled: allowed });
    setChoosing(false);
    setMenuOpen(false);
    input.current?.focus();
    if (!allowed)
      setError(
        "Suggestions were not enabled. You can still search with the selected engine.",
      );
  };

  const toggleSuggestions = async () => {
    if (choosing || provider === "default") return;
    request.current?.abort();
    setSuggestions([]);
    setError("");
    if (suggestionsEnabled) {
      change({ searchSuggestionsEnabled: false });
      return;
    }
    setChoosing(true);
    try {
      const allowed = await requestSuggestionAccess(provider);
      change({ searchSuggestionsEnabled: allowed });
      if (!allowed) setError("Suggestion access was not granted.");
    } catch {
      setError("Suggestion access is unavailable in this browser.");
    } finally {
      setChoosing(false);
    }
  };

  const menuKeys = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      trigger.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [
      ...menu.current!.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]:not(:disabled)',
      ),
    ];
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) %
            buttons.length
    ].focus();
  };
  const showSuggestions = focused && !menuOpen && suggestions.length > 0;

  return (
    <div
      className="search-box"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocused(false);
          if (event.relatedTarget) setMenuOpen(false);
        }
      }}
    >
      <form
        className="home-search"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Search size={18} aria-hidden="true" />
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label="Search the web"
          placeholder="Search"
          autoComplete="off"
          required
          value={query}
          maxLength={500}
          aria-expanded={showSuggestions}
          aria-autocomplete="list"
          aria-controls={showSuggestions ? listId : undefined}
          aria-activedescendant={
            showSuggestions && activeIndex >= 0
              ? `${listId}-${activeIndex}`
              : undefined
          }
          onFocus={() => {
            setFocused(true);
            setMenuOpen(false);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setSuggestions([]);
            setFocused(true);
            setActiveIndex(-1);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              setFocused(false);
              setActiveIndex(-1);
              return;
            }
            if (
              showSuggestions &&
              ["ArrowDown", "ArrowUp"].includes(event.key)
            ) {
              event.preventDefault();
              setActiveIndex(
                (index) =>
                  (index +
                    (event.key === "ArrowUp" ? (index < 0 ? 0 : -1) : 1) +
                    suggestions.length) %
                  suggestions.length,
              );
            } else if (
              showSuggestions &&
              event.key === "Enter" &&
              activeIndex >= 0
            ) {
              event.preventDefault();
              void submit(suggestions[activeIndex]);
            }
          }}
        />
        <button
          className="search-provider-trigger"
          ref={trigger}
          type="button"
          aria-label={`Search engine: ${providerName}`}
          title={`Search engine: ${providerName}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <ProviderMark provider={provider} />
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <button
          type="submit"
          aria-label="Submit web search"
          disabled={searching || !query.trim()}
        >
          <ArrowUpRight size={18} />
        </button>
      </form>
      {menuOpen && (
        <div
          ref={menu}
          className="search-provider-popover"
          onKeyDown={menuKeys}
        >
          <p className="search-provider-heading" id={`${menuId}-heading`}>
            Search engine
          </p>
          <p className="search-provider-disclosure">
            Choosing an engine enables suggestions and sends what you type to
            it.
          </p>
          <div id={menuId} role="menu" aria-labelledby={`${menuId}-heading`}>
            {(
              [
                { id: "default", name: "Browser default" },
                ...SUGGESTION_PROVIDERS,
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                role="menuitemradio"
                aria-checked={provider === option.id}
                disabled={choosing}
                onClick={() => void choose(option.id)}
              >
                <ProviderMark provider={option.id} />
                <span>{option.name}</span>
                {provider === option.id && (
                  <Check size={17} aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          <label className="search-provider-toggle">
            <input
              type="checkbox"
              checked={suggestionsEnabled && provider !== "default"}
              disabled={choosing || provider === "default"}
              onChange={() => void toggleSuggestions()}
            />
            <span>Search suggestions</span>
          </label>
          <p className="search-provider-note">
            {provider === "default"
              ? "Uses your browser settings. Choose an engine for suggestions."
              : "This engine applies to this tab. New tabs and reloads use your browser settings."}
          </p>
          <a
            className="search-provider-privacy"
            href="./search-privacy.txt"
            target="_blank"
            rel="noopener noreferrer"
          >
            Search privacy
          </a>
        </div>
      )}
      {showSuggestions && (
        <ul
          className="search-suggestions"
          id={listId}
          role="listbox"
          aria-label={`${providerName} suggestions`}
        >
          {suggestions.map((text, index) => (
            <li key={text} role="presentation">
              <button
                type="button"
                role="option"
                id={`${listId}-${index}`}
                aria-selected={index === activeIndex}
                tabIndex={-1}
                onPointerDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => void submit(text)}
              >
                <Search size={15} aria-hidden="true" />
                <span dir="auto">{text}</span>
                <ArrowUpRight size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {focused && !menuOpen && suggestionStatus && (
        <p className="search-suggestion-status" role="status">
          {suggestionStatus}
        </p>
      )}
      {error && (
        <p role="alert" className="setting-error">
          {error}
        </p>
      )}
    </div>
  );
}
