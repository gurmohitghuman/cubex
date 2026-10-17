// The derived kinds by their auto-run kind (derived-kind.ts).
import { cleanKind } from './clean-kind';
import { formulaKind } from './formula-kind';
import { lookupKind } from './lookup-kind';
import type { DerivedKind } from './derived-kind';

export const DERIVED_KINDS: DerivedKind[] = [cleanKind, formulaKind, lookupKind];

export const derivedKindOf = (id: string): DerivedKind | null => DERIVED_KINDS.find(k => k.id === id) ?? null;
