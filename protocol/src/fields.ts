// Field kinds. One descriptor per field drives validation, the TypeScript types,
// the JSON Schema files and the OpenAPI description, so none of them can drift (KTD35).
//
// There are two sets. Record kinds mirror R2: a record field is an enumerated value,
// a hash, a number, a path or a hostname. No record kind holds free text.
// Contract kinds add what an HTTP body needs and a record must never hold.
// A contract kind in a record shape is a type error.

import type { SCHEMA_VERSION } from "./enums.ts";

// Record kinds (R2).

export interface VersionKind {
  readonly kind: "version";
}
export interface EnumKind<V extends string = string> {
  readonly kind: "enum";
  readonly values: readonly V[];
}
/** A record ID or a patch ID. */
export interface Sha256Kind {
  readonly kind: "sha256";
}
/** A commit, a tree or a blob. */
export interface GitHashKind {
  readonly kind: "git-hash";
}
export interface IntKind {
  readonly kind: "int";
  readonly min: number;
  readonly max: number;
}
/** A path in the pinned copy. */
export interface PathKind {
  readonly kind: "path";
}
export interface HostnameKind {
  readonly kind: "hostname";
}

export type SetItemKind = EnumKind | Sha256Kind | GitHashKind | PathKind | HostnameKind;

/** A bounded array that is a set: sorted ascending with no duplicate. The same members then give the same record. */
export interface SetKind<I extends SetItemKind = SetItemKind> {
  readonly kind: "set";
  readonly items: I;
  readonly min: number;
  readonly max: number;
}

/**
 * A rule across the fields of one object.
 * `present-when`: the field is required when the `on` field holds one of the values, and refused otherwise.
 * `one-of-when`: the field holds one of the `values` when the `on` field holds one of the `in` values.
 * `ordered`: the `low` field is not greater than the `high` field. Used for line ranges.
 */
export type Rule<N extends string = string> =
  | { readonly rule: "present-when"; readonly field: N; readonly on: N; readonly in: readonly string[] }
  | {
      readonly rule: "one-of-when";
      readonly field: N;
      readonly values: readonly string[];
      readonly on: N;
      readonly in: readonly string[];
    }
  | { readonly rule: "ordered"; readonly low: N; readonly high: N };

export interface ObjectKind<F extends RecordFields = RecordFields> {
  readonly kind: "object";
  readonly fields: F;
  readonly rules: readonly Rule[];
}

export type RecordKind =
  | VersionKind
  | EnumKind
  | Sha256Kind
  | GitHashKind
  | IntKind
  | PathKind
  | HostnameKind
  | SetKind
  | ObjectKind;

export type RecordField = RecordKind & { readonly optional?: true };
export interface RecordFields {
  readonly [name: string]: RecordField;
}

// Contract kinds. For request and response bodies only.

/** An HTTPS URL with no credentials. */
export interface UrlKind {
  readonly kind: "url";
}
/** A node's base URL in its one accepted spelling, which is the node's identity (KTD8). */
export interface NodeUrlKind {
  readonly kind: "node-url";
}
/** An opaque token. Never logged and never stored in a record. */
export interface TokenKind {
  readonly kind: "token";
}
/** Text for display to a person, such as a cited line (R31). Never given to an agent. */
export interface TextKind {
  readonly kind: "text";
  readonly max: number;
}
export interface BooleanKind {
  readonly kind: "boolean";
}
/** A repo, namespace or branch name under the rules of KTD6. */
export interface NameKind {
  readonly kind: "name";
  readonly of: "repo" | "namespace" | "branch";
}
/** A record's path in a team repo (KTD1). */
export interface RecordPathKind {
  readonly kind: "record-path";
}
/** A whole record of one type, checked as a record. */
export interface EmbeddedRecordKind<S extends ObjectKind = ObjectKind> {
  readonly kind: "record";
  readonly shape: S;
}
export interface ListKind<I extends ContractKind = ContractKind> {
  readonly kind: "list";
  readonly items: I;
  readonly max: number;
}
export interface ShapeKind<F extends ContractFields = ContractFields> {
  readonly kind: "object";
  readonly fields: F;
  readonly rules: readonly Rule[];
}

