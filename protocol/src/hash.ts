// Hashes come from Web Crypto, which Workers and Node both provide. So every hash is async.

import { TREE_MODE } from "./enums.ts";
import type { FileMode, LINK_MODE } from "./enums.ts";

function hex(digest: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(digest)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

// The bytes a hash in hexadecimal stands for.
function unhex(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length / 2);
  for (let at = 0; at < bytes.length; at++) bytes[at] = Number.parseInt(text.slice(at * 2, at * 2 + 2), 16);
  return bytes;
}

// Joins parts in a buffer of its own. Web Crypto wants bytes backed by an ArrayBuffer,
// and a Git hash needs a header in front of the content.
function joined(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

export async function sha256Hex(content: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", joined([content])));
}

/**
 * The hash Git gives an object: SHA-1 over the object's type, its length, a zero byte and
 * its bytes. SHA-1 is Git's object hash and the only form the binding reads (KTD6), so it
 * is not a choice made here. It names content. It is never used for a secret or a password.
 */
async function gitObjectHash(type: "blob" | "tree", content: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", joined([text(`${type} ${content.length}\0`), content])));
}

/** The hash Git gives a file: the object hash of its bytes as a blob. */
export function gitBlobHash(content: Uint8Array): Promise<string> {
  return gitObjectHash("blob", content);
}

/** One entry of a folder: its name there, its Git mode and the hash of its blob or tree. */
export interface FolderEntry {
  /** A name is bytes, because a file system may hold any. */
  readonly name: Uint8Array;
  readonly mode: FileMode | typeof LINK_MODE | typeof TREE_MODE;
  readonly hash: string;
}

const SLASH = 0x2f;
const ZERO = new Uint8Array(1);

// Git orders the entries of a tree by the bytes of their names, and reads a folder's
// name as if a slash ended it.
function inTreeOrder(a: FolderEntry, b: FolderEntry): number {
  const length = Math.min(a.name.length, b.name.length);
  for (let at = 0; at < length; at++) {
    const difference = (a.name[at] ?? 0) - (b.name[at] ?? 0);
    if (difference !== 0) return difference;
  }
  const after = (entry: FolderEntry): number => entry.name[length] ?? (entry.mode === TREE_MODE ? SLASH : 0);
  return after(a) - after(b);
}

/**
 * The hash Git gives a folder with these entries (R36). A tree holds, for each entry in
 * Git's order, the mode, a space, the name, a zero byte and the 20 bytes of the hash.
 * The entries may come in any order.
 */
export function gitTreeHash(entries: readonly FolderEntry[]): Promise<string> {
  const ordered = [...entries].sort(inTreeOrder);
  return gitObjectHash("tree", joined(ordered.flatMap(({ name, mode, hash }) => [text(`${mode} `), name, ZERO, unhex(hash)])));
}
