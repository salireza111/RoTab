import { useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import {
  ProviderSearchBox,
  type ProviderSearchBoxProps,
} from "./ProviderSearchBox";
import { searchWithDefaultProvider } from "./browser-search";
export { searchWithDefaultProvider } from "./browser-search";

export function SearchBox(props: ProviderSearchBoxProps) {
  return import.meta.env.ROTAB_SEARCH_PROVIDER_PICKER ? (
    <ProviderSearchBox {...props} />
  ) : (
    <DefaultSearchBox />
  );
}

function DefaultSearchBox() {
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const submit = async () => {
    if (searching || !query.trim()) return;
    setError("");
    setSearching(true);
    try {
      await searchWithDefaultProvider(query);
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
  return (
    <div className="search-box">
      <form
        className="home-search"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Search size={18} />
        <input
          type="search"
          aria-label="Search the web"
          placeholder="Search"
          autoComplete="off"
          required
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setError("");
          }}
        />
        <button
          aria-label="Submit web search"
          disabled={searching || !query.trim()}
        >
          <ArrowUpRight size={18} />
        </button>
      </form>
      {error && (
        <p role="alert" className="setting-error">
          {error}
        </p>
      )}
    </div>
  );
}