export type ContractOnlyKind =
  | UrlKind
  | NodeUrlKind
  | TokenKind
  | TextKind
  | BooleanKind
  | NameKind
  | RecordPathKind
  | EmbeddedRecordKind
  | ListKind;

export type ContractKind = RecordKind | ContractOnlyKind | ShapeKind;
export type ContractField = ContractKind & { readonly optional?: true };
export interface ContractFields {
  readonly [name: string]: ContractField;
}

// Builders.

export const version = (): VersionKind => ({ kind: "version" });
export const sha256 = (): Sha256Kind => ({ kind: "sha256" });
export const gitHash = (): GitHashKind => ({ kind: "git-hash" });
export const path = (): PathKind => ({ kind: "path" });
export const hostname = (): HostnameKind => ({ kind: "hostname" });
export const int = (min: number, max: number): IntKind => ({ kind: "int", min, max });

export function oneOf<const V extends readonly string[]>(values: V): EnumKind<V[number]> {
  return { kind: "enum", values };
}

export function setOf<I extends SetItemKind>(items: I, min: number, max: number): SetKind<I> {
  return { kind: "set", items, min, max };
}

/** A fixed object of record kinds. */
export function object<const F extends RecordFields>(
  fields: F,
  rules: readonly Rule<keyof F & string>[] = [],
): ObjectKind<F> {
  return { kind: "object", fields, rules };
}

export function optional<K extends ContractKind>(kind: K): K & { readonly optional: true } {
  return { ...kind, optional: true };
}

export const url = (): UrlKind => ({ kind: "url" });
export const nodeUrl = (): NodeUrlKind => ({ kind: "node-url" });
export const token = (): TokenKind => ({ kind: "token" });
export const text = (max: number): TextKind => ({ kind: "text", max });
export const boolean = (): BooleanKind => ({ kind: "boolean" });
export const name = (of: NameKind["of"]): NameKind => ({ kind: "name", of });
export const recordFile = (): RecordPathKind => ({ kind: "record-path" });

export function embedded<S extends ObjectKind>(shape: S): EmbeddedRecordKind<S> {
  return { kind: "record", shape };
}

export function listOf<I extends ContractKind>(items: I, max: number): ListKind<I> {
  return { kind: "list", items, max };
}

/** A fixed object for a request or response body. */
export function shape<const F extends ContractFields>(
  fields: F,
  rules: readonly Rule<keyof F & string>[] = [],
): ShapeKind<F> {
  return { kind: "object", fields, rules };
}

// The TypeScript type of a value that a kind accepts.

type OptionalNames<F> = { [N in keyof F]: F[N] extends { readonly optional: true } ? N : never }[keyof F];

export type InferFields<F> = {
  -readonly [N in Exclude<keyof F, OptionalNames<F>>]: Infer<F[N]>;
} & {
  -readonly [N in OptionalNames<F>]?: Infer<F[N]>;
} extends infer O
  ? { [N in keyof O]: O[N] }
  : never;

export type Infer<K> = K extends { readonly kind: "enum"; readonly values: readonly (infer V)[] }
  ? V
  : K extends { readonly kind: "version" }
    ? typeof SCHEMA_VERSION
    : K extends { readonly kind: "int" }
      ? number
      : K extends { readonly kind: "boolean" }
        ? boolean
        : K extends { readonly kind: "set" | "list"; readonly items: infer I }
          ? Infer<I>[]
          : K extends { readonly kind: "object"; readonly fields: infer F }
            ? InferFields<F>
            : K extends { readonly kind: "record"; readonly shape: infer S }
              ? Infer<S>
              : string;
