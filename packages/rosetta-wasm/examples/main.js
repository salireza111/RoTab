import { createRosetta, preparePdb } from "../sdk/index.js";
const $ = (id) => document.getElementById(id);
const rosetta = createRosetta({
  engineUrl: new URL("../engine/", import.meta.url),
});
let controller,
  urls = [];
$("run").onclick = async () => {
  $("run").disabled = true;
  $("abort").disabled = false;
  for (const url of urls) URL.revokeObjectURL(url);
  urls = [];
  $("downloads").replaceChildren();
  $("details").textContent = "";
  $("line").setAttribute("points", "");
  controller = new AbortController();
  const energies = [];
  try {
    const original = $("file").files[0]
      ? await $("file").files[0].text()
      : await (await fetch("./input.pdb")).text();
    const prepared = preparePdb(original);
    const result = await rosetta.run($("protocol").value, prepared.pdb, {
      seed: Number($("seed").value),
      dutyCycle: Number($("duty").value),
      signal: controller.signal,
      onPhase: (phase) => {
        $("status").textContent = phase.replaceAll("-", " ");
      },
      onSnapshot: (frame) => {
        energies.push(frame.energy);
        $("energy").textContent =
          `Energy ${frame.energy.toFixed(4)} REU · ${frame.source} · snapshot ${frame.sequence}`;
        const low = Math.min(...energies),
          high = Math.max(...energies),
          range = high - low || 1;
        $("line").setAttribute(
          "points",
          energies
            .map(
              (e, i) =>
                `${10 + (i / Math.max(1, energies.length - 1)) * 880},${170 - ((e - low) / range) * 160}`,
            )
            .join(" "),
        );
        // A molecular viewer can render frame.pdb here; the SDK imposes no viewer dependency.
      },
    });
    $("status").textContent =
      "Complete · results stay in this browser until downloaded.";
    $("details").textContent = JSON.stringify(
      { ...result, pdb: "[download below]" },
      null,
      2,
    );
    for (const [name, text, mime] of [
      ["result.pdb", result.pdb, "chemical/x-pdb"],
      [
        "record.json",
        JSON.stringify(
          { originalPdb: original, preparation: prepared, result },
          null,
          2,
        ),
        "application/json",
      ],
    ]) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: mime }));
      urls.push(a.href);
      a.download = name;
      a.textContent = `Download ${name}`;
      $("downloads").append(a);
    }
  } catch (error) {
    $("status").textContent = error.message;
  } finally {
    $("run").disabled = false;
    $("abort").disabled = true;
    controller = undefined;
  }
};
$("abort").onclick = () => controller?.abort();
addEventListener("pagehide", () => rosetta.close(), { once: true });
