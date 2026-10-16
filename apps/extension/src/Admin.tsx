import { Modal } from "./Modal";
import { useEffect, useState } from "react";
import { CheckCircle2, Download, LockKeyhole, Upload, X } from "lucide-react";
import {
  validatePdb,
  PROTOCOLS,
  protocolDefinition,
  type Protocol,
  type Job,
} from "@rosettatab/shared";
import { api } from "./api";
import { readPreferences } from "./storage";
import { importProteinFile, type ImportedBenchmark } from "./benchmark";
import { ProteinImportSummary } from "./ProteinImportSummary";
export function Admin({ close }: { close: () => void }) {
  const [token, setToken] = useState(""),
    [jobs, setJobs] = useState<Job[]>([]),
    [pdb, setPdb] = useState(""),
    [title, setTitle] = useState("Trp-cage relaxation"),
    [protocol, setProtocol] = useState<Protocol>("relax"),
    [models, setModels] = useState(3),
    [seed, setSeed] = useState(17),
    [message, setMessage] = useState(""),
    [cap, setCap] = useState<any>(),
    [busy, setBusy] = useState(false);
  const [imported, setImported] = useState<ImportedBenchmark>();
  useEffect(() => {
    void api("/v1/capabilities")
      .then(setCap)
      .catch((e) => setMessage(e.message));
  }, []);
  const load = async () => {
    try {
      setJobs(await api<Job[]>("/v1/jobs", undefined, token));
      setMessage("Connected to the private queue.");
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      validatePdb(pdb);
      await api("/v1/jobs", { title, pdb, protocol, models, seed }, token);
      await load();
      setMessage(
        "Submitted. Tasks wait until a verified engine and native validator are available.",
      );
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async (id: string) => {
    try {
      const response = await fetch(
        readPreferences().apiUrl + `/v1/tasks/${id}/result`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!response.ok) throw new Error("Result download failed.");
      const url = URL.createObjectURL(await response.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = id + ".pdb";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  return (
    <Modal close={close} confirm={close} label="Research task queue">
      <section
        className="admin-panel"

        aria-label="Research task queue"
      >
        <button
          className="modal-close"
          onClick={close}
          aria-label="Close research console"
        >
          <X size={20} />
        </button>
        <p className="eyebrow">RESEARCH CONSOLE</p>
        <h2>Give idle time a purpose.</h2>
        <p className="quiet-copy">
          Submit small protein structures to your private RoTab queue. Browser
          results are credited only after native scientific validation.
        </p>
        <div
          className={"capability " + (cap?.scientificValidation ? "good" : "")}
        >
          <CheckCircle2 size={16} />
          {cap?.reason ?? "Checking native validation…"}
        </div>
        <div className="admin-auth">
          <label>
            <LockKeyhole size={14} /> Admin token
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="From .local/config.json"
              autoComplete="off"
            />
          </label>
          <button className="secondary" onClick={load}>
            Connect
          </button>
        </div>
        <form onSubmit={submit}>
          <label>
            Campaign name
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
            />
          </label>
          <div className="form-row">
            <label>
              Protocol
              <select
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as Protocol)}
              >
                {PROTOCOLS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Models
              <input
                type="number"
                min="1"
                max="20"
                value={models}
                onChange={(e) => setModels(Number(e.target.value))}
              />
            </label>
            <label>
              Seed
              <input
                type="number"
                min="1"
                max="2000000000"
                value={seed}
                onChange={(e) => setSeed(Number(e.target.value))}
              />
            </label>
          </div>
          <p className="quiet-copy">
            {protocolDefinition(protocol).description}{" "}
            {protocolDefinition(protocol).changesSequence &&
              "This protocol can change the amino-acid sequence."}{" "}
            All displayed energies use REF2015; the packaged engine must verify
            this protocol before running it.
          </p>
          <div className="upload-structure">
            <label className="secondary upload-button">
              <Upload size={15} /> Upload PDB
              <input
                type="file"
                accept=".pdb,.ent,.pdb.gz,.ent.gz"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    try {
                      const input = await importProteinFile(file);
                      setImported(input);
                      setPdb(input.task.pdb);
                      setMessage("");
                    } catch (error) {
                      setMessage(
                        error instanceof Error ? error.message : String(error),
                      );
                    }
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                void fetch("./fixtures/1l2y.pdb")
                  .then((r) => r.text())
                  .then(setPdb)
              }
            >
              Use 1L2Y reference
            </button>
          </div>
          <textarea
            aria-label="Protein structure PDB"
            placeholder="One protein chain · standard amino acids · PDB coordinates"
            value={pdb}
            onChange={(e) => {
              setPdb(e.target.value);
              setImported(undefined);
            }}
          />
          {imported && <ProteinImportSummary input={imported} />}
          <button className="primary" disabled={busy || !token || !pdb}>
            Submit calculation
          </button>
        </form>
        {message && (
          <p className="form-message" role="status">
            {message}
          </p>
        )}
        <h3>
          Campaigns{" "}
          <button className="text-button" onClick={load}>
            Refresh
          </button>
        </h3>
        <div className="campaigns">
          {jobs.length === 0 ? (
            <p className="quiet-copy">Your queue starts here.</p>
          ) : (
            jobs.map((job) => (
              <article key={job.id}>
                <b>{job.title}</b>
                <small>{new Date(job.createdAt).toLocaleString()}</small>
                {job.tasks.map((task) => (
                  <div key={task.id}>
                    <span>
                      Model {task.modelIndex + 1} · {task.protocol}
                    </span>
                    <span className={"task-state " + task.state}>
                      {task.state}
                    </span>
                    {task.result && (
                      <button
                        aria-label="Download accepted protein"
                        onClick={() => void download(task.id)}
                      >
                        <Download size={14} />
                      </button>
                    )}
                    {task.rejection && <small>{task.rejection}</small>}
                  </div>
                ))}
              </article>
            ))
          )}
        </div>
      </section>
    </Modal>
  );
}
