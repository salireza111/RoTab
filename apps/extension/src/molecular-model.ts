import {
  PluginStateObject as SO,
  PluginStateTransform,
} from "molstar/lib/mol-plugin-state/objects";
import { Model } from "molstar/lib/mol-model/structure/model/model";
import { Coordinates, Time } from "molstar/lib/mol-model/structure/coordinates";
import { ParamDefinition as PD } from "molstar/lib/mol-util/param-definition";
import { ProteinColorData } from "./protein-colors";
import { setModelColors } from "./molecular-colors";

// Keep topology, selection, representations and camera intact while updating
// coordinates through Mol*'s normal model -> structure -> geometry pipeline.
export const DisplayCoordinates = PluginStateTransform.BuiltIn({
  name: "rosettatab-display-coordinates",
  display: { name: "Interpolated Rosetta snapshot" },
  from: SO.Molecule.Model,
  to: SO.Molecule.Model,
  params: {
    positions: PD.Value<Float32Array>(new Float32Array(), { isHidden: true }),
    coloring: PD.Value<ProteinColorData>(
      { residues: [], scoredCount: 0, signature: 0 },
      { isHidden: true },
    ),
  },
})({
  apply({ a, params }) {
    const { positions } = params;
    const count = positions.length / 3;
    const x = new Float32Array(count),
      y = new Float32Array(count),
      z = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      x[i] = positions[i * 3];
      y[i] = positions[i * 3 + 1];
      z[i] = positions[i * 3 + 2];
    }
    const coordinates = Coordinates.create(
      [
        {
          elementCount: count,
          x,
          y,
          z,
          time: Time(0, "step"),
          xyzOrdering: { isIdentity: true },
        },
      ],
      Time(1, "step"),
      Time(0, "step"),
    );
    const model = Model.trajectoryFromModelAndCoordinates(
      a.data,
      coordinates,
    ).representative;
    setModelColors(model, params.coloring);
    return new SO.Molecule.Model(model, {
      label: "Rosetta snapshot · display coordinates",
    });
  },
});
