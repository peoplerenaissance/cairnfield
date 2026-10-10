// Hashes come from Web Crypto, which Workers and Node both provide. So every hash is async.

function hex(digest: ArrayBuffer): string {
  let out = "";
  for (const byte of new Uint8Array(digest)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

// Joins a header and content in a buffer of its own. Web Crypto wants bytes backed by an
// ArrayBuffer, and the Git hash needs the header in front of the content.
function framed(header: Uint8Array, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(header.length + content.length);
  bytes.set(header);
  bytes.set(content, header.length);
  return bytes;
}

const NO_HEADER = new Uint8Array(0);

export async function sha256Hex(content: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", framed(NO_HEADER, content)));
}

/**
 * The hash Git gives an object: SHA-1 over the object's type, its length, a zero byte and
 * its bytes. SHA-1 is Git's object hash and the only form the binding reads (KTD6), so it
 * is not a choice made here. It names content. It is never used for a secret or a password.
 */
async function gitObjectHash(type: "blob" | "tree", content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${content.length}\0`);
  return hex(await crypto.subtle.digest("SHA-1", framed(header, content)));
}

/** The hash Git gives a file: the object hash of its bytes as a blob. */
export function gitBlobHash(content: Uint8Array): Promise<string> {
  return gitObjectHash("blob", content);
}

/** The mode Git writes for a folder in a tree. */
export const TREE_MODE = "40000";

/** One entry of a folder: its name there, its Git mode and the hash of its blob or tree. */
export interface FolderEntry {
  /** A name is bytes, because a file system may hold any. */
  readonly name: Uint8Array;
  /** As Git writes it in a tree: `100644`, `100755`, `120000`, or `TREE_MODE` for a folder. */
  readonly mode: string;
  readonly hash: string;
}

const SLASH = 0x2f;

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
  const parts = [...entries].sort(inTreeOrder).map(({ name, mode, hash }) => {
    const head = new TextEncoder().encode(`${mode} `);
    const part = new Uint8Array(head.length + name.length + 21);
    part.set(head);
    part.set(name, head.length);
    for (let at = 0; at < 20; at++) part[head.length + name.length + 1 + at] = Number.parseInt(hash.slice(at * 2, at * 2 + 2), 16);
    return part;
  });
  const tree = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    tree.set(part, at);
    at += part.length;
  }
  return gitObjectHash("tree", tree);
}
