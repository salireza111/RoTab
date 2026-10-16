import { Model } from "molstar/lib/mol-model/structure/model/model";
import { Bond, StructureElement, Unit } from "molstar/lib/mol-model/structure";
import type { Location } from "molstar/lib/mol-model/location";
import { ColorTheme } from "molstar/lib/mol-theme/color";
import type { ThemeDataContext } from "molstar/lib/mol-theme/theme";
import { Color } from "molstar/lib/mol-util/color";
import { ParamDefinition as PD } from "molstar/lib/mol-util/param-definition";
import { ProteinColorData, residueColor, residueKey } from "./protein-colors";

// DisplayCoordinates creates new models as positions interpolate. Keep their
// snapshot scores outside the scientific model, with no change to atom data.
const modelColors = new WeakMap<Model, ProteinColorData>();
export function setModelColors(model: Model, data: ProteinColorData) {
  modelColors.set(model, data);
}

export function locationResidueKey(location: Location) {
  let unit: Unit, element: number;
  if (StructureElement.Location.is(location)) {
    unit = location.unit;
    element = location.element;
  } else if (Bond.isLocation(location)) {
    unit = location.aUnit;
    element = unit.elements[location.aIndex];
  } else return undefined;
  if (!Unit.isAtomic(unit)) return undefined;
  const hierarchy = unit.model.atomicHierarchy;
  const residue = hierarchy.residueAtomSegments.index[element];
  const chain = hierarchy.chainAtomSegments.index[element];
  return residueKey(
    hierarchy.chains.auth_asym_id.value(chain),
    hierarchy.residues.auth_seq_id.value(residue),
    hierarchy.residues.pdbx_PDB_ins_code.value(residue),
  );
}

const Params = {
  mode: PD.Select<"sequence" | "energy">("sequence", [
    ["sequence", "Sequence position"],
    ["energy", "Rosetta residue energy"],
  ]),
};
function RosettaColorTheme(
  ctx: ThemeDataContext,
  props: PD.Values<typeof Params>,
): ColorTheme<typeof Params> {
  const data = ctx.structure?.model && modelColors.get(ctx.structure.model);
  const colors = new Map(
    data?.residues.map((residue) => [
      residue.key,
      Color(residueColor(residue, props.mode)),
    ]),
  );
  return {
    factory: RosettaColorTheme,
    props,
    granularity: "group",
    preferSmoothing: true,
    contextHash: data?.signature ?? 0,
    color: (location) =>
      colors.get(locationResidueKey(location) ?? "") ?? Color(0x738296),
    description:
      props.mode === "sequence"
        ? "Observed chain position from N-terminus (mint) to C-terminus (gold)."
        : "Weighted Rosetta residue totals, with a fixed −10 to +10 REU color domain. Missing scores are gray.",
  };
}
export const RosettaColorThemeProvider: ColorTheme.Provider<typeof Params> = {
  name: "rosettatab-residue",
  label: "RoTab residue colors",
  category: ColorTheme.Category.Residue,
  factory: RosettaColorTheme,
  getParams: () => Params,
  defaultValues: PD.getDefaultValues(Params),
  isApplicable: (ctx) => !!ctx.structure,
};
