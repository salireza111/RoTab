import {
  preparationMessages,
  proteinOnlyCaution,
  validatePdb,
} from "@rosettatab/shared";
import type { ImportedBenchmark } from "./benchmark";

export function ProteinImportSummary({ input }: { input: ImportedBenchmark }) {
  const stats = validatePdb(input.task.pdb);
  const preparation = input.metadata.preparation;
  const download = (pdb: string, suffix: string) => {
    const url = URL.createObjectURL(
      new Blob([pdb], { type: "chemical/x-pdb" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${input.task.title.replace(/\.(pdb|ent|json)$/i, "")}-${suffix}.pdb`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  if (!preparation)
    return (
      <p className="protein-import-summary" role="status">
        {stats.residues.toLocaleString()} residues ·{" "}
        {stats.atoms.toLocaleString()} atoms
      </p>
    );
  const caution = proteinOnlyCaution(preparation);
  return (
    <div className="protein-import-summary">
      {caution && (
        <p className="protein-import-caution" role="status">
          {caution}
        </p>
      )}
      <details>
        <summary>
          {stats.residues.toLocaleString()} residues · Prepared for calculation
        </summary>
        <ul>
          {preparationMessages(preparation).map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
        {input.metadata.reference && (
          <p>
            The original reference is retained; it is not an exact-input
            comparison for this prepared target.
          </p>
        )}
        <div className="protein-import-downloads">
          <button
            type="button"
            className="secondary"
            onClick={() => download(input.task.pdb, "prepared")}
          >
            Prepared PDB
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => download(input.metadata.pdb, "original")}
          >
            Original PDB
          </button>
        </div>
      </details>
    </div>
  );
}
