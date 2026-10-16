import { OrderedSet } from "molstar/lib/mol-data/int";
import { Structure, StructureElement } from "molstar/lib/mol-model/structure";
import type { UnitIndex } from "molstar/lib/mol-model/structure/structure/element/element";
import { locationResidueKey } from "./molecular-colors";

/** Recreate loci against the current coordinate model, retaining residue identity. */
export function residueLoci(structure: Structure, key: string) {
  const location = StructureElement.Location.create(structure);
  const elements: StructureElement.Loci["elements"][number][] = [];
  for (const unit of structure.units) {
    location.unit = unit;
    const indices: UnitIndex[] = [];
    for (let i = 0; i < unit.elements.length; i++) {
      location.element = unit.elements[i];
      if (locationResidueKey(location) === key) indices.push(i as UnitIndex);
    }
    if (indices.length)
      elements.push({ unit, indices: OrderedSet.ofSortedArray(indices) });
  }
  return StructureElement.Loci(structure, elements);
}
