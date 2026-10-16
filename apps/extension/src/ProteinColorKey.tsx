import { useId, useState } from "react";
import { Info, Pin, X } from "lucide-react";
import {
  colorHex,
  ProteinColorData,
  ProteinColorMode,
  ProteinPalette,
  residueColor,
} from "./protein-colors";

export function ProteinColorKey({
  data,
  mode,
  onModeChange,
  hoveredKey,
  selectedKey,
  onSelectResidue,
}: {
  data: ProteinColorData;
  mode: ProteinColorMode;
  onModeChange: (mode: ProteinColorMode) => void;
  hoveredKey?: string;
  selectedKey?: string;
  onSelectResidue?: (key: string | undefined) => void;
}) {
  const [localInspect, setInspect] = useState("auto");
  const inspect = onSelectResidue ? (selectedKey ?? "auto") : localInspect;
  const [help, setHelp] = useState(false);
  const helpId = useId();
  const selected = data.residues.find(
    (r) => r.key === (inspect === "auto" ? hoveredKey : inspect),
  );
  const ticks =
    mode === "sequence"
      ? ["N / start", "25%", "50%", "75%", "C / end"]
      : ["≤ −10", "−5", "0", "+5", "≥ +10"];
  const sequenceMeaning = [
    "N-terminus / start",
    "25% along the chain",
    "middle of the chain",
    "75% along the chain",
    "C-terminus / end",
  ];
  const energyMeaning = [
    "−10 REU or lower",
    "−5 REU",
    "0 REU",
    "+5 REU",
    "+10 REU or higher",
  ];
  return (
    <div className="protein-color-key" data-mode={mode}>
      <div className="color-mode-control">
        <label htmlFor={`${helpId}-mode`}>COLOR</label>
        <select
          id={`${helpId}-mode`}
          aria-label="Protein coloring"
          value={mode}
          onChange={(e) => onModeChange(e.target.value as ProteinColorMode)}
        >
          <option value="sequence">Sequence position</option>
          <option value="energy">Residue energy</option>
        </select>
        <button
          className="color-info-button"
          aria-label="Explain protein colors"
          aria-expanded={help}
          aria-controls={helpId}
          onClick={() => setHelp(!help)}
        >
          <Info size={14} />
        </button>
      </div>
      <div
        className="protein-palette"
        aria-label={
          mode === "sequence"
            ? "Sequence color scale from N-terminus to C-terminus"
            : "Residue energy color scale, fixed from minus 10 to plus 10 Rosetta Energy Units"
        }
      >
        <div
          className="palette-gradient"
          style={{
            background: `linear-gradient(90deg, ${ProteinPalette.map((c) => c.hex).join(", ")})`,
          }}
        />
        <div className="palette-ticks">
          {ProteinPalette.map((color, index) => (
            <span
              key={color.name}
              title={`${color.name}: ${mode === "sequence" ? sequenceMeaning[index] : energyMeaning[index]}`}
            >
              <i style={{ background: color.hex }} />
              {ticks[index]}
            </span>
          ))}
        </div>
      </div>
      <div className="residue-inspector">
        <select
          aria-label="Inspect protein residue"
          value={
            data.residues.some((r) => r.key === inspect) ? inspect : "auto"
          }
          onChange={(e) =>
            onSelectResidue
              ? onSelectResidue(
                  e.target.value === "auto" ? undefined : e.target.value,
                )
              : setInspect(e.target.value)
          }
        >
          <option value="auto">Inspect residue</option>
          {data.residues.map((r) => (
            <option key={r.key} value={r.key}>
              {r.name} {r.chain || "chain"}:{r.number}
              {r.insertion}
            </option>
          ))}
        </select>
        <output
          className="residue-reading"
          data-pinned={inspect !== "auto"}
          aria-live="off"
          aria-hidden={!selected}
          data-state={selected ? "available" : "empty"}
          data-residue={selected?.key}
          data-energy={selected?.energy}
        >
          {selected && (
            <>
              <i
                style={{ background: colorHex(residueColor(selected, mode)) }}
              />
              <span>
                {selected.name} · {selected.position}/{selected.chainLength}
                <small>
                  {selected.energy === undefined
                    ? "Energy unavailable"
                    : `${selected.energy.toFixed(3)} REU`}
                </small>
              </span>
            </>
          )}
        </output>
        {onSelectResidue && (
          <button
            className="residue-unpin"
            title="Clear residue selection"
            aria-label="Clear residue selection"
            disabled={!selectedKey}
            onClick={() => onSelectResidue(undefined)}
          >
            {selectedKey ? <X size={14} /> : <Pin size={14} />}
          </button>
        )}
      </div>
      {help && (
        <div className="protein-color-help" id={helpId}>
          <p>
            <strong>Sequence position.</strong> Rosetta@home’s rainbow follows
            the order of amino acids, from the N-terminus to the C-terminus.
            Here mint marks the start, blue the first quarter, lavender the
            middle, pink the third quarter, and gold the end. Colors stay with
            their residues as the structure moves. The scale restarts for each
            chain.
          </p>
          <p>
            <strong>Residue energy.</strong> The same palette shows the
            snapshot’s weighted Rosetta residue totals: mint for ≤ −10, blue for
            −5, lavender for 0, pink for +5, and gold for ≥ +10 REU. The scale
            stays fixed across snapshots; inspect a residue for its value beyond
            the color limits. Gray = unavailable residue scores.
          </p>
          <p>
            Residue totals include Rosetta’s allocation of interactions between
            residues; they are contributions to its scoring function. They are
            not temperatures or independent measurements of local stability.
            Some terms, including backbone hydrogen bonds in this build, are
            scored only for the whole structure, so residue totals need not add
            up to the graph’s total. These values come from the snapshot’s
            energy table before PDB coordinate rounding; the graph reports
            whole-structure energy. Compare start overlays a translucent gray
            reference; colors and the inspector describe the active structure.
          </p>
          <p>
            Motion interpolates calculation snapshots; it does not represent a
            physical folding trajectory. Recorded replay plays an earlier run
            and earns no contribution credit.
          </p>
          <a
            href="https://ralph.bakerlab.org/rah/rah_graphics.php"
            target="_blank"
            rel="noreferrer"
          >
            Rosetta’s official graphics guide ↗
          </a>
        </div>
      )}
    </div>
  );
}
