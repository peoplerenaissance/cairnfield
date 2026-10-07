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
 * The hash Git gives a file: SHA-1 over `blob <length>\0` and the file's bytes.
 * SHA-1 is Git's object hash and the only form the binding reads (KTD6), so it is not a
 * choice made here. It names content. It is never used for a secret or a password.
 */
export async function gitBlobHash(content: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  return hex(await crypto.subtle.digest("SHA-1", framed(header, content)));
}
